/*
 * FAA CIFP (ARINC 424-18) -> one small JSON document per airport.
 *
 * The CIFP is a single fixed-width file of 132-column records, about 53 MB.
 * A browser extension wants none of that: it wants the procedures of the one
 * airport an aircraft is near, with every fix already resolved to a position.
 * This module does that reduction and nothing else — no network, no files —
 * so the whole of it can be tested on a few lines of text.
 *
 * Columns below are 1-based, as the ARINC specification and the FAA's own
 * readme give them. `col(line, from, to)` takes them in that form so the
 * numbers in this file can be checked against the document directly.
 *
 * What is kept: airports, runways, and SID / STAR / approach legs.
 * What is dropped: heliports, airways, airspace, MSAs, and the SBAS path
 * points — the final leg already carries the angle and crossing altitude.
 */
'use strict';

function col(line, from, to) { return line.substring(from - 1, to); }

/** "N45351935" -> 45.588708, "W122354873" -> -122.596869. Null if blank. */
function parseLat(s) {
  if (!/^[NS]\d{8}$/.test(s)) return null;
  var v = +s.substr(1, 2) + +s.substr(3, 2) / 60 + +s.substr(5, 4) / 100 / 3600;
  return s[0] === 'S' ? -v : v;
}
function parseLon(s) {
  if (!/^[EW]\d{9}$/.test(s)) return null;
  var v = +s.substr(1, 3) + +s.substr(4, 2) / 60 + +s.substr(6, 4) / 100 / 3600;
  return s[0] === 'W' ? -v : v;
}
function round6(v) { return Math.round(v * 1e6) / 1e6; }

/** "03500" -> 3500, "FL180" -> 18000, blank or unknown -> null. */
function parseAlt(s) {
  s = s.trim();
  if (!s) return null;
  if (/^FL\d{3}$/.test(s)) return +s.substr(2) * 100;
  if (/^-?\d+$/.test(s)) return +s;
  return null;
}

/** "E0160" -> 16 (east positive), "W0040" -> -4. */
function parseVar(s) {
  if (!/^[EW]\d{4}$/.test(s)) return null;
  var v = +s.substr(1) / 10;
  return s[0] === 'W' ? -v : v;
}

/** A numeric field with an implied decimal point; null when blank. */
function parseScaled(s, div) {
  s = s.trim();
  if (!/^-?\d+$/.test(s)) return null;
  return +s / div;
}

var APPROACH_TYPES = {
  B: 'LOC BC', D: 'VOR/DME', F: 'FMS', G: 'IGS', H: 'RNAV (RNP)', I: 'ILS',
  J: 'GLS', L: 'LOC', M: 'MLS', N: 'NDB', P: 'GPS', Q: 'NDB/DME',
  R: 'RNAV (GPS)', S: 'VOR', T: 'TACAN', U: 'SDF', V: 'VOR', X: 'LDA'
};

/*
 * The six-character approach identifier, read the way the chart title reads.
 *
 *   "I10L  " -> ILS RWY 10L            "H28RY " -> RNAV (RNP) Y RWY 28R
 *   "R10-Y " -> RNAV (GPS) Y RWY 10    "VOR-A " -> VOR-A (circling, no runway)
 *
 * S and V are both VOR approaches; S is the one that needs DME, which the
 * title on the chart does not always say, so both read "VOR" here.
 */
function approachName(id) {
  id = id.replace(/\s+$/, '');
  var m = /^([A-Z])(\d\d)([LRC-]?)([A-Z]?)$/.exec(id);
  if (m) {
    var rwy = m[2] + (m[3] && m[3] !== '-' ? m[3] : '');
    return { name: (APPROACH_TYPES[m[1]] || m[1]) + (m[4] ? ' ' + m[4] : '') + ' RWY ' + rwy,
             type: m[1], rwy: rwy };
  }
  // Circling procedures: "VOR-A", "RNV-B", "VDM-A", "NDB-C", "LOC-D" ...
  var c = /^([A-Z]{3})-?([A-Z])$/.exec(id);
  if (c) {
    var kind = { RNV: 'RNAV (GPS)', VDM: 'VOR/DME', LBC: 'LOC BC', GPS: 'GPS',
                 VOR: 'VOR', NDB: 'NDB', LOC: 'LOC', LDA: 'LDA', TAC: 'TACAN',
                 SDF: 'SDF', NDM: 'NDB/DME' }[c[1]] || c[1];
    return { name: kind + '-' + c[2], type: c[1][0], rwy: null };
  }
  return { name: id, type: id[0] || '', rwy: null };
}

/*
 * One procedure leg, from a primary record.
 *
 * Only what something downstream can use is kept, and absent fields are left
 * off entirely rather than written as null: there are a quarter of a million
 * legs, and most have five or six of these twenty fields.
 */
function parseLeg(line) {
  var leg = { p: col(line, 48, 49) };
  var fix = col(line, 30, 34).trim();
  if (fix) {
    leg.fix = { id: fix, icao: col(line, 35, 36), sec: col(line, 37, 38) };
  }
  var desc = col(line, 40, 43);
  if (desc[1] === 'Y' || desc[1] === 'B') leg.fo = 1;          // fly-over
  if (desc[2] === 'M') leg.m = 1;                              // first leg of the missed approach
  if (desc[2] === 'S' || desc[2] === 'A' || desc[2] === 'B') leg.sd = 1;   // step-down fix
  if (desc[3] !== ' ') leg.r = desc[3];                        // A IAF, B IF, F FAF, M MAP, ...
  var turn = col(line, 44, 44);
  if (turn === 'L' || turn === 'R') leg.t = turn;

  var nav = col(line, 51, 54).trim();
  if (nav) leg.nav = { id: nav, icao: col(line, 55, 56), sec: col(line, 79, 80) };
  var radius = parseScaled(col(line, 57, 62), 1000);
  if (radius != null) leg.rad = radius;
  var theta = parseScaled(col(line, 63, 66), 10);
  if (theta != null) leg.th = theta;
  var rho = parseScaled(col(line, 67, 70), 10);
  if (rho != null) leg.rho = rho;

  // Course is magnetic unless the fourth character is T.
  var crs = col(line, 71, 74);
  if (/^\d{3}T$/.test(crs)) { leg.c = +crs.substr(0, 3); leg.ct = 1; }
  else if (/^\d{4}$/.test(crs)) leg.c = +crs / 10;

  // Distance in tenths of a mile, or a holding time written "T010".
  var dist = col(line, 75, 78);
  if (/^\d{4}$/.test(dist)) leg.d = +dist / 10;
  else if (/^T\d{3}$/.test(dist)) leg.tm = +dist.substr(1) / 10;

  var ad = col(line, 83, 83), a1 = parseAlt(col(line, 85, 89)), a2 = parseAlt(col(line, 90, 94));
  if (a1 != null) {
    leg.a1 = a1;
    // A blank description with an altitude means AT that altitude.
    leg.ad = (ad === ' ') ? '@' : ad;
  }
  if (a2 != null) leg.a2 = a2;
  var spd = parseScaled(col(line, 100, 102), 1);
  if (spd != null) {
    leg.s = spd;
    var sd = col(line, 118, 118);
    if (sd === '+' || sd === '-') leg.sl = sd;
  }
  var va = col(line, 103, 106);
  if (/^-\d{3}$/.test(va)) leg.va = +va / 100;

  var centre = col(line, 107, 111).trim();
  // The same columns carry the TAA sector on an IF, where it is not a fix.
  if (centre && (leg.p === 'RF' || leg.p === 'AF')) {
    leg.cen = { id: centre, icao: col(line, 113, 114), sec: col(line, 115, 116) };
  }
  return leg;
}

/**
 * Parse the whole file.
 *
 * Two passes over the lines, because a procedure refers to fixes that may be
 * anywhere in the file: the first collects every position, the second walks
 * the procedures and resolves against it.
 */
function parse(text) {
  var lines = text.split(/\r?\n/);
  var cycle = null, effective = null;
  var fixes = Object.create(null);       // "sec|icao|airport|id" -> [lat, lon]
  var airports = Object.create(null);
  var i, line;

  function putFix(sec, icao, apt, id, lat, lon) {
    if (lat == null || lon == null) return;
    fixes[sec + '|' + icao + '|' + apt + '|' + id] = [round6(lat), round6(lon)];
  }

  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line.length < 132) {
      // Header lines are short of nothing; anything else this length is not a
      // record this parser understands.
      if (line.substr(0, 3) !== 'HDR') continue;
    }
    if (line.substr(0, 5) === 'HDR04') {
      var h = /VOLUME (\d{4})\s+EFFECTIVE (\d{2}) ([A-Z]{3}) (\d{4})/.exec(line);
      if (h) {
        cycle = h[1];
        var mon = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(h[3]) / 3 + 1;
        effective = h[4] + '-' + (mon < 10 ? '0' : '') + mon + '-' + h[2];
      }
      continue;
    }
    if (line[0] !== 'S') continue;
    var sec = line[4];
    // Only primary records carry a position; continuations repeat the key.
    if (sec === 'D') {
      if (col(line, 22, 22) > '1') continue;
      var sub = line[5];
      var nid = col(line, 14, 17).trim(), nicao = col(line, 20, 21);
      var la = parseLat(col(line, 33, 41)), lo = parseLon(col(line, 42, 51));
      if (sub === ' ' && la == null) {            // DME or TACAN only
        la = parseLat(col(line, 56, 64)); lo = parseLon(col(line, 65, 74));
      }
      putFix(sub === 'B' ? 'DB' : 'D ', nicao, '', nid, la, lo);
    } else if (sec === 'E' && line[5] === 'A') {
      if (col(line, 22, 22) > '1') continue;
      putFix('EA', col(line, 20, 21), '', col(line, 14, 18).trim(),
             parseLat(col(line, 33, 41)), parseLon(col(line, 42, 51)));
    } else if (sec === 'P' && line[5] === 'N') {
      // Terminal NDBs keep their subsection in column 6, unlike every other
      // airport record, with the identifier where a navaid's would be.
      if (col(line, 22, 22) > '1') continue;
      putFix('PN', col(line, 20, 21), col(line, 7, 10).trim(), col(line, 14, 17).trim(),
             parseLat(col(line, 33, 41)), parseLon(col(line, 42, 51)));
    } else if (sec === 'P') {
      var apt = col(line, 7, 10).trim(), aicao = col(line, 11, 12), ss = line[12];
      if (ss === 'A') {
        if (col(line, 22, 22) > '1') continue;
        var alat = parseLat(col(line, 33, 41)), alon = parseLon(col(line, 42, 51));
        if (alat == null) continue;
        airports[apt] = { id: apt, icao: aicao, lat: round6(alat), lon: round6(alon),
                          mv: parseVar(col(line, 52, 56)), el: parseAlt(col(line, 57, 61)),
                          rw: {}, app: [], sid: [], star: [] };
        putFix('PA', aicao, apt, apt, alat, alon);
      } else if (ss === 'C') {
        if (col(line, 22, 22) > '1') continue;
        putFix('PC', col(line, 20, 21), apt, col(line, 14, 18).trim(),
               parseLat(col(line, 33, 41)), parseLon(col(line, 42, 51)));
      } else if (ss === 'G') {
        if (col(line, 22, 22) > '1') continue;
        var rid = col(line, 14, 18).trim();
        var rla = parseLat(col(line, 33, 41)), rlo = parseLon(col(line, 42, 51));
        putFix('PG', aicao, apt, rid, rla, rlo);
        if (airports[apt] && rla != null) {
          var rw = { la: round6(rla), lo: round6(rlo) };
          var brg = col(line, 28, 31);
          if (/^\d{4}$/.test(brg)) rw.b = +brg / 10;
          var thr = parseAlt(col(line, 67, 71)), tch = parseScaled(col(line, 76, 77), 1);
          if (thr != null) rw.el = thr;
          if (tch != null && tch > 0) rw.tch = tch;
          airports[apt].rw[rid.replace(/^RW/, '')] = rw;
        }
      }
    }
  }

  /*
   * A fix is named by identifier, region and section — and, for the sections
   * that belong to an airport, by which airport. Terminal waypoints reuse
   * identifiers freely between fields, so the airport is not optional there.
   */
  function locate(ref, apt) {
    if (!ref) return null;
    var terminal = (ref.sec[0] === 'P');
    var hit = fixes[ref.sec + '|' + ref.icao + '|' + (terminal ? apt : '') + '|' + ref.id];
    return hit || null;
  }

  var stats = { legs: 0, unresolved: 0, airports: 0, procedures: 0 };

  for (i = 0; i < lines.length; i++) {
    line = lines[i];
    if (line.length < 132 || line[0] !== 'S' || line[4] !== 'P') continue;
    var kind = line[12];
    if (kind !== 'D' && kind !== 'E' && kind !== 'F') continue;
    // Continuation records carry the level of service and the like.
    if (col(line, 39, 39) > '1') continue;
    var a = airports[col(line, 7, 10).trim()];
    if (!a) continue;

    var procId = col(line, 14, 19).trim();
    var routeType = col(line, 20, 20);
    var trans = col(line, 21, 25).trim();
    var list = kind === 'F' ? a.app : kind === 'D' ? a.sid : a.star;

    var proc = list.length && list[list.length - 1].id === procId ? list[list.length - 1] : null;
    if (!proc) {
      // Records for one procedure are contiguous, but look back anyway: a
      // second object for the same procedure would silently hide its routes.
      for (var k = 0; k < list.length; k++) if (list[k].id === procId) { proc = list[k]; break; }
    }
    if (!proc) {
      proc = { id: procId, rt: [] };
      if (kind === 'F') {
        var nm = approachName(procId);
        proc.n = nm.name; proc.ty = nm.type;
        if (nm.rwy) proc.rw = nm.rwy;
      }
      list.push(proc);
      stats.procedures++;
    }
    var route = proc.rt.length ? proc.rt[proc.rt.length - 1] : null;
    if (!route || route.t !== routeType || route.tr !== trans) {
      route = { t: routeType, tr: trans, l: [] };
      proc.rt.push(route);
    }

    var leg = parseLeg(line);
    stats.legs++;
    // Resolve the three fix references to indices into the airport's own
    // point table, so the published file carries each position once.
    ['fix', 'nav', 'cen'].forEach(function (key) {
      var ref = leg[key];
      if (!ref) return;
      delete leg[key];
      var pos = locate(ref, a.id);
      if (!pos) { if (key === 'fix') { stats.unresolved++; leg.u = ref.id; } return; }
      var pk = ref.id + '|' + pos[0] + '|' + pos[1];
      a._pi = a._pi || Object.create(null);
      a.x = a.x || [];
      if (!(pk in a._pi)) { a._pi[pk] = a.x.length; a.x.push([ref.id, pos[0], pos[1]]); }
      leg[key === 'fix' ? 'f' : key === 'nav' ? 'n' : 'cf'] = a._pi[pk];
    });
    route.l.push(leg);
  }

  var out = Object.create(null);
  Object.keys(airports).forEach(function (id) {
    var ap = airports[id];
    delete ap._pi;
    if (!ap.app.length && !ap.sid.length && !ap.star.length) return;
    out[id] = ap;
    stats.airports++;
  });
  return { cycle: cycle, effective: effective, airports: out, stats: stats };
}

module.exports = {
  parse: parse, parseLeg: parseLeg, parseLat: parseLat, parseLon: parseLon,
  parseAlt: parseAlt, parseVar: parseVar, approachName: approachName, col: col
};
