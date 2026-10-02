#!/usr/bin/env node
/*
 * Which CIFP cycle is in force today, and where the FAA keeps it.
 *
 *   node build/cycle.js            -> prints the effective date and the URL
 *   node build/cycle.js 2026-11-03 -> the same for another day
 *
 * Cycles are 28 days long and have been since long before this was written,
 * so the whole calendar follows from one known date. The FAA names each file
 * by the day it comes into force: CIFP_261001.zip took effect on 1 October
 * 2026. The cycle NUMBER is not computed here — the file states its own in
 * its header, and that is the one that gets published.
 */
'use strict';

var EPOCH = '2026-10-01';             // cycle 2610, a known effective date
var DAYS = 28;
var URL = 'https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_{YYMMDD}.zip';

/** The effective date (YYYY-MM-DD) of the cycle in force on `iso`. */
function effectiveOn(iso) {
  var day = 86400000;
  var t = Date.parse(iso + 'T00:00:00Z'), e = Date.parse(EPOCH + 'T00:00:00Z');
  if (isNaN(t)) throw new Error('not a date: ' + iso);
  // floor, not round: the day before a cycle starts belongs to the one before.
  var n = Math.floor((t - e) / (DAYS * day));
  return new Date(e + n * DAYS * day).toISOString().slice(0, 10);
}

function urlFor(effective) {
  return URL.replace('{YYMMDD}', effective.slice(2, 4) + effective.slice(5, 7) + effective.slice(8, 10));
}

if (require.main === module) {
  var today = process.argv[2] || new Date().toISOString().slice(0, 10);
  var eff = effectiveOn(today);
  console.log(eff + ' ' + urlFor(eff));
}

module.exports = { effectiveOn: effectiveOn, urlFor: urlFor, EPOCH: EPOCH };
