#!/usr/bin/env node
/*
 * Build the published tree from one FAACIFP18 file.
 *
 *   node build/build.js <FAACIFP18> <out-dir>
 *
 * Writes:
 *   <out>/v1/index.json        cycle, dates, and every airport covered with its position
 *   <out>/v1/apt/<ID>.json     one airport's SIDs, STARs and approaches
 *
 * The "v1" is the FORMAT version, not the data cycle. An extension already
 * installed keeps asking for v1, so a change that would break it goes to v2
 * beside it rather than replacing what the old one reads.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cifp = require('./cifp-parse.js');

var FORMAT = 1;

function addDays(iso, n) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function build(src, outDir, opts) {
  var minAirports = (opts && typeof opts.minAirports === 'number') ? opts.minAirports : 2000;
  var res = cifp.parse(fs.readFileSync(src, 'latin1'));
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
  ids.forEach(function (id) {
    var a = res.airports[id];
    var doc = { v: FORMAT, c: res.cycle, id: a.id, lat: a.lat, lon: a.lon, mv: a.mv, el: a.el,
                x: a.x || [], rw: a.rw, app: a.app, sid: a.sid, star: a.star };
    var body = JSON.stringify(doc);
    bytes += body.length;
    fs.writeFileSync(path.join(aptDir, id + '.json'), body);
  });

  var index = {
    v: FORMAT,
    cycle: res.cycle,
    effective: res.effective,
    // A cycle runs for 28 days. This is the day the NEXT one comes into
    // force — from this date on, these procedures are no longer current.
    expires: addDays(res.effective, 28),
    src: 'FAA CIFP, public domain. Not for navigation.',
    // Identifier and position. The extension asks "what is near this
    // aircraft", and CIFP names small fields by their FAA identifier where
    // other datasets use something else, so position is the only key the two
    // sides reliably share.
    apt: ids.map(function (id) {
      var a = res.airports[id];
      return [id, Math.round(a.lat * 1000) / 1000, Math.round(a.lon * 1000) / 1000];
    })
  };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index));
  return { index: index, stats: res.stats, bytes: bytes };
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
  console.log((r.bytes / 1048576).toFixed(1) + ' MB of airport files');
}

module.exports = { build: build, addDays: addDays };
