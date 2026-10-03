/* airspace.test.js — Class B, C and D outlines out of the CIFP's UC records.
 *
 * The fixture is real: from cycle 2610, Travis (a circle), Boise (a ring cut
 * by arcs both ways, in four pieces), Abbotsford (rhumb lines and an arc, two
 * pieces) and the first two pieces of San Francisco's Class B.
 */
'use strict';
const fs = require('fs'), path = require('path');
const A = require('../build/airspace.js');
let failed = 0;
function ok(name, cond, detail) { console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  ' + detail : '')); if (!cond) failed++; }
const air = A.airspace(fs.readFileSync(path.join(__dirname, 'fixtures', 'airspace-2610.txt'), 'latin1'));
const nm = (a, b) => Math.hypot((a[0] - b[0]) * 60, (a[1] - b[1]) * 60 * Math.cos(a[0] * Math.PI / 180));
const by = n => air.filter(x => x.n === n);

console.log('\nwhat is read');
ok('every piece in the fixture', air.length === 9, air.map(x => x.c + ' ' + x.n).join(', '));
ok('type T is Class B, A is Class C, Z is Class D', by('SAN FRANCISCO AREA A')[0].c === 'B' && by('BOISE').every(x => x.c === 'C') && by('FAIRFIELD')[0].c === 'D');
ok('every outline is closed', air.every(x => x.p.length >= 4 && x.p[0][0] === x.p[x.p.length - 1][0] && x.p[0][1] === x.p[x.p.length - 1][1]));

console.log('\nfloors and ceilings');
const suu = by('FAIRFIELD')[0], sfoA = by('SAN FRANCISCO AREA A')[0], sfoB = by('SAN FRANCISCO AREA B')[0];
ok('GND is the ground', suu.lo === 0 && suu.loRef === 'A');
ok('a ceiling in feet above sea level', suu.hi === 2600 && suu.hiRef === 'M');
ok('each layer of a Class B has its own floor', sfoA.lo === 0 && sfoB.lo === 1500 && sfoB.loRef === 'M' && sfoA.hi === 10000 && sfoB.hi === 10000);
ok('a flight level is feet', A.limit('FL180', 'M').ft === 18000);
ok('no limit is no limit', A.limit('UNLTD', 'M') === null && A.limit('     ', ' ') === null);

console.log('\nshapes');
const ctr = [38 + 15 / 60 + 46 / 3600, -(121 + 55 / 60 + 39 / 3600)];
const rs = suu.p.map(p => nm(ctr, p));
ok('a circle is a circle of the radius given', Math.max(...rs) < 4.32 && Math.min(...rs) > 4.28, Math.min(...rs).toFixed(2) + ' to ' + Math.max(...rs).toFixed(2) + ' nm, published 4.3');
const boi = by('BOISE'), boiC = [43 + 33 / 60 + 51.70 / 3600, -(116 + 13 / 60 + 22.30 / 3600)];
ok('Boise is a core and shelves above it', boi.length === 4 && boi[0].lo === 0 && boi.slice(1).every(x => x.lo > 0) && boi[1].lo === 4600, boi.map(x => x.lo).join(', '));
const core = boi[0].p.map(p => nm(boiC, p)), shelf = boi[1].p.map(p => nm(boiC, p));
ok('the core is the five-mile circle', Math.max(...core) < 5.05 && Math.min(...core) > 4.95);
ok('the shelf lies between the five- and ten-mile rings, arcs and all', Math.max(...shelf) < 10.1 && Math.min(...shelf) > 4.9, Math.min(...shelf).toFixed(2) + ' to ' + Math.max(...shelf).toFixed(2) + ' nm');
ok('and its arcs are walked, not cut across', boi[1].p.length > 30, boi[1].p.length + ' points');
ok('both ways round: some of it on each ring', shelf.filter(d => d > 9.9).length > 5 && shelf.filter(d => d < 5.1).length > 5);
const yxx = by('LYNDEN - ABBOTSFORD')[0];   // the first of its two pieces
ok('an outline of lines and one arc', !!yxx && yxx.p.length > 6 && yxx.p.length < 40, yxx ? yxx.p.length + ' points' : '');
ok('nothing strays from where it began', air.every(x => x.p.every(p => nm(x.p[0], p) < 40)));

console.log('\nspecial use airspace');
// Real records again: Alert Area 680 (a circle), Boardman MOA, Prohibited
// Areas 40 and 56 (two pieces), Restricted 6714H (cut by an arc), Warning 237A.
const sua = A.sua(fs.readFileSync(path.join(__dirname, 'fixtures', 'sua-2610.txt'), 'latin1'));
const kind = k => sua.filter(x => x.c === k);
ok('every piece in the fixture', sua.length === 7, sua.map(x => x.c + ' ' + x.n).join(', '));
ok('each kind is told apart', kind('A').length === 1 && kind('M').length === 1 && kind('P').length === 3 && kind('R').length === 1 && kind('W').length === 1);
ok('they go by their names', kind('M')[0].n === 'BOARDMAN MOA' && kind('A')[0].n === 'A-680' && kind('R')[0].n === 'R-6714H');
ok('a continuation record is not a point on the edge', kind('M')[0].p.every(p => p[0] > 45 && p[0] < 46.5));
ok('floors and ceilings', kind('M')[0].lo === 4000 && kind('M')[0].hi === 17999 && kind('A')[0].lo === 0 && kind('A')[0].loRef === 'A' && kind('A')[0].hi === 3000);
ok('every outline is closed', sua.every(x => x.p.length >= 4 && x.p[0][0] === x.p[x.p.length - 1][0] && x.p[0][1] === x.p[x.p.length - 1][1]));
const a680 = kind('A')[0], c680 = [48 + 10 / 60 + 59 / 3600, -(122 + 38 / 60 + 5 / 3600)], r680 = a680.p.map(p => nm(c680, p));
ok('a circle is a circle', Math.max(...r680) < 3.02 && Math.min(...r680) > 2.98, 'published 3.0 nm');
ok('an arc is walked', kind('R')[0].p.length > 12, kind('R')[0].p.length + ' points');
ok('controlled airspace is not in it, nor it in controlled airspace', !sua.some(x => /^[BCD]$/.test(x.c)) && !air.some(x => /^[PRWMAU]$/.test(x.c) && x.c !== 'B' && x.c !== 'C' && x.c !== 'D'));

console.log(failed ? '\n' + failed + ' FAILED\n' : '\nall airspace checks passed\n');
process.exit(failed ? 1 : 0);
