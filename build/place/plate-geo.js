/*
 * Georeferencing for FAA d-TPP approach plates.
 *
 * The FAA embeds a geospatial viewport in the plate PDF: a /VP array holding a
 * /Measure dictionary with the projection as WKT, the geographic corners in
 * /GPTS, and where those corners sit on the page in /LPTS. Everything needed to
 * place the chart on a map is in there.
 *
 * Two things about that structure are easy to get wrong and both are load
 * bearing:
 *
 *   - /LPTS is expressed as a FRACTION OF /BBox, not of the page. On the PDX
 *     ILS 10L the BBox is nearly the whole page but LPTS is 0.1 to 0.9, so the
 *     georeferenced quad is the middle 80% of it. Treating LPTS as page
 *     fractions, or ignoring it and using the BBox, misplaces the overlay by
 *     tens of miles.
 *   - the projection's UNIT is INCHES, not metres. The WKT carries the
 *     conversion and it has to be applied or every coordinate is out by a
 *     factor of about forty.
 *
 * No DOM and no extension APIs, so this runs in a plain script and under node.
 *
 * The FAA's own caveat applies and is worth repeating where anyone maintaining
 * this will see it: the encoding is valid only within the plan view, and the
 * positional data is for situational awareness, not for navigation.
 */
(function (root) {
  'use strict';

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  /* ---- reading the viewport ------------------------------------------- */

  function numsIn(s) {
    var out = [], m, re = /-?\d+(?:\.\d+)?/g;
    while ((m = re.exec(s))) out.push(parseFloat(m[0]));
    return out;
  }

  function wktParam(wkt, name) {
    var m = new RegExp('PARAMETER\\s*\\[\\s*"' + name + '"\\s*,\\s*(-?[\\d.]+)', 'i').exec(wkt);
    return m ? parseFloat(m[1]) : null;
  }

  /**
   * Pull the geospatial viewport out of raw PDF bytes.
   *
   * Deliberately a scan of the raw file rather than a full PDF parse: the d-TPP
   * plates store the page dictionary uncompressed, with no object streams and
   * no cross-reference stream, so the viewport is plain text in the file. If
   * that ever stops being true this returns a reason rather than a guess —
   * a plate placed by guesswork is worse than no plate.
   *
   * @param {Uint8Array|string} bytes
   * @returns {object} { ok: true, ... } or { ok: false, why: string }
   */
  /* The body of "N G obj ... endobj", or null. */
  function findObject(s, num, gen) {
    var re = new RegExp('(?:^|[^0-9])' + num + '\\s+' + gen + '\\s+obj\\b', 'g');
    var m;
    while ((m = re.exec(s)) !== null) {
      var from = m.index + m[0].length;
      var end = s.indexOf('endobj', from);
      if (end < 0) end = Math.min(s.length, from + 8000);
      var body = s.slice(from, end);
      // The right object is the one that actually holds a viewport; a byte
      // sequence elsewhere in the file can match the header pattern.
      if (body.indexOf('/Measure') >= 0 || body.indexOf('/Viewport') >= 0) return body;
    }
    return null;
  }

  function parse(bytes) {
    var s = typeof bytes === 'string' ? bytes : latin1(bytes);

    var vp = s.indexOf('/VP');
    if (vp < 0) return fail('no /VP viewport: this plate is not georeferenced');
    var sub = s.slice(vp, vp + 4000);

    /*
     * The viewport may be an indirect reference rather than an inline array.
     *
     * FAA d-TPP plates write /VP[<</BBox...>>] inline, so reading forward from
     * /VP finds the dictionary. A plate georeferenced by a separate tool is
     * written by a general PDF library, which commonly emits /VP 24 0 R with
     * the object hundreds of kilobytes away. Following the reference is what
     * lets this read a chart that was georeferenced after the FAA published it.
     */
    var ref = /^\/VP\s+(\d+)\s+(\d+)\s+R/.exec(sub);
    if (ref) {
      var obj = findObject(s, ref[1], ref[2]);
      if (obj === null) return fail('the /VP viewport object could not be found');
      sub = obj;
    }

    if (sub.indexOf('/Subtype/GEO') < 0 && sub.indexOf('/Subtype /GEO') < 0) {
      return fail('viewport is not a /GEO measure');
    }

    var wkt = /\/WKT\s*\(([\s\S]*?)\)\s*>>/.exec(sub);
    if (!wkt) return fail('no projection WKT in the viewport');
    // ( ) and \ are escaped inside a PDF literal string
    var wktS = wkt[1].replace(/\\([()\\])/g, '$1');

    var gpts = /\/GPTS\s*\[([^\]]*)\]/.exec(sub);
    var lpts = /\/LPTS\s*\[([^\]]*)\]/.exec(sub);
    var bbox = /\/BBox\s*\[([^\]]*)\]/.exec(sub);
    if (!gpts || !lpts || !bbox) return fail('viewport is missing GPTS, LPTS or BBox');

    var G = numsIn(gpts[1]), L = numsIn(lpts[1]), B = numsIn(bbox[1]);
    if (G.length !== 8 || L.length !== 8 || B.length !== 4) {
      return fail('viewport arrays are not the expected length');
    }

    var mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(s);
    var M = mb ? numsIn(mb[1]) : [0, 0, 612, 792];

    /*
     * Two kinds of chart reach here.
     *
     * FAA d-TPP plates carry a PROJCS: Lambert Conformal Conic, in inches.
     * A chart georeferenced after publication — an airport diagram put through
     * an external tool, say — is written by a general PDF library and commonly
     * carries a plain GEOGCS instead, where the coordinates ARE lon/lat. That
     * needs no projection maths at all, so it is handled as its own mode
     * rather than being forced through the LCC path.
     */
    if (!/Lambert_Conformal_Conic/i.test(wktS)) {
      if (/GEOGCS/i.test(wktS) && !/PROJCS/i.test(wktS)) {
        return geographic(wktS, G, L, B, M);
      }
      return fail('projection is not Lambert Conformal Conic');
    }
    var proj = {
      lat1: wktParam(wktS, 'Standard_Parallel_1'),
      lat2: wktParam(wktS, 'Standard_Parallel_2'),
      lat0: wktParam(wktS, 'Latitude_Of_Origin'),
      lon0: wktParam(wktS, 'Central_Meridian'),
      x0: wktParam(wktS, 'False_Easting') || 0,
      y0: wktParam(wktS, 'False_Northing') || 0
    };
    if (proj.lat1 == null || proj.lat2 == null || proj.lat0 == null || proj.lon0 == null) {
      return fail('projection is missing a standard parallel or origin');
    }
    var sph = /SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(wktS);
    proj.a = sph ? parseFloat(sph[1]) : 6378137.0;
    proj.rf = sph ? parseFloat(sph[2]) : 298.257222101;
    // The last UNIT in the WKT is the PROJECTED one. Inches here, not metres.
    var units = wktS.match(/UNIT\s*\[\s*"([^"]*)"\s*,\s*([\d.]+)/gi) || [];
    var last = units.length ? /UNIT\s*\[\s*"([^"]*)"\s*,\s*([\d.]+)/i.exec(units[units.length - 1]) : null;
    proj.toMetre = last ? parseFloat(last[2]) : 1;
    proj.unitName = last ? last[1] : 'Metre';

    // LPTS is a fraction of BBox, and BBox is in page points.
    var quad = [];
    for (var i = 0; i < 8; i += 2) {
      quad.push([B[0] + L[i] * (B[2] - B[0]), B[1] + L[i + 1] * (B[3] - B[1])]);
    }
    // GPTS is lat,lon pairs in the same corner order as LPTS.
    var geo = [];
    for (var j = 0; j < 8; j += 2) geo.push([G[j + 1], G[j]]);   // -> lon,lat

    return {
      ok: true, wkt: wktS, proj: proj,
      gpts: geo, lpts: L, quadPdf: quad, bbox: B, mediaBox: M,
      proj4: toProj4(proj)
    };
  }

  /*
   * A chart whose coordinate system is geographic: the "projected" plane is
   * lon/lat in degrees. Presented with the same shape as the LCC case so that
   * place(), lcc() and everything downstream need no special case.
   */
  function geographic(wktS, G, L, B, M) {
    var sph = /SPHEROID\s*\[\s*"[^"]*"\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(wktS);
    var proj = {
      geographic: true,
      a: sph ? parseFloat(sph[1]) : 6378137.0,
      rf: sph ? parseFloat(sph[2]) : 298.257222101,
      // Degrees are the unit of this plane. The nominal metres-per-degree at
      // the equator keeps the skew tolerance in plate-render meaningful, which
      // is expressed as a ground distance.
      toMetre: 111319.4907932736,
      unitName: 'Degree'
    };
    var quad = [];
    for (var i = 0; i < 8; i += 2) {
      quad.push([B[0] + L[i] * (B[2] - B[0]), B[1] + L[i + 1] * (B[3] - B[1])]);
    }
    var geo = [];
    for (var j = 0; j < 8; j += 2) geo.push([G[j + 1], G[j]]);
    return { ok: true, wkt: wktS, proj: proj, gpts: geo, lpts: L, quadPdf: quad,
             bbox: B, mediaBox: M, proj4: '+proj=longlat +a=' + proj.a +
             ' +rf=' + proj.rf + ' +no_defs' };
  }

  function fail(why) { return { ok: false, why: why }; }

  function latin1(u8) {
    var out = '', n = u8.length, i = 0;
    while (i < n) {
      out += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, n)));
      i += 8192;
    }
    return out;
  }

  function toProj4(p) {
    return '+proj=lcc +lat_1=' + p.lat1 + ' +lat_2=' + p.lat2 +
           ' +lat_0=' + p.lat0 + ' +lon_0=' + p.lon0 +
           ' +x_0=' + p.x0 + ' +y_0=' + p.y0 +
           ' +a=' + p.a + ' +rf=' + p.rf +
           ' +to_meter=' + p.toMetre + ' +no_defs';
  }

  /* ---- the projection itself ------------------------------------------ */
  /* Snyder, Map Projections - A Working Manual, USGS PP 1395, eqs 14-1..15-4.
     Implemented here rather than pulled from proj4js because tar1090's
     OpenLayers build may not expose proj4 registration, and OpenLayers can
     reproject a raster from any projection given nothing more than a forward
     and inverse transform. One fewer thing that has to be present in someone
     else's page for this to work. */

  function lcc(p) {
    if (p && p.geographic) {
      // The plane is already lon/lat, so both directions are the identity.
      return {
        forward: function (lon, lat) { return [lon, lat]; },
        inverse: function (x, y) { return [x, y]; }
      };
    }
    var a = p.a, f = 1 / p.rf, e = Math.sqrt(2 * f - f * f);
    var l1 = p.lat1 * D2R, l2 = p.lat2 * D2R, l0 = p.lat0 * D2R;

    function m(t) { var s = Math.sin(t); return Math.cos(t) / Math.sqrt(1 - e * e * s * s); }
    function tt(t) {
      var s = Math.sin(t);
      return Math.tan(Math.PI / 4 - t / 2) / Math.pow((1 - e * s) / (1 + e * s), e / 2);
    }

    var m1 = m(l1), m2 = m(l2), t1 = tt(l1), t2 = tt(l2), t0 = tt(l0);
    // Equal parallels degenerate to a tangent cone; the log ratio is 0/0 there.
    var n = Math.abs(l1 - l2) < 1e-10 ? Math.sin(l1)
                                      : Math.log(m1 / m2) / Math.log(t1 / t2);
    var F = m1 / (n * Math.pow(t1, n));
    var rho0 = a * F * Math.pow(t0, n);
    var k = p.toMetre || 1;      // projected units per metre

    return {
      forward: function (lon, lat) {
        var t = tt(lat * D2R), rho = a * F * Math.pow(t, n);
        var th = n * norm180(lon - p.lon0) * D2R;
        return [(p.x0 + rho * Math.sin(th)) / k,
                (p.y0 + rho0 - rho * Math.cos(th)) / k];
      },
      inverse: function (x, y) {
        var X = x * k - p.x0, Y = y * k - p.y0;
        var r0y = rho0 - Y;
        var rho = Math.sqrt(X * X + r0y * r0y) * (n < 0 ? -1 : 1);
        var th = Math.atan2(n < 0 ? -X : X, n < 0 ? -r0y : r0y);
        var t = Math.pow(rho / (a * F), 1 / n);
        var phi = Math.PI / 2 - 2 * Math.atan(t);
        for (var i = 0; i < 12; i++) {            // Snyder 3-4, converges fast
          var s = Math.sin(phi);
          var next = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - e * s) / (1 + e * s), e / 2));
          if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
          phi = next;
        }
        return [p.lon0 + th / n * R2D, phi * R2D];
      }
    };
  }

  function norm180(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }

  /**
   * Where the plan view belongs on a map, and which part of the rendered page
   * it is. Returns the extent in the plate's own projection; hand that to the
   * map with the transforms from lcc() and let it reproject.
   */
  /*
   * How far the georeferenced quad departs from a rectangle.
   *
   * Fitted, not assumed. An earlier version paired corners by index —
   * xs[0] with xs[3], ys[0] with ys[1] — which quietly depended on the order
   * the corners happen to be listed in. Two charts from the same producer list
   * them differently: one read 0.22 m and the other 3163 m, and the second was
   * refused for a fault it did not have.
   *
   * So an affine is fitted from the unit square (LPTS) to the projected
   * corners by least squares, and the largest residual is the answer. An
   * affine reproduces any rectangle exactly however it is rotated, reflected
   * or ordered, so what remains is genuine departure from one.
   */
  function skewOf(lpts, xs, ys) {
    if (!lpts || lpts.length !== 8) return 0;
    var u = [], v = [];
    for (var i = 0; i < 8; i += 2) { u.push(lpts[i]); v.push(lpts[i + 1]); }

    // Normal equations for [1, u, v] -> x and -> y.
    var n = 4, Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0;
    for (i = 0; i < n; i++) { Su += u[i]; Sv += v[i]; Suu += u[i] * u[i]; Svv += v[i] * v[i]; Suv += u[i] * v[i]; }
    var A = [[n, Su, Sv], [Su, Suu, Suv], [Sv, Suv, Svv]];

    function solve(t) {
      var b = [0, 0, 0];
      for (var k = 0; k < n; k++) { b[0] += t[k]; b[1] += u[k] * t[k]; b[2] += v[k] * t[k]; }
      var M = [A[0].slice(), A[1].slice(), A[2].slice()], y = b.slice();
      for (var c = 0; c < 3; c++) {
        var piv = c;
        for (var r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
        if (Math.abs(M[piv][c]) < 1e-12) return null;
        var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
        var ty = y[c]; y[c] = y[piv]; y[piv] = ty;
        for (r = c + 1; r < 3; r++) {
          var f = M[r][c] / M[c][c];
          for (var q = c; q < 3; q++) M[r][q] -= f * M[c][q];
          y[r] -= f * y[c];
        }
      }
      var out = [0, 0, 0];
      for (r = 2; r >= 0; r--) {
        var acc = y[r];
        for (q = r + 1; q < 3; q++) acc -= M[r][q] * out[q];
        out[r] = acc / M[r][r];
      }
      return out;
    }

    var cx = solve(xs), cy = solve(ys);
    if (!cx || !cy) return 0;
    var worst = 0;
    for (i = 0; i < n; i++) {
      var dx = xs[i] - (cx[0] + cx[1] * u[i] + cx[2] * v[i]);
      var dy = ys[i] - (cy[0] + cy[1] * u[i] + cy[2] * v[i]);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > worst) worst = d;
    }
    return worst;
  }

  function place(info) {
    var pr = lcc(info.proj);
    var xs = [], ys = [];
    info.gpts.forEach(function (g) {
      var p = pr.forward(g[0], g[1]);
      xs.push(p[0]); ys.push(p[1]);
    });
    var quad = info.quadPdf;
    var qx = quad.map(function (q) { return q[0]; });
    var qy = quad.map(function (q) { return q[1]; });
    return {
      proj: pr,
      extent: [Math.min.apply(null, xs), Math.min.apply(null, ys),
               Math.max.apply(null, xs), Math.max.apply(null, ys)],
      // crop rectangle on the page, in PDF points, origin bottom-left
      crop: { x: Math.min.apply(null, qx), y: Math.min.apply(null, qy),
              w: Math.max.apply(null, qx) - Math.min.apply(null, qx),
              h: Math.max.apply(null, qy) - Math.min.apply(null, qy) },
      // how far the quad departs from an axis-aligned rectangle in projected
      // space. Zero on every plate seen so far; a non-zero value means a plain
      // extent would place it wrong and the caller should decline.
      skew: skewOf(info.lpts, xs, ys)
    };
  }

  /*
   * The affine between PDF user space and projected coordinates.
   *
   * The four corners are a ROTATED QUADRILATERAL, not a north-up box. FAA
   * airport diagrams are frequently drawn turned on the page — some at 90°,
   * many at arbitrary angles — and taking min/max of the corners and stretching
   * the image into that box shears the chart. At 45° the box is twice the true
   * area; at 0° and 90° it happens to look right, which is what makes the bug
   * so easy to miss.
   *
   * So the full six-parameter mapping is recovered and used directly. Fitted by
   * least squares over all four corners rather than solved from three, so a
   * chart whose corners are not perfectly consistent degrades gracefully
   * instead of hinging on which three were picked.
   */
  function affine(info) {
    var pr = lcc(info.proj);
    var px = [], py = [], X = [], Y = [];
    for (var i = 0; i < 4; i++) {
      px.push(info.quadPdf[i][0]);
      py.push(info.quadPdf[i][1]);
      var q = pr.forward(info.gpts[i][0], info.gpts[i][1]);
      X.push(q[0]); Y.push(q[1]);
    }

    var c1 = fit3(px, py, X), c2 = fit3(px, py, Y);
    if (!c1 || !c2) return null;

    // page -> projected
    function forward(x, y) {
      return [c1[0] + c1[1] * x + c1[2] * y,
              c2[0] + c2[1] * x + c2[2] * y];
    }
    // projected -> page, by inverting the 2x2 linear part
    var a = c1[1], b = c1[2], c = c2[1], d = c2[2];
    var det = a * d - b * c;
    if (!det) return null;
    function inverse(Xv, Yv) {
      var dx = Xv - c1[0], dy = Yv - c2[0];
      return [(d * dx - b * dy) / det, (-c * dx + a * dy) / det];
    }
    return { forward: forward, inverse: inverse, det: det };
  }

  /* Least squares fit of t = k0 + k1*u + k2*v. */
  function fit3(u, v, t) {
    var n = u.length, Su = 0, Sv = 0, Suu = 0, Svv = 0, Suv = 0;
    var St = 0, Sut = 0, Svt = 0;
    for (var i = 0; i < n; i++) {
      Su += u[i]; Sv += v[i]; Suu += u[i] * u[i]; Svv += v[i] * v[i];
      Suv += u[i] * v[i]; St += t[i]; Sut += u[i] * t[i]; Svt += v[i] * t[i];
    }
    var M = [[n, Su, Sv], [Su, Suu, Suv], [Sv, Suv, Svv]], y = [St, Sut, Svt];
    for (var col = 0; col < 3; col++) {
      var piv = col;
      for (var r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      var tm = M[col]; M[col] = M[piv]; M[piv] = tm;
      var ty = y[col]; y[col] = y[piv]; y[piv] = ty;
      for (r = col + 1; r < 3; r++) {
        var f = M[r][col] / M[col][col];
        for (var q2 = col; q2 < 3; q2++) M[r][q2] -= f * M[col][q2];
        y[r] -= f * y[col];
      }
    }
    var out = [0, 0, 0];
    for (r = 2; r >= 0; r--) {
      var acc = y[r];
      for (q2 = r + 1; q2 < 3; q2++) acc -= M[r][q2] * out[q2];
      out[r] = acc / M[r][r];
    }
    return out;
  }

  var API = { parse: parse, lcc: lcc, place: place, affine: affine, toProj4: toProj4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.PFD = root.PFD || {};
  root.PFD.plateGeo = API;
})(typeof self !== 'undefined' ? self : this);
