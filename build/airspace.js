/*
 * Controlled airspace out of the CIFP: Class B, C and D, as outlines.
 *
 * The CIFP's UC records describe each piece of airspace as a walk round its
 * edge: a point, how to get to the next one (a straight line, an arc about a
 * centre one way or the other), and so on back to the start; or simply a
 * circle. The first record of each piece carries its floor, ceiling and
 * name. A Class B is many pieces — the layers of the upside-down cake — each
 * with its own floor.
 *
 *   airspace(text) -> [{ c: 'B', n: 'SAN FRANCISCO AREA A',
 *                        lo: 0, loRef: 'A', hi: 10000, hiRef: 'M',
 *                        p: [[lat, lon], ...] }]        (closed: last = first)
 *
 * lo/hi are feet; the Ref is 'M' above mean sea level, 'A' above the ground.
 * Arcs are walked every five degrees, which at a thirty-mile ring is an
 * error of thirty yards.
 *
 * What the file does NOT have: TRSAs. Its airspace is Class B, C and D and
 * nothing else (types T, A and Z); restricted areas are in UR and not read.
 */
'use strict';
var P = require('./cifp-parse.js');
var col = P.col;
var D = Math.PI / 180, NM = 1 / 60;

function r5(v) { return Math.round(v * 1e5) / 1e5; }

/* A point `nm` from a centre on a true bearing. Flat enough at these sizes. */
function offset(c, brg, nm) {
  return [c[0] + nm * NM * Math.cos(brg * D), c[1] + nm * NM * Math.sin(brg * D) / Math.cos(c[0] * D)];
}
function polar(c, p) {
  var dn = (p[0] - c[0]) / NM, de = (p[1] - c[1]) / NM * Math.cos(c[0] * D);
  return { nm: Math.sqrt(dn * dn + de * de), brg: (Math.atan2(de, dn) / D + 360) % 360 };
}

/* "GND  " -> 0 ft above ground; "02500" -> 2500; "FL180" -> 18000; "UNLTD" -> null. */
function limit(s, unit) {
  s = s.trim();
  if (!s) return null;
  if (s === 'GND' || s === 'SFC') return { ft: 0, ref: 'A' };
  if (/^FL\d+$/.test(s)) return { ft: +s.slice(2) * 100, ref: 'M' };
  if (/^\d+$/.test(s)) return { ft: +s, ref: unit === 'A' ? 'A' : 'M' };
  return null;
}

var CLASS = { T: 'B', A: 'C', Z: 'D' };

function airspace(text) {
  var lines = text.split(/\r?\n/), groups = Object.create(null), order = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.length < 132 || l.substr(0, 1) !== 'S' || l.substr(4, 2) !== 'UC') continue;
    if (col(l, 25, 25) > '1') continue;                    // continuation: nothing this reads
    var cls = CLASS[col(l, 9, 9)];
    if (!cls) continue;
    var key = col(l, 7, 20);                               // region, type, centre, class, which piece
    if (!groups[key]) { groups[key] = { cls: cls, recs: [] }; order.push(key); }
    groups[key].recs.push({
      seq: +col(l, 21, 24), via: col(l, 31, 31), end: col(l, 32, 32) === 'E',
      at: [P.parseLat(col(l, 33, 41)), P.parseLon(col(l, 42, 51))],
      ctr: [P.parseLat(col(l, 52, 60)), P.parseLon(col(l, 61, 70))],
      nm: /^\d{4}$/.test(col(l, 71, 74)) ? +col(l, 71, 74) / 10 : null,
      lo: limit(col(l, 82, 86), col(l, 87, 87)), hi: limit(col(l, 88, 92), col(l, 93, 93)),
      name: col(l, 94, 123).trim()
    });
  }
  var out = [];
  order.forEach(function (key) {
    var g = groups[key], recs = g.recs.sort(function (a, b) { return a.seq - b.seq; });
    var first = recs[0], pts = [];
    if (!first.lo || !first.hi) return;                    // no floor or ceiling: not something to draw
    function push(p) { if (p[0] != null && p[1] != null) pts.push([r5(p[0]), r5(p[1])]); }
    for (var k = 0; k < recs.length; k++) {
      var r = recs[k];
      if (r.via === 'C') {                                 // a circle, and nothing else
        if (r.ctr[0] == null || !r.nm) return;
        for (var b = 0; b <= 360; b += 5) push(offset(r.ctr, b, r.nm));
        break;
      }
      if (r.at[0] == null) return;
      push(r.at);
      if (r.via === 'L' || r.via === 'R') {
        // An arc from this point to the next (or back to the first), about
        // the centre: R clockwise, L the other way.
        var to = (r.end || k + 1 >= recs.length) ? first.at : recs[k + 1].at;
        if (r.ctr[0] == null || to[0] == null) return;
        var a = polar(r.ctr, r.at), z = polar(r.ctr, to);
        var sweep = r.via === 'R' ? (z.brg - a.brg + 360) % 360 : (a.brg - z.brg + 360) % 360;
        if (sweep < 0.01) sweep = 360;                     // all the way round to where it began
        var steps = Math.max(1, Math.ceil(sweep / 5));
        for (var s = 1; s < steps; s++) {
          var f = s / steps, brg = r.via === 'R' ? a.brg + sweep * f : a.brg - sweep * f;
          push(offset(r.ctr, brg, a.nm + (z.nm - a.nm) * f));
        }
      }
      if (r.end) break;
    }
    if (pts.length < 3) return;
    var p0 = pts[0], pn = pts[pts.length - 1];
    if (p0[0] !== pn[0] || p0[1] !== pn[1]) pts.push([p0[0], p0[1]]);
    out.push({ c: g.cls, n: first.name, lo: first.lo.ft, loRef: first.lo.ref, hi: first.hi.ft, hiRef: first.hi.ref, p: pts });
  });
  return out;
}

module.exports = { airspace: airspace, limit: limit };
