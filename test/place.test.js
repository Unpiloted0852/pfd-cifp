/*
 * Placing charts that carry no georeferencing: the parts that need no PDF.
 *
 *   which charts are looked at at all   (build/place/dtpp.js)
 *   when a set of fixes is believed     (build/place/plate-fix.js)
 *
 * The rest — rendering, OCR, finding the marks — is measured against FAA
 * plates whose true position is known, by `run.js --validate`; see the README.
 */
'use strict';
var D = require('../build/place/dtpp.js');
var FX = require('../build/place/plate-fix.js');
var failed = 0;
function ok(name, cond, detail) { console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : '')); if (!cond) failed++; }

console.log('\nwhich charts are looked at');
function rec(code, name, pdf, civil) { return '<record><chart_code>' + code + '</chart_code><chart_name>' + name + '</chart_name><pdf_name>' + pdf + '</pdf_name><civil>' + civil + '</civil></record>'; }
var xml = '<digital_tpp cycle="2610" from_edate="x" to_edate="y">' +
  '<airport_name ID="PORTLAND INTL" military="N" apt_ident="PDX" icao_ident="KPDX" alnum="330">' +
    rec('IAP', 'ILS OR LOC RWY 10L', '00330IL10L.PDF', 'C') + rec('IAP', 'RNAV (GPS) RWY 10L', '00330R10L.PDF', 'C') +
    rec('DP', 'CASCADE FOUR', '00330CASCADE.PDF', 'C') + rec('IAP', 'MILL VISUAL RWY 28L', '00330MILL_VIS28L.PDF', 'C') + '</airport_name>' +
  '<airport_name ID="TRAVIS AFB" military="M" apt_ident="SUU" icao_ident="KSUU" alnum="488">' +
    rec('IAP', 'TACAN RWY 21L', '00488T21L.PDF', 'N') + rec('IAP', 'HI-TACAN RWY 21L, CONT.1', '00488HT21L_C.PDF', 'H') + '</airport_name>' +
  '<airport_name ID="SMALL FIELD" military="N" apt_ident="1O2" icao_ident="" alnum="9">' + rec('IAP', 'RNAV (GPS) RWY 28', '09999R28.PDF', 'C') + '</airport_name>' +
  '</digital_tpp>';
var meta = D.charts(xml), cand = D.candidates(meta.list);
ok('the cycle is read from the list', meta.cycle === '2610');
ok('approach charts only', meta.list.length === 6 && !meta.list.some(function (c) { return /CASCADE/.test(c.name); }), meta.list.length + ' listed');
ok('an airport with no ICAO identifier goes by its FAA one', meta.list.some(function (c) { return c.id === '1O2'; }));
ok('the FAA\'s own approach plates are never looked at', !cand.some(function (c) { return c.pdf === '00330il10l.pdf' || c.pdf === '00330r10l.pdf' || c.pdf === '09999r28.pdf'; }));
ok('a military field\'s plate is', cand.some(function (c) { return c.pdf === '00488t21l.pdf'; }));
ok('a charted visual is', cand.some(function (c) { return c.pdf === '00330mill_vis28l.pdf'; }));
ok('a continuation page is not: it has no plan view', !cand.some(function (c) { return /_c\.pdf$/.test(c.pdf); }));
ok('and nothing else', cand.length === 2, cand.length + ' candidates');

console.log('\nwhen fixes are believed');
// A chart drawn at 180 m to the point, north-up, with its origin at 38N 122W.
var R = 6378137, RAD = Math.PI / 180, K = 180 / Math.cos(38 * RAD);
function ground(px, py) { var X = R * -122 * RAD + K * px, Y = R * Math.log(Math.tan(Math.PI / 4 + 38 * RAD / 2)) + K * py; return [(2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) / RAD, X / R / RAD]; }
function fix(name, px, py, o) { var g = ground(px, py); return Object.assign({ name: name, px: px, py: py, lat: g[0], lon: g[1] }, o || {}); }
function at(c, name, px, py, o) { return Object.assign({}, c, { name: name, px: px, py: py }, o || {}); }   // the mark is here; the fix is where c says

var spread = [fix('AAAAA', 100, 400), fix('BBBBB', 250, 380), fix('CCCCC', 180, 250), fix('DDDDD', 300, 200), fix('EEEEE', 120, 180)];
var r = FX.solve(spread);
ok('five fixes spread across the chart are placed', r.ok && r.n === 5 && !r.line, r.ok ? 'n=' + r.n : r.why);
var g0 = r.ok ? FX.toGround(r.sim, 200, 300) : null, t0 = ground(200, 300);
ok('and placed where the chart is', r.ok && Math.abs(g0.lat - t0[0]) < 1e-5 && Math.abs(g0.lon - t0[1]) < 1e-5);
ok('the scale it was drawn to is recovered', r.ok && Math.abs(r.mPerPt - 180) < 3, r.ok ? r.mPerPt.toFixed(1) : '');

r = FX.solve(spread.slice(0, 3));
ok('three are not enough', !r.ok, r.why);

var decoys = spread.concat([at(spread[0], 'AAAAA', 500, 700), at(spread[1], 'BBBBB', 40, 90), at(spread[2], 'CCCCC', 333, 444)]);
r = FX.solve(decoys);
ok('marks that belong to no placement are ignored', r.ok && r.n === 5);

// The same chart turned five degrees: a plan view is north-up, so this is something else.
var c5 = Math.cos(5 * RAD), s5 = Math.sin(5 * RAD);
r = FX.solve(spread.map(function (f) { return Object.assign({}, f, { px: 200 + (f.px - 200) * c5 - (f.py - 300) * s5, py: 300 + (f.px - 200) * s5 + (f.py - 300) * c5 }); }));
ok('a chart that would have to be turned is refused', !r.ok, r.why);

var row = [0, 1, 2, 3, 4, 5].map(function (i) { return fix('ROW' + i + 'X', 150 + 10 * i, 150 + 60 * i); });
r = FX.solve(row);
ok('a row of fixes marked by ticks is refused: it can be slid along the track', !r.ok && /line/.test(r.why), r.why);
r = FX.solve(row.map(function (f) { return Object.assign({}, f, { sym: true }); }));
ok('the same row marked by symbols is placed', r.ok && r.line, r.ok ? 'n=' + r.n : r.why);
r = FX.solve(row.slice(0, 4).map(function (f) { return Object.assign({}, f, { sym: true }); }));
ok('but not four of them', !r.ok, r.why);

var hang = row.slice(0, 3).concat([fix('ASIDE', 320, 260)]);
r = FX.solve(hang);
ok('three in a row and one off to the side is a row, not a spread', !r.ok && /line/.test(r.why), r.why);

var level = [0, 1, 2, 3, 4, 5].map(function (i) { return fix('LVL' + i + 'X', 100 + 50 * i, 300 + i, { sym: true }); });
r = FX.solve(level);
ok('a row running across the page is the profile view, and is refused', !r.ok, r.why);

var nav = spread.slice(0, 3).concat([fix('NAV', 300, 200, { wild: true })]);
r = FX.solve(nav);
ok('a navaid does not count toward the four', !r.ok, r.why);
r = FX.solve(spread.slice(0, 4).concat([fix('NAV', 120, 180, { wild: true })]));
ok('but is used once there are four', r.ok && r.n === 5, r.ok ? 'n=' + r.n : r.why);

console.log(failed ? '\n' + failed + ' FAILED\n' : '\nall place checks passed\n');
process.exit(failed ? 1 : 0);
