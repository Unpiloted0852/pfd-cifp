/*
 * Where every named thing is: waypoints, navaids, runway thresholds.
 *
 * A second, much simpler reading of the CIFP than cifp-parse.js makes. That
 * one resolves procedures and needs to know which airport and region a fix
 * belongs to. This one only needs "what could a five-letter word on a chart
 * near here be?", so it keeps every position a name has, anywhere, and the
 * caller takes the one nearest the airport.
 *
 *   fixes(text) -> { fix: { NAME: [[lat, lon], ...] },
 *                    apt: { ID: { lat, lon, rw: { RW21L: [lat, lon] } } } }
 */
'use strict';
var P = require('../cifp-parse.js');
var col = P.col;

function fixes(text) {
  var fix = Object.create(null), apt = Object.create(null);
  function put(name, lat, lon) {
    if (!name || lat == null || lon == null) return;
    var list = fix[name] || (fix[name] = []);
    for (var i = 0; i < list.length; i++) if (Math.abs(list[i][0] - lat) < 1e-4 && Math.abs(list[i][1] - lon) < 1e-4) return;
    list.push([Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
  }
  function airport(id) { return apt[id] || (apt[id] = { lat: null, lon: null, rw: {} }); }
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.length < 132 || line[0] !== 'S') continue;
    if (col(line, 22, 22) > '1') continue;          // continuations repeat the key
    var sec = line[4];
    if (sec === 'D') {
      var la = P.parseLat(col(line, 33, 41)), lo = P.parseLon(col(line, 42, 51));
      if (la == null) { la = P.parseLat(col(line, 56, 64)); lo = P.parseLon(col(line, 65, 74)); }   // DME or TACAN only
      put(col(line, 14, 17).trim(), la, lo);
    } else if (sec === 'E' && line[5] === 'A') {
      put(col(line, 14, 18).trim(), P.parseLat(col(line, 33, 41)), P.parseLon(col(line, 42, 51)));
    } else if (sec === 'P' && line[5] !== 'N') {
      var id = col(line, 7, 10).trim(), ss = line[12];
      var lat = P.parseLat(col(line, 33, 41)), lon = P.parseLon(col(line, 42, 51));
      if (lat == null) continue;
      if (ss === 'A') { var a = airport(id); a.lat = lat; a.lon = lon; }
      else if (ss === 'C') put(col(line, 14, 18).trim(), lat, lon);
      else if (ss === 'G') {
        var rid = col(line, 14, 18).trim();
        if (/^RW\d\d[LRC]?$/.test(rid)) airport(id).rw[rid] = [lat, lon];
      }
    }
  }
  // an airport with runways but no reference point of its own
  Object.keys(apt).forEach(function (id) {
    var a = apt[id]; if (a.lat != null) return;
    var k = Object.keys(a.rw); if (!k.length) { delete apt[id]; return; }
    a.lat = 0; a.lon = 0; k.forEach(function (r) { a.lat += a.rw[r][0] / k.length; a.lon += a.rw[r][1] / k.length; });
  });
  return { fix: fix, apt: apt };
}

module.exports = { fixes: fixes };
