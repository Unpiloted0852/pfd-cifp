#!/usr/bin/env node
/*
 * Build the published tree from one FAACIFP18 file.
 *
 *   node build/build.js <FAACIFP18> <out-dir>
 *
 * Writes:
 *   <out>/v1/index.json        cycle, dates, and every airport covered with its position
 *   <out>/v1/apt/<ID>.json     one airport's SIDs, STARs and approaches
 *   <out>/v1/seg/<lat>_<lon>.json   every procedure leg crossing that one-degree cell
 *   <out>/v1/airspace.json     Class B, C and D airspace, as outlines
 *
 * The "v1" is the FORMAT version, not the data cycle. An extension already
 * installed keeps asking for v1, so a change that would break it goes to v2
 * beside it rather than replacing what the old one reads.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cifp = require('./cifp-parse.js');
var airspace = require('./airspace.js');

var FORMAT = 1;

function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

var DEG = Math.PI / 180;

/*
 * The straight legs of every procedure at an airport, as fix-to-fix chords.
 *
 * This is NOT the geometry anything is measured against — the extension builds
 * that itself, arcs and all, from the airport file. It is a coarse net: enough
 * to answer "which airports have a procedure passing under this aircraft",
 * which is the one question the airport files cannot answer without first
 * knowing which airport to open. An arrival begins two hundred miles from the
 * field it serves.
 */
var CHORD_TO = { TF: 1, CF: 1, DF: 1, RF: 1, AF: 1 };

function chordsOf(a) {
  var seen = Object.create(null), out = [];
  [a.app, a.sid, a.star].forEach(function (list) {
    list.forEach(function (proc) {
      proc.rt.forEach(function (route) {
        var at = null;
        route.l.forEach(function (leg) {
          var pt = (typeof leg.f === 'number') ? a.x[leg.f] : null;
          if (leg.p === 'IF') { at = pt; return; }
          if (CHORD_TO[leg.p] && pt) {
            if (at && (at[1] !== pt[1] || at[2] !== pt[2])) {
              var c = [r4(at[1]), r4(at[2]), r4(pt[1]), r4(pt[2])];
              var k = c.join(',');
              // Transitions share legs; one copy says all there is to say.
              if (!seen[k]) { seen[k] = 1; out.push(c); }
            }
            at = pt;
            return;
          }
          // A hold returns to its fix. Anything else ends somewhere unknown,
          // and no chord is drawn from an unknown place.
          if (leg.p === 'HM' || leg.p === 'HF' || leg.p === 'HA' || leg.p === 'PI') { if (pt) at = pt; }
          else at = null;
        });
      });
    });
  });
  return out;
}

function r4(v) { return Math.round(v * 1e4) / 1e4; }

/*
 * The one-degree cells a chord passes through or close beside.
 *
 * Walked along the chord rather than taken from its bounding box: a leg two
 * hundred miles long on a diagonal has a bounding box of nine cells and
 * actually crosses four. The margin puts a leg running along a cell boundary
 * into the cells on both sides, so an aircraft only ever needs the one cell it
 * is in.
 */
var CELL_MARGIN_DEG = 0.06;      // about three and a half miles of latitude

function cellsOf(c) {
  var out = Object.create(null);
  // Along the GREAT CIRCLE between the ends, which is what is flown. A long
  // leg bows towards the pole by miles, and stepping along a straight line in
  // latitude and longitude files it in the wrong cells near a boundary.
  var la1 = c[0] * DEG, lo1 = c[1] * DEG, la2 = c[2] * DEG, lo2 = c[3] * DEG;
  var h = Math.sin((la2 - la1) / 2) * Math.sin((la2 - la1) / 2) +
          Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) * Math.sin((lo2 - lo1) / 2);
  var d = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  var steps = Math.max(1, Math.ceil((d / DEG) / 0.05));
  for (var i = 0; i <= steps; i++) {
    var f = i / steps, la, lo;
    if (d < 1e-9) { la = c[0]; lo = c[1]; }
    else {
      var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      var y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      var z = A * Math.sin(la1) + B * Math.sin(la2);
      la = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
      lo = Math.atan2(y, x) / DEG;
    }
    var mLon = CELL_MARGIN_DEG / Math.max(0.2, Math.cos(la * DEG));
    for (var a = -1; a <= 1; a++) {
      for (var b = -1; b <= 1; b++) {
        out[Math.floor(la + a * CELL_MARGIN_DEG) + '_' + Math.floor(lo + b * mLon)] = 1;
      }
    }
  }
  return Object.keys(out);
}

function build(src, outDir, opts) {
  // Names this build. The same cycle can be built more than once — a change
  // here adds something to it — and the extension must not go on using a cell
  // file it fetched from the earlier build.
  var built = (opts && opts.built) || new Date().toISOString();
  var minAirports = (opts && typeof opts.minAirports === 'number') ? opts.minAirports : 2000;
  var text = fs.readFileSync(src, 'latin1');
  var res = cifp.parse(text);
  if (!res.cycle || !res.effective) throw new Error('no cycle header found in ' + src);

  var ids = Object.keys(res.airports).sort();
  // A truncated download parses without complaint and would publish a tree
  // with most of the country missing. The real file has about 3,000 airports.
  if (ids.length < minAirports) {
    throw new Error('only ' + ids.length + ' airports parsed; refusing to publish a partial cycle');
  }

  var root = path.join(outDir, 'v' + FORMAT);
  var aptDir = path.join(root, 'apt');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(aptDir, { recursive: true });

  var bytes = 0;
  var cells = Object.create(null);       // "lat_lon" -> { a: [ids], s: [[ai, la, lo, la, lo]] }
  ids.forEach(function (id) {
    var a = res.airports[id];
    var doc = { v: FORMAT, c: res.cycle, id: a.id, lat: a.lat, lon: a.lon, mv: a.mv, el: a.el,
                x: a.x || [], rw: a.rw, app: a.app, sid: a.sid, star: a.star };
    var body = JSON.stringify(doc);
    bytes += body.length;
    fs.writeFileSync(path.join(aptDir, id + '.json'), body);

    chordsOf(a).forEach(function (c) {
      cellsOf(c).forEach(function (key) {
        var cell = cells[key] || (cells[key] = { a: [], s: [], w: [], _i: Object.create(null) });
        if (!(id in cell._i)) { cell._i[id] = cell.a.length; cell.a.push(id); }
        cell.s.push([cell._i[id], c[0], c[1], c[2], c[3]]);
      });
    });
  });

  // Airways, leg by leg, into the same cells. Each leg carries its airway's
  // name and its place in the string, so the extension can put neighbouring
  // legs back together, and the fixes at its two ends.
  res.airways.forEach(function (a) {
    for (var n = 0; n + 1 < a.pts.length; n++) {
      var p0 = a.pts[n], p1 = a.pts[n + 1];
      var c = [r4(p0[1]), r4(p0[2]), r4(p1[1]), r4(p1[2])];
      cellsOf(c).forEach(function (key) {
        var cell = cells[key] || (cells[key] = { a: [], s: [], w: [], _i: Object.create(null) });
        cell.w.push([a.name, n, c[0], c[1], c[2], c[3], p0[0], p1[0], a.level]);
      });
    }
  });

  var segDir = path.join(root, 'seg');
  fs.mkdirSync(segDir, { recursive: true });
  var cellKeys = Object.keys(cells).sort(), segBytes = 0, segMax = 0;
  cellKeys.forEach(function (key) {
    var body = JSON.stringify({ v: FORMAT, c: res.cycle, b: built, a: cells[key].a, s: cells[key].s,
                                w: cells[key].w });
    segBytes += body.length;
    if (body.length > segMax) segMax = body.length;
    fs.writeFileSync(path.join(segDir, key + '.json'), body);
  });

  var index = {
    v: FORMAT,
    cycle: res.cycle,
    effective: res.effective,
    // A cycle runs for 28 days. This is the day the NEXT one comes into
    // force — from this date on, these procedures are no longer current.
    expires: addDays(res.effective, 28),
    built: built,
    src: 'FAA CIFP, public domain. Not for navigation.',
    // Identifier and position. The extension asks "what is near this
    // aircraft", and CIFP names small fields by their FAA identifier where
    // other datasets use something else, so position is the only key the two
    // sides reliably share.
    apt: ids.map(function (id) {
      var a = res.airports[id];
      return [id, Math.round(a.lat * 1000) / 1000, Math.round(a.lon * 1000) / 1000];
    }),
    // The cells that have a file under seg/. Listed so the extension never
    // asks for one that is not there: most of the ocean, and all of Europe.
    cells: cellKeys
  };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index));

  /*
   * Class B, C and D airspace, as outlines: one file for the country, for the
   * extension to lay on the map when asked. Each piece is
   *   [class, name, floor ft, 'M'|'A', ceiling ft, 'M'|'A', [lat, lon, lat, lon, ...]]
   * with M above sea level and A above the ground. A new file beside the
   * others, so nothing an installed extension reads has changed.
   */
  var air = airspace.airspace(text);
  var airBody = JSON.stringify({ v: FORMAT, c: res.cycle, effective: res.effective, b: built,
    src: 'FAA CIFP, public domain. Not for navigation.',
    a: air.map(function (x) {
      var flat = [];
      x.p.forEach(function (p) { flat.push(r4(p[0]), r4(p[1])); });
      return [x.c, x.n, x.lo, x.loRef, x.hi, x.hiRef, flat];
    }) });
  fs.writeFileSync(path.join(root, 'airspace.json'), airBody);
  return { air: air.length, airBytes: airBody.length, index: index, stats: res.stats, bytes: bytes,
           segBytes: segBytes, segMax: segMax, cells: cellKeys.length };
}

if (require.main === module) {
  var src = process.argv[2], out = process.argv[3];
  if (!src || !out) {
    console.error('usage: build.js <FAACIFP18> <out-dir>');
    process.exit(2);
  }
  var r = build(src, out);
  console.log('cycle ' + r.index.cycle + ', effective ' + r.index.effective +
              ', expires ' + r.index.expires);
  console.log(r.index.apt.length + ' airports, ' + r.stats.procedures + ' procedures, ' +
              r.stats.legs + ' legs, ' + r.stats.unresolved + ' fixes unresolved');
  console.log(r.stats.airways + ' airway strings, ' + r.stats.airwayLegs + ' airway legs');
  console.log((r.bytes / 1048576).toFixed(1) + ' MB of airport files');
  console.log(r.air + ' pieces of Class B, C and D airspace, ' + Math.round(r.airBytes / 1024) + ' kB');
  console.log(r.cells + ' cells, ' + (r.segBytes / 1048576).toFixed(1) + ' MB of leg files, largest ' +
              Math.round(r.segMax / 1024) + ' kB');
}

module.exports = { build: build, addDays: addDays, chordsOf: chordsOf, cellsOf: cellsOf };
