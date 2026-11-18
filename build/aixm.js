/*
 * Waypoints, navaids and airways from AIXM 5.1 data sets, such as Germany's
 * (DFS, https://aip.dfs.de/datasets/, CC BY 4.0).
 *
 * Only what route expansion needs is kept: each point's designator and
 * position, and each airway as segments between named points. Features are
 * found by their XML blocks; nothing else in the files is read.
 */
'use strict';

function blocks(xml, tag) {
  var out = [], open = '<aixm:' + tag + ' ', close = '</aixm:' + tag + '>', i = 0;
  for (;;) {
    var a = xml.indexOf(open, i);
    if (a < 0) break;
    var b = xml.indexOf(close, a);
    if (b < 0) break;
    out.push(xml.substring(a, b));
    i = b + close.length;
  }
  return out;
}

function text(blk, tag) {
  var m = new RegExp('<aixm:' + tag + '>([^<]*)</aixm:' + tag + '>').exec(blk);
  return m ? m[1].trim() : '';
}

function uuid(blk) {
  var m = /<gml:identifier[^>]*>([^<]+)</.exec(blk);
  return m ? m[1].trim() : null;
}

function pos(blk) {
  var m = /<gml:pos[^>]*>\s*([-\d.]+)\s+([-\d.]+)/.exec(blk);
  return m ? [+m[1], +m[2]] : null;
}

function href(blk, tag) {
  var m = new RegExp('<aixm:' + tag + '[^>]*xlink:href="urn:uuid:([^"]+)"').exec(blk);
  return m ? m[1] : null;
}

function r4(v) { return Math.round(v * 1e4) / 1e4; }

/**
 * @param xmls  the data set files' text (any mix: waypoints, navaids, routes)
 * @returns { p: [[id, lat, lon, kind]], s: [[airway, id, lat, lon, id, lat, lon]] }
 */
function extract(xmls) {
  var pts = Object.create(null);           // uuid -> [id, lat, lon, kind]
  var routes = Object.create(null);        // uuid -> name
  var segs = [];
  xmls.forEach(function (xml) {
    blocks(xml, 'DesignatedPoint').forEach(function (b) {
      var u = uuid(b), id = text(b, 'designator'), p = pos(b);
      if (u && id && p) pts[u] = [id, r4(p[0]), r4(p[1]), 'W'];
    });
    blocks(xml, 'Navaid').forEach(function (b) {
      var u = uuid(b), id = text(b, 'designator'), p = pos(b), t = text(b, 'type');
      if (!u || !id || !p || /^(ILS|LOC|MKR|DME)/.test(t) && !/VOR|TACAN/.test(t)) return;
      pts[u] = [id, r4(p[0]), r4(p[1]), /NDB/.test(t) ? 'N' : 'V'];
    });
    blocks(xml, 'Route').forEach(function (b) {
      var u = uuid(b);
      var name = text(b, 'designatorPrefix') + text(b, 'designatorSecondLetter') + text(b, 'designatorNumber') +
        text(b, 'multipleIdentifier');
      if (u && name) routes[u] = name;
    });
    blocks(xml, 'RouteSegment').forEach(function (b) {
      var st = b.indexOf('<aixm:start>'), en = b.indexOf('<aixm:end>');
      if (st < 0 || en < 0) return;
      var sb = b.substring(st, b.indexOf('</aixm:start>', st)), eb = b.substring(en, b.indexOf('</aixm:end>', en));
      var from = href(sb, 'pointChoice_fixDesignatedPoint') || href(sb, 'pointChoice_navaidSystem');
      var to = href(eb, 'pointChoice_fixDesignatedPoint') || href(eb, 'pointChoice_navaidSystem');
      var route = href(b, 'routeFormed');
      if (from && to && route) segs.push([route, from, to]);
    });
  });
  var p = Object.keys(pts).map(function (u) { return pts[u]; });
  var s = [];
  segs.forEach(function (x) {
    var name = routes[x[0]], a = pts[x[1]], b = pts[x[2]];
    if (name && a && b) s.push([name, a[0], a[1], a[2], b[0], b[1], b[2]]);
  });
  return { p: p, s: s };
}

module.exports = { extract: extract };
