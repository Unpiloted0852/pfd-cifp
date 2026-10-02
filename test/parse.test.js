/* parse.test.js — the CIFP reduced to one airport's procedures.
 *
 * The fixture is the real thing: every Portland record from cycle 2610, with
 * the en-route fixes and navaids its procedures refer to. Portland because it
 * has curved RF legs, an ILS, a hold, and procedures that reach out to fixes
 * belonging to no airport — which is every way a fix reference can resolve.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../build/cifp-parse.js');
const B = require('../build/build.js');
const Cy = require('../build/cycle.js');

let failed = 0;
function ok(name, cond, detail, why) {
  if (cond) console.log('  PASS ' + name + (detail ? '  ' + detail : ''));
  else { failed++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '') +
                              (why ? '\n       ' + why : '')); }
}

const FIX = path.join(__dirname, 'fixtures', 'kpdx-2610.txt');
const text = fs.readFileSync(FIX, 'latin1');
const res = P.parse(text);
const pdx = res.airports.KPDX;

console.log('\nfields');
ok('latitude', Math.abs(P.parseLat('N45351935') - 45.588708) < 1e-6);
ok('longitude, west negative', Math.abs(P.parseLon('W122354873') + 122.596869) < 1e-6);
ok('a blank position is null, not zero', P.parseLat('         ') === null && P.parseLon('          ') === null,
   '', 'zero would put the fix in the Gulf of Guinea');
ok('altitude in feet', P.parseAlt('03500') === 3500);
ok('altitude as a flight level', P.parseAlt('FL180') === 18000);
ok('no altitude', P.parseAlt('     ') === null);
ok('variation east positive', P.parseVar('E0160') === 16 && P.parseVar('W0040') === -4);

console.log('\napproach identifiers read as the chart is titled');
[['I10L  ', 'ILS RWY 10L', '10L'], ['H28RY ', 'RNAV (RNP) Y RWY 28R', '28R'],
 ['R10-Y ', 'RNAV (GPS) Y RWY 10', '10'], ['L21   ', 'LOC RWY 21', '21'],
 ['VOR-A ', 'VOR-A', null], ['RNV-B ', 'RNAV (GPS)-B', null], ['B09   ', 'LOC BC RWY 09', '09']
].forEach(c => {
  const n = P.approachName(c[0]);
  ok(c[0].trim(), n.name === c[1] && n.rwy === c[2], n.name);
});

console.log('\nthe file as a whole');
ok('the cycle comes from the header', res.cycle === '2610' && res.effective === '2026-10-01',
   res.cycle + ' ' + res.effective);
ok('the airport is there, with its position and variation',
   pdx && Math.abs(pdx.lat - 45.588708) < 1e-5 && pdx.mv === 16 && pdx.el === 31);
ok('every fix a leg names was found', res.stats.unresolved === 0, res.stats.legs + ' legs');
ok('approaches, SIDs and STARs are all kept', pdx.app.length === 20 && pdx.sid.length > 0 && pdx.star.length > 0,
   pdx.app.length + ' approaches, ' + pdx.sid.length + ' SIDs, ' + pdx.star.length + ' STARs');

console.log('\nrunways');
{
  const r = pdx.rw['10L'];
  ok('threshold elevation and crossing height', r && r.el === 30 && r.tch === 49, JSON.stringify(r));
  ok('keyed without the RW prefix', !('RW10L' in pdx.rw) && '03' in pdx.rw);
}

console.log('\nan RNP approach');
{
  const ap = pdx.app.find(a => a.id === 'H10LZ');
  ok('named and tied to its runway', ap.n === 'RNAV (RNP) Z RWY 10L' && ap.rw === '10L' && ap.ty === 'H');
  const tr = ap.rt.find(r => r.t === 'A' && r.tr === 'CIZZL');
  const fin = ap.rt.find(r => r.t !== 'A');
  ok('transitions and the final are separate routes', !!tr && !!fin && ap.rt.length === 5);
  const name = l => pdx.x[l.f][0];
  ok('legs in order', tr.l.map(name).join(' ') === 'CIZZL DAYSS RIPPP TTIDE');
  const rf = tr.l[2];
  ok('a curved leg keeps its radius, direction and centre',
     rf.p === 'RF' && rf.rad === 2.51 && rf.t === 'L' && pdx.x[rf.cf][0] === 'CFFWG',
     JSON.stringify(rf));
  ok('at or above 3500', rf.ad === '+' && rf.a1 === 3500);
  ok('a speed limit with its sense', tr.l[0].s === 210 && tr.l[0].sl === '-');
  const rwy = fin.l.find(l => l.f != null && name(l) === 'RW10L');
  ok('the runway leg carries the angle and the crossing altitude',
     rwy.va === -3 && rwy.a1 === 79 && rwy.ad === '@' && rwy.r === 'M', JSON.stringify(rwy));
  const after = fin.l[fin.l.indexOf(rwy) + 1];
  ok('the missed approach is marked where it begins', after.m === 1 && after.p === 'CA' && after.f === undefined);
  ok('the level-of-service continuation record is not mistaken for a leg',
     fin.l.filter(l => l.f != null && name(l) === 'BLAZR').length === 1);
}

console.log('\nwhere fixes come from');
{
  const id = s => pdx.x.find(p => p[0] === s);
  ok('a terminal waypoint', !!id('TTIDE'));
  ok('an en-route waypoint', !!id('BATYL'));
  ok('a VOR', !!id('BTG'));
  ok('a runway threshold', !!id('RW10L') && Math.abs(id('RW10L')[1] - pdx.rw['10L'].la) < 1e-9);
  const seen = new Set(pdx.x.map(p => p.join('|')));
  ok('each position is stored once', seen.size === pdx.x.length, pdx.x.length + ' points');
}

console.log('\nthe published tree');
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cifp-'));
  let threw = null;
  try { B.build(FIX, out); } catch (e) { threw = e; }
  ok('a file with one airport in it is refused', threw && /refusing/.test(threw.message),
     threw ? threw.message : 'built anyway',
     'a truncated download must not replace a whole cycle with a fragment');
  ok('and nothing was written', !fs.existsSync(path.join(out, 'v1', 'index.json')));
  const r = B.build(FIX, out, { minAirports: 1 });
  const index = JSON.parse(fs.readFileSync(path.join(out, 'v1', 'index.json'), 'utf8'));
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'v1', 'apt', 'KPDX.json'), 'utf8'));
  ok('the index names the cycle and when it lapses',
     index.v === 1 && index.cycle === '2610' && index.effective === '2026-10-01' && index.expires === '2026-10-29');
  ok('and lists each airport with its position',
     index.apt.length === 1 && index.apt[0][0] === 'KPDX' && Math.abs(index.apt[0][1] - 45.589) < 1e-9);
  ok('the airport file is stamped with its cycle', doc.v === 1 && doc.c === '2610' && doc.id === 'KPDX');
  ok('and is small', r.bytes < 40000, r.bytes + ' bytes');
  ok('with no private working fields left in it', !('_pi' in doc) && !/"icao"/.test(JSON.stringify(doc)));
  fs.rmSync(out, { recursive: true, force: true });
}

console.log('\nwhich cycle is in force');
ok('on the day it starts', Cy.effectiveOn('2026-10-01') === '2026-10-01');
ok('on its last day', Cy.effectiveOn('2026-10-28') === '2026-10-01');
ok('the next one the day after', Cy.effectiveOn('2026-10-29') === '2026-10-29');
ok('the day before belongs to the previous cycle', Cy.effectiveOn('2026-09-30') === '2026-09-03');
ok('a year on, still on the 28-day grid', Cy.effectiveOn('2027-10-01') === '2027-09-30');
ok('the file is named for its effective date',
   Cy.urlFor('2026-10-01') === 'https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_261001.zip');

console.log(failed ? `\n${failed} FAILED\n` : '\nall parse checks passed\n');
process.exit(failed ? 1 : 0);
