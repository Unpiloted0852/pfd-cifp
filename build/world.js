/*
 * Points the CIFP doesn't have, for turning filed routes into positions:
 *
 *  - FAA NASR FIX_BASE.csv: every US waypoint (the CIFP lists only those used by
 *    airways and procedures), plus the handful of foreign and oceanic fixes the
 *    FAA keeps. Public domain, same 28-day cycle.
 *  - OurAirports navaids.csv and airports.csv: radio beacons and airports
 *    worldwide. Public domain, updated daily by its community.
 *
 * Published as v1/world.json beside nav.json, which is unchanged:
 *   p: [id, lat, lon, kind(, declination)]  kind W waypoint, V VHF navaid, N NDB
 *   a: [id, lat, lon]                       airports, under each code they go by
 */
'use strict';

/** RFC 4180 CSV -> array of objects keyed by the header row. */
function parseCsv(text) {
  var rows = [], row = [], field = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  var head = rows.shift() || [];
  return rows.map(function (r) {
    var o = {};
    head.forEach(function (h, k) { o[h] = r[k]; });
    return o;
  });
}

function r4(v) { return Math.round(v * 1e4) / 1e4; }

/**
 * @param fixCsv   NASR FIX_BASE.csv text (or null)
 * @param aptCsv   OurAirports airports.csv text (or null)
 * @param navCsv   OurAirports navaids.csv text (or null)
 * @param known    nav.json points already published, [id, lat, lon, ...]
 */
function world(fixCsv, aptCsv, navCsv, known) {
  var have = Object.create(null);
  (known || []).forEach(function (p) { have[p[0] + '|' + Math.round(p[1] * 50) + '|' + Math.round(p[2] * 50)] = 1; });
  function isKnown(id, la, lo) { return have[id + '|' + Math.round(la * 50) + '|' + Math.round(lo * 50)]; }

  var p = [], a = [], stats = { fixes: 0, navaids: 0, airports: 0, airportCodes: 0 };

  if (fixCsv) {
    parseCsv(fixCsv).forEach(function (r) {
      var la = +r.LAT_DECIMAL, lo = +r.LONG_DECIMAL;
      if (!r.FIX_ID || !isFinite(la) || !isFinite(lo) || (la === 0 && lo === 0)) return;
      if (isKnown(r.FIX_ID, la, lo)) return;
      p.push([r.FIX_ID, r4(la), r4(lo), 'W']);
      stats.fixes++;
    });
  }

  if (navCsv) {
    parseCsv(navCsv).forEach(function (r) {
      var la = +r.latitude_deg, lo = +r.longitude_deg, t = r.type || '';
      if (!r.ident || !isFinite(la) || !isFinite(lo) || r.latitude_deg === '') return;
      // US beacons come from the CIFP, which is current; these fill in the rest.
      if (r.iso_country === 'US' || isKnown(r.ident, la, lo)) return;
      var kind = /NDB/.test(t) ? 'N' : 'V';
      var pt = [r.ident, r4(la), r4(lo), kind];
      var dec = r.slaved_variation_deg !== '' ? +r.slaved_variation_deg : +r.magnetic_variation_deg;
      if (kind === 'V' && r.magnetic_variation_deg !== '' && isFinite(dec)) pt.push(Math.round(dec * 10) / 10);
      p.push(pt);
      stats.navaids++;
    });
  }

  if (aptCsv) {
    var skip = { heliport: 1, closed: 1, balloonport: 1 };
    parseCsv(aptCsv).forEach(function (r) {
      if (skip[r.type]) return;
      var la = +r.latitude_deg, lo = +r.longitude_deg;
      if (!isFinite(la) || !isFinite(lo) || r.latitude_deg === '') return;
      var codes = Object.create(null);
      [r.ident, r.gps_code, r.icao_code].forEach(function (c) { if (c && /^[A-Z0-9]{3,4}$/.test(c)) codes[c] = 1; });
      // A US field filed under its FAA code ("17M"), which is its local code.
      if (r.iso_country === 'US' && r.local_code && /^[A-Z0-9]{3,4}$/.test(r.local_code)) codes[r.local_code] = 1;
      var ids = Object.keys(codes);
      if (!ids.length) return;
      stats.airports++;
      ids.forEach(function (id) { a.push([id, r4(la), r4(lo)]); stats.airportCodes++; });
    });
  }
  return { p: p, a: a, stats: stats };
}

module.exports = { world: world, parseCsv: parseCsv };
