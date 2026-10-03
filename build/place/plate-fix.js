/*
 * Placing a chart that carries no georeferencing, from the fixes named on it.
 *
 * FAA approach plates embed where they belong on the earth. Charted visual
 * procedures, and the plates the Department of Defense draws, do not. But
 * they print the names of fixes — five-letter waypoints, navaid idents — at
 * the places those fixes are, the chart is drawn to scale, and where every
 * fix is on the earth is published. Three or four names are enough to say
 * where the chart goes.
 *
 * Two things stand between that and an answer.
 *
 *   A NAME IS NOT WHERE ITS FIX IS. The label sits beside the symbol, a
 *   quarter of an inch away in whichever direction was clear. So the caller
 *   offers, for each name, every MARK drawn near it (snap.js) — the symbol,
 *   the tick across the track — and the fit chooses among them.
 *
 *   A NAME IS OFTEN NOT ON THE MAP AT ALL. The same fix is named again in the
 *   profile view, in the missed-approach text, in the notes and the minimums.
 *   Those copies are at positions that mean nothing. They are found by
 *   agreement: take two points, work out the placement they imply, and count
 *   how many OTHER fixes have a mark where that placement says they should
 *   be. The placement most of the chart agrees on is the plan view's.
 *
 * The placement is a SIMILARITY — one scale, a rotation, a shift — and not a
 * general affine. A chart is drawn north-up or turned, to one scale; it is
 * not sheared. Four parameters from a handful of inexact points behave; six
 * chase the label offsets.
 *
 * Pure: text items and coordinates in, a placement and how far to trust it
 * out. No pdf.js, no DOM, no extension APIs.
 */
(function (root) {
  'use strict';

  var R = 6378137, D = Math.PI / 180;
  function merc(lat, lon) {
    return [R * lon * D, R * Math.log(Math.tan(Math.PI / 4 + lat * D / 2))];
  }
  function unmerc(x, y) {
    return [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D, x / R / D];
  }

  var LIM = {
    tolPt: 1.0,           // a mark this far (PDF points) from where its fix should be still agrees
    loosePt: 2.5,         // ...and this far on the first, rough pass (see solve)
    looPt: 1.5,           // every fix must be this near where the OTHERS put it
    minSpanPt: 70,        // the two labels a trial placement is made from must be this far apart
    minInliers: 3,        // fixes that must agree before anything is placed...
    minSpreadPt: 110,     // ...and they must not all be in one corner of the chart
    maxRotDeg: 0.6,       // a plan view is north-up: every correct placement measured was within 0.4
    maxRmsPt: 0.7,        // marks sit ON their fixes; a worse fit is not a map
    minWide: 4, minLine: 5, lineLead: 1, lineSym: 4,   // how many fixes must agree: see solve()
    minAcrossPt: 45,
    minLieDeg: 12,        // ...unless they run along a line that is not level on the page (see refine)      // the agreeing fixes must have this much breadth ACROSS their own line
    // Points per metre: a plate's plan view is between about 1:150,000 and
    // 1:1,500,000. Outside that the two labels are not a pair on a map.
    minMPerPt: 40, maxMPerPt: 700
  };

  /*
   * The names on the page that are known fixes, with where each label is.
   *
   * items: pdf.js text items ({ str, transform, width, height }).
   * known: { NAME: [lat, lon] } — the fixes near the airport.
   * Returns [{ name, px, py, lat, lon }], px/py in PDF points, origin
   * bottom-left, at the middle of the word.
   */
  function labels(items, known) {
    var out = [];
    (items || []).forEach(function (it) {
      if (!it || typeof it.str !== 'string' || !it.transform) return;
      var s = it.str, t = it.transform;
      var len = s.length || 1, w = +it.width || 0, h = +it.height || Math.abs(t[3]) || 0;
      // Along the baseline, which need not be horizontal.
      var bl = Math.sqrt(t[0] * t[0] + t[1] * t[1]) || 1;
      var ux = t[0] / bl, uy = t[1] / bl;
      var re = /[A-Z0-9]{2,5}/g, m;
      while ((m = re.exec(s))) {
        var name = m[0];
        // A whole word only: not five letters out of "RUNWAY", "APPROACH".
        var before = s.charAt(m.index - 1), after = s.charAt(m.index + name.length);
        if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
        var k = known[name];
        if (!k) continue;
        var mid = (m.index + name.length / 2) / len * w;
        out.push({ name: name, px: t[4] + ux * mid - uy * h * 0.35, py: t[5] + uy * mid + ux * h * 0.35,
                   lat: k[0], lon: k[1] });
      }
    });
    return out;
  }

  /* The similarity taking page points to Mercator metres, through two pairs. */
  function through(p, q) {
    var du = q.px - p.px, dv = q.py - p.py, d2 = du * du + dv * dv;
    if (!d2) return null;
    var dX = q.X - p.X, dY = q.Y - p.Y;
    var a = (dX * du + dY * dv) / d2, b = (dY * du - dX * dv) / d2;
    return { a: a, b: b, tx: p.X - (a * p.px - b * p.py), ty: p.Y - (b * p.px + a * p.py) };
  }

  /* Least squares over many pairs. */
  function best(ps) {
    var n = ps.length, mu = 0, mv = 0, mX = 0, mY = 0, i;
    for (i = 0; i < n; i++) { mu += ps[i].px; mv += ps[i].py; mX += ps[i].X; mY += ps[i].Y; }
    mu /= n; mv /= n; mX /= n; mY /= n;
    var sa = 0, sb = 0, sd = 0;
    for (i = 0; i < n; i++) {
      var u = ps[i].px - mu, v = ps[i].py - mv, X = ps[i].X - mX, Y = ps[i].Y - mY;
      sa += u * X + v * Y; sb += u * Y - v * X; sd += u * u + v * v;
    }
    if (!sd) return null;
    var a = sa / sd, b = sb / sd;
    return { a: a, b: b, tx: mX - (a * mu - b * mv), ty: mY - (b * mu + a * mv) };
  }

  /*
   * Least squares with the chart held north-up: a scale and a shift only.
   * For fixes that lie along one line, which cannot say how the chart is
   * turned — but a plan view is not turned, so they need not.
   */
  function bestUpright(ps) {
    var n = ps.length, mu = 0, mv = 0, mX = 0, mY = 0, i;
    for (i = 0; i < n; i++) { mu += ps[i].px; mv += ps[i].py; mX += ps[i].X; mY += ps[i].Y; }
    mu /= n; mv /= n; mX /= n; mY /= n;
    var sa = 0, sd = 0;
    for (i = 0; i < n; i++) { var u = ps[i].px - mu, v = ps[i].py - mv; sa += u * (ps[i].X - mX) + v * (ps[i].Y - mY); sd += u * u + v * v; }
    if (!sd) return null;
    var a = sa / sd;
    return { a: a, b: 0, tx: mX - a * mu, ty: mY - a * mv };
  }
  /* The direction a set of points runs in, degrees from the page's horizontal, 0..90. */
  function lie(ps) {
    var n = ps.length, mu = 0, mv = 0, i;
    for (i = 0; i < n; i++) { mu += ps[i].px; mv += ps[i].py; }
    mu /= n; mv /= n;
    var suu = 0, svv = 0, suv = 0;
    for (i = 0; i < n; i++) { var u = ps[i].px - mu, v = ps[i].py - mv; suu += u * u; svv += v * v; suv += u * v; }
    var th = Math.abs(0.5 * Math.atan2(2 * suv, suu - svv)) / D;
    return th > 90 ? 180 - th : th;
  }

  function toPage(s, X, Y) {
    var dx = X - s.tx, dy = Y - s.ty, k = s.a * s.a + s.b * s.b;
    return [(s.a * dx + s.b * dy) / k, (-s.b * dx + s.a * dy) / k];
  }
  function toGround(s, px, py) {
    var m = unmerc(s.a * px - s.b * py + s.tx, s.b * px + s.a * py + s.ty);
    return { lat: m[0], lon: m[1] };
  }

  /* How far a set of points extends across its own longest direction, in points. */
  function breadth(ps) {
    var n = ps.length, mu = 0, mv = 0, i;
    for (i = 0; i < n; i++) { mu += ps[i].px; mv += ps[i].py; }
    mu /= n; mv /= n;
    var suu = 0, svv = 0, suv = 0;
    for (i = 0; i < n; i++) { var u = ps[i].px - mu, v = ps[i].py - mv; suu += u * u; svv += v * v; suv += u * v; }
    var th = 0.5 * Math.atan2(2 * suv, suu - svv), c = Math.cos(th), sn = Math.sin(th);
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < n; i++) { var w = -(ps[i].px - mu) * sn + (ps[i].py - mv) * c; lo = Math.min(lo, w); hi = Math.max(hi, w); }
    return hi - lo;
  }

  /* Whether a placement is one a chart could have. `lat` scales Mercator. */
  function plausible(s, lat, maxRot) {
    var mPerPt = Math.sqrt(s.a * s.a + s.b * s.b) * Math.cos(lat * D);
    if (!(mPerPt >= LIM.minMPerPt && mPerPt <= LIM.maxMPerPt)) return false;
    var rot = Math.atan2(s.b, s.a) / D;
    return Math.abs(rot) <= (maxRot || LIM.maxRotDeg);
  }

  /* For each fix, its label nearest where the placement says the fix is. */
  function agreeing(s, ms, tol) {
    tol = tol || LIM.tolPt;
    var byName = Object.create(null);
    ms.forEach(function (m) {
      var p = toPage(s, m.X, m.Y);
      var d = Math.sqrt((p[0] - m.px) * (p[0] - m.px) + (p[1] - m.py) * (p[1] - m.py));
      if (d <= tol && (!byName[m.name] || d < byName[m.name].d)) byName[m.name] = { m: m, d: d };
    });
    return Object.keys(byName).map(function (k) { return byName[k]; });
  }

  /*
   * solve(labels) -> { ok, sim, n, names, rmsPt, mPerPt, rotDeg, errM, pairs }
   * or { ok: false, why }.
   *
   * errM is the root-mean-square distance, in metres on the ground, between
   * where each agreeing label is and where its fix is: what the label
   * offsets left behind. The chart as a whole is placed rather better than
   * that, since the fit averages them — by about the square root of how many
   * there are.
   */
  function solve(found) {
    var ms = (found || []).map(function (f) {
      var g = merc(f.lat, f.lon);
      return { name: f.name, px: f.px, py: f.py, lat: f.lat, lon: f.lon, X: g[0], Y: g[1], wild: !!f.wild, sym: !!f.sym };
    });
    var names = Object.create(null), nNames = 0;
    ms.forEach(function (m) { if (!names[m.name]) { names[m.name] = 1; nNames++; } });
    if (nNames < LIM.minInliers) {
      return { ok: false, why: nNames ? 'only ' + nNames + ' known fix' + (nNames === 1 ? '' : 'es') + ' named on this chart'
                                      : 'no known fix is named on this chart' };
    }
    /*
     * Each pair of points is a guess at the placement, and a rough one: two
     * marks a third of a point out, a hundred points apart, swing a fix at
     * the far side of the chart by more than the tolerance. So a guess is
     * first asked who agrees LOOSELY, then refitted through those and asked
     * again more strictly, twice. Counting strict agreement with the raw
     * guess threw away most charts that had the marks to be placed.
     */
    var tol = LIM.tolPt, loose = Math.max(tol, LIM.loosePt || tol), top = null, second = null;
    var pairRot = LIM.maxRotDeg + (loose > tol ? 1 : 0);
    /*
     * Every fix must be where the OTHERS say it should be. One mark a long
     * way out along the track, a few points from the truth, drags the fit
     * to itself and passes — the rest give a little each. Fitted without
     * it, they put it points away. Such a fix is dropped (a fix beyond a
     * scale break is drawn where it fits, not where it is).
     */
    function loo(s, ag) {
      while (LIM.looPt && ag.length >= 3) {
        var worst = -1, wd = LIM.looPt;
        for (var k2 = 0; k2 < ag.length; k2++) {
          var rest = []; for (var k3 = 0; k3 < ag.length; k3++) if (k3 !== k2) rest.push(ag[k3].m);
          var sl = best(rest); if (!sl) continue;
          var mm = ag[k2].m, pp = toPage(sl, mm.X, mm.Y), dd = Math.sqrt((pp[0] - mm.px) * (pp[0] - mm.px) + (pp[1] - mm.py) * (pp[1] - mm.py));
          if (dd > wd) { wd = dd; worst = k2; }
        }
        if (worst < 0) break;
        ag.splice(worst, 1);
        if (ag.length < LIM.minInliers) return null;
        s = best(ag.map(function (x) { return x.m; }));
        if (!s) return null;
        ag.forEach(function (x) { var p3 = toPage(s, x.m.X, x.m.Y); x.d = Math.sqrt((p3[0] - x.m.px) * (p3[0] - x.m.px) + (p3[1] - x.m.py) * (p3[1] - x.m.py)); });
      }
      return { s: s, ag: ag };
    }
    /*
     * Along one line? Judged without the navaids — one of those, found on
     * some symbol across the page, would make a row of fixes look like a
     * spread — and judged with any ONE fix taken away. Three fixes down a
     * localizer and a fourth off to the side are a row and a guess: the row
     * slides along the track, and somewhere in forty points the fourth finds
     * a mark of its own (Boise ILS 10R, two and a half miles out; Houston GLS
     * 27, eight). Breadth that hangs on one fix is not breadth.
     */
    function isLine(ag) {
      var solid = ag.filter(function (x) { return !x.m.wild; }).map(function (x) { return x.m; });
      if (solid.length < 4) return true;
      for (var i = 0; i < solid.length; i++) {
        var rest = solid.slice(0, i).concat(solid.slice(i + 1));
        if (breadth(rest) < LIM.minAcrossPt) return true;
      }
      return false;
    }
    function refine(s) {
      var ag = null, steps = loose > tol ? [loose, (loose + tol) / 2, tol, tol] : [tol, tol, tol];
      for (var k = 0; k < steps.length; k++) {
        ag = agreeing(s, ms, steps[k]);
        if (ag.length < LIM.minInliers) return null;
        if (k === steps.length - 1) break;
        var pts = ag.map(function (x) { return x.m; });
        var s2 = (LIM.uprightLines && breadth(pts) < LIM.minAcrossPt) ? bestUpright(pts) : best(pts);
        if (!s2) return null;
        s = s2;
      }
      var r = loo(s, ag);
      if (!r) return null;
      s = r.s; ag = r.ag;
      var fin = ag.map(function (x) { return x.m; }), line = isLine(ag);
      /*
       * On a line a navaid neither counts nor pulls. It was offered every
       * symbol on the page, and the symbols of the other fixes are on this
       * line: it will be found on one of them, a few points from where it
       * is, and then drag the scale to suit. (Salt Lake City ILS 16L, half a
       * mile out with seven "agreeing".) The fit is made again without it.
       */
      if (line && ag.some(function (x) { return x.m.wild; })) {
        var solid = ms.filter(function (m) { return !m.wild; });
        ag = ag.filter(function (x) { return !x.m.wild; });
        for (var again = 0; again < 2; again++) {
          if (ag.length < LIM.minInliers) return null;
          s = best(ag.map(function (x) { return x.m; }));
          if (!s) return null;
          ag = agreeing(s, solid, tol);
        }
        r = loo(s, ag);
        if (!r) return null;
        s = r.s; ag = r.ag;
        fin = ag.map(function (x) { return x.m; });
        line = true;
      }
      if (!plausible(s, ag[0].m.lat)) return null;
      /*
       * Fixes along one line. The fixes of a final approach are, and with
       * the chart held north-up they still say where it is. But the profile
       * view lists the same fixes again along a level line, spaced much as
       * they are on the ground: a row that runs ACROSS the page is not
       * believed.
       */
      if (line && (LIM.noLines || lie(fin) < LIM.minLieDeg)) return null;
      var sum = 0; ag.forEach(function (x) { sum += x.d; });
      return { s: s, ag: ag, sum: sum, line: line };
    }
    // the same placement, or another? compared where the agreeing fixes are
    function same(h, g) {
      var m = h.ag[0].m, p = toPage(g.s, m.X, m.Y), q = toPage(h.s, m.X, m.Y);
      var m2 = h.ag[h.ag.length - 1].m, p2 = toPage(g.s, m2.X, m2.Y), q2 = toPage(h.s, m2.X, m2.Y);
      return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 3 && Math.abs(p2[0] - q2[0]) + Math.abs(p2[1] - q2[1]) < 3;
    }
    function better(h, g) { return !g || h.ag.length > g.ag.length || (h.ag.length === g.ag.length && h.sum < g.sum); }
    for (var i = 0; i < ms.length; i++) {
      for (var j = i + 1; j < ms.length; j++) {
        var p = ms[i], q = ms[j];
        if (p.name === q.name) continue;
        var du = q.px - p.px, dv = q.py - p.py;
        if (du * du + dv * dv < LIM.minSpanPt * LIM.minSpanPt) continue;
        var s = through(p, q);
        if (!s || !plausible(s, p.lat, pairRot)) continue;
        if (agreeing(s, ms, loose).length < LIM.minInliers) continue;
        var hyp = refine(s);
        if (!hyp) continue;
        if (!top) top = hyp;
        else if (same(hyp, top)) { if (better(hyp, top)) top = hyp; }
        else if (better(hyp, top)) { second = top; top = hyp; }
        else if (better(hyp, second)) second = hyp;
      }
    }
    if (!top) return { ok: false, why: 'the fixes named on this chart do not agree on where it is' };
    var sim = top.s, ag = top.ag;
    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, sq = 0;
    ag.forEach(function (x) {
      minU = Math.min(minU, x.m.px); maxU = Math.max(maxU, x.m.px);
      minV = Math.min(minV, x.m.py); maxV = Math.max(maxV, x.m.py);
      sq += x.d * x.d;
    });
    var spread = Math.sqrt((maxU - minU) * (maxU - minU) + (maxV - minV) * (maxV - minV));
    if (spread < LIM.minSpreadPt) return { ok: false, why: 'the fixes that agree are all in one part of the chart' };
    /*
     * Fixes in a straight line prove nothing. The fixes of a final approach
     * ARE in a straight line, and the profile view lists them again along
     * another straight line, spaced much as they are on the ground: a row of
     * labels there agrees with itself as well as the plan view does, and
     * placed the chart eighty miles out, turned on its side. Only fixes with
     * some breadth across their own line can say where a map is.
     */
    var across = breadth(ag.map(function (x) { return x.m; }));
    if (across < LIM.minAcrossPt && !top.line && false) return { ok: false, why: 'the fixes that agree lie along one line, which does not fix a map' };
    /*
     * How many must agree. Measured on 527 FAA plates whose true position is
     * known (README). A navaid never counts toward the number: it was offered
     * every symbol on the page.
     *
     * Fixes with breadth across the chart: four. Three and a navaid was wrong
     * twice in 391 charts.
     *
     * Fixes along one line: five, no other placement with as many, and four
     * of them marked by SYMBOLS (a waypoint star, a triangle). A track is
     * crossed by a tick every few points, and a row of fixes marked by ticks
     * can be slid along it onto other ticks: of 27 such placements two were
     * half a mile out, and nothing told them from the rest. Symbols are far
     * apart; of 42 rows of symbols none was more than 0.08 nm out.
     */
    var nWild = 0; ag.forEach(function (x) { if (x.m.wild) nWild++; });
    /*
     * Can the row be slid? The same fixes, moved along their line and
     * stretched a little, are tried against the marks each was offered: every
     * half point for forty points either way, every half per cent of scale
     * for six. The best any such rival does is `rival`. Moffett's ILS 32R
     * put six fixes on six marks, every one seven points down the track from
     * where it belonged.
     */
    var rival = 0;
    if (top.line) {
      var pts = ag.map(function (x) { return x.m; }), cu = 0, cv = 0;
      pts.forEach(function (m) { cu += m.px / pts.length; cv += m.py / pts.length; });
      var suu = 0, svv = 0, suv = 0;
      pts.forEach(function (m) { var u = m.px - cu, v = m.py - cv; suu += u * u; svv += v * v; suv += u * v; });
      var th = 0.5 * Math.atan2(2 * suv, suu - svv), dx = Math.cos(th), dy = Math.sin(th);
      var along = pts.map(function (m) { return (m.px - cu) * dx + (m.py - cv) * dy; });
      var offered = pts.map(function (m) { return ms.filter(function (q) { return q.name === m.name; }); });
      for (var kk = 0.94; kk <= 1.0601; kk += 0.005) {
        for (var dl = -40; dl <= 40; dl += 0.5) {
          var moved = 0, hits = 0;
          for (var a2 = 0; a2 < pts.length; a2++) {
            var sh = kk * along[a2] + dl - along[a2];
            if (Math.abs(sh) > moved) moved = Math.abs(sh);
            var tx2 = pts[a2].px + sh * dx, ty2 = pts[a2].py + sh * dy, got = false;
            for (var b2 = 0; b2 < offered[a2].length && !got; b2++) {
              var q2 = offered[a2][b2];
              if ((q2.px - tx2) * (q2.px - tx2) + (q2.py - ty2) * (q2.py - ty2) <= tol * tol) got = true;
            }
            if (got) hits++;
          }
          if (moved > 2.5 && hits > rival) rival = hits;
        }
      }
    }
    var n2 = second ? second.ag.length : 0;
    if (top.line) {
      if (ag.length - nWild < LIM.minLine) return { ok: false, why: 'only ' + (ag.length - nWild) + ' fixes agree, along one line', n: ag.length, n2: n2, line: true };
      var nSym0 = ag.filter(function (x) { return x.m.sym && !x.m.wild; }).length;
      if (nSym0 < LIM.lineSym) return { ok: false, why: 'the fixes lie along one line and are marked by ticks, which a row of fixes can be slid along', n: ag.length, n2: n2, rival: rival, line: true };
      if (ag.length - n2 < LIM.lineLead || ag.length - rival < LIM.lineLead) return { ok: false, why: 'the fixes lie along one line and fit it in more than one way', n: ag.length, n2: n2, rival: rival, line: true };
    } else if (ag.length - nWild < LIM.minWide) return { ok: false, why: 'only ' + (ag.length - nWild) + ' fixes agree', n: ag.length, n2: n2, line: false };
    var rms0 = Math.sqrt(sq / ag.length);
    if (rms0 > LIM.maxRmsPt) return { ok: false, why: 'the fixes named on this chart agree only loosely on where it is' };
    var lat0 = ag[0].m.lat;
    var mPerPt = Math.sqrt(sim.a * sim.a + sim.b * sim.b) * Math.cos(lat0 * D);
    var rmsPt = Math.sqrt(sq / ag.length);
    return {
      ok: true, sim: sim, n: ag.length, n2: second ? second.ag.length : 0, rival: rival, nSym: ag.filter(function (x) { return x.m.sym && !x.m.wild; }).length, line: !!top.line, across: across,
      names: ag.map(function (x) { return x.m.name; }),
      rmsPt: rmsPt, mPerPt: mPerPt, errM: rmsPt * mPerPt,
      rotDeg: Math.atan2(sim.b, sim.a) / D, spreadPt: spread,
      pairs: ag.map(function (x) { return { name: x.m.name, px: x.m.px, py: x.m.py, lat: x.m.lat, lon: x.m.lon }; })
    };
  }

  var API = { labels: labels, solve: solve, toGround: toGround, LIM: LIM,
              toPage: function (s, lat, lon) { var g = merc(lat, lon); return toPage(s, g[0], g[1]); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.PFD = root.PFD || {};
  root.PFD.plateFix = API;
})(typeof self !== 'undefined' ? self : this);
