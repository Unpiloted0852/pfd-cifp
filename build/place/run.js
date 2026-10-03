#!/usr/bin/env node
/*
 * Place every chart that carries no georeferencing, and publish where.
 *
 *   node build/place/run.js --cifp work/FAACIFP18 --meta work/meta.xml --out out
 *        [--pdf work/pdf] [--jobs 4] [--only KSUU,KLSV] [--validate KDEN,KORD] [--names ocr]
 *
 * Writes <out>/v1/place/index.json: the chart cycle and, for each chart
 * placed, the four corners of its page and the part of it that is the map.
 *
 * ONLY charts that carry no georeferencing are touched: the Department of
 * Defense's plates and the charted visual procedures (dtpp.js picks them
 * from the list; place.js looks inside each and leaves it alone if it turns
 * out to be georeferenced after all).
 *
 * --validate does the same work on charts that ARE georeferenced, at the
 * airports named, and reports how far each placement is from the truth
 * instead of publishing anything. It is how every number in the README was
 * measured. It is run by hand; the workflow never does.
 *
 * One chart takes about fifteen seconds, nearly all of it Tesseract, so the
 * list is dealt out to --jobs copies of this script.
 */
'use strict';
var fs = require('fs'), path = require('path'), cp = require('child_process');
var D = require('./dtpp.js'), F = require('./fixes.js');

var HOST = 'https://aeronav.faa.gov/d-tpp/';
var FORMAT = 1;

function args() {
  var a = process.argv.slice(2), o = {};
  for (var i = 0; i < a.length; i++) if (a[i].slice(0, 2) === '--') o[a[i].slice(2)] = (a[i + 1] && a[i + 1].slice(0, 2) !== '--') ? a[++i] : true;
  return o;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* One chart's PDF, from the cache or the FAA. */
function pdfBytes(cycle, pdf, dir) {
  var f = path.join(dir, pdf);
  if (fs.existsSync(f) && fs.statSync(f).size > 1000) return Promise.resolve(new Uint8Array(fs.readFileSync(f)));
  var url = HOST + cycle + '/' + pdf, tries = 0;
  function go() {
    return fetch(url, { headers: { 'User-Agent': 'pfd-cifp build (github.com/Unpiloted0852/pfd-cifp)' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (b) {
      var u = new Uint8Array(b);
      if (u.length < 1000 || String.fromCharCode(u[0], u[1], u[2], u[3]) !== '%PDF') throw new Error('not a PDF');
      fs.writeFileSync(f, u); return u;
    }).catch(function (e) {
      if (++tries >= 4) throw new Error(pdf + ': ' + e.message);
      return sleep(3000 * tries).then(go);
    });
  }
  return go();
}

function shard(o) {
  var P = require('./place.js');
  var work = JSON.parse(fs.readFileSync(o.shard, 'utf8'));
  var fx = F.fixes(fs.readFileSync(o.cifp, 'latin1'));
  var out = [], i = 0;
  function next() {
    if (i >= work.list.length) { fs.writeFileSync(o.shard + '.out', JSON.stringify(out)); return Promise.resolve(); }
    var c = work.list[i++], t0 = Date.now();
    var apt = fx.apt[c.id] || null;
    return pdfBytes(work.cycle, c.pdf, work.pdfDir).then(function (bytes) {
      return P.placeChart(bytes, { fix: fx.fix, apt: apt }, { anyway: !!work.validate, names: work.names,
        ocrCache: work.ocrDir ? path.join(work.ocrDir, c.pdf.replace(/\.pdf$/, '') + '.json') : null });
    }).then(function (r) {
      var row = { id: c.id, name: c.name, pdf: c.pdf, ok: r.ok, why: r.why, geo: !!r.geo, n: r.n, n2: r.n2, rival: r.rival, nSym: r.nSym, line: r.line, fixes: r.fixes, names: r.names,
                  rmsPt: r.rmsPt, nw: r.nw, aptIn: r.aptIn, corners: r.corners, w: r.w, h: r.h, box: r.box, ms: Date.now() - t0 };
      if (work.validate && r.info && r.info.ok) {
        row.truth = true;
        if (r.ok) {
          var pr = P.G.place(r.info), af = P.G.affine(r.info), worst = 0;
          for (var k = 0; k < 4; k++) { var g = P.FX.toGround(r.sim, r.info.quadPdf[k][0], r.info.quadPdf[k][1]); worst = Math.max(worst, P.distNm(g.lat, g.lon, r.info.gpts[k][1], r.info.gpts[k][0])); }
          row.cornerNm = worst;
          var q = pr.proj.forward(r.ref[1], r.ref[0]), pg = af.inverse(q[0], q[1]), g0 = P.FX.toGround(r.sim, pg[0], pg[1]);
          row.aptNm = P.distNm(g0.lat, g0.lon, r.ref[0], r.ref[1]);
        }
      }
      out.push(row);
    }).catch(function (e) {
      out.push({ id: c.id, name: c.name, pdf: c.pdf, ok: false, why: 'failed: ' + (e && e.message || e), failed: true });
    }).then(next);
  }
  return next();
}

function main() {
  var o = args();
  if (o.shard) return shard(o);
  if (!o.cifp || !o.meta || !(o.out || o.validate)) { console.error('usage: run.js --cifp FAACIFP18 --meta d-TPP_Metafile.xml --out DIR [--pdf DIR] [--jobs N] [--only A,B] [--validate A,B]'); process.exit(2); }
  var meta = D.charts(fs.readFileSync(o.meta, 'utf8'));
  if (!meta.cycle) throw new Error('the chart list does not say which cycle it is');
  var list;
  if (o.validate) {
    var want = String(o.validate).toUpperCase().split(',');
    list = meta.list.filter(function (c) { return want.indexOf(c.id) >= 0 && c.mil === 'N' && c.civil === 'C' && !/\bCONT\.\s*\d|\bVISUAL\b/.test(c.name); });
  } else {
    list = D.candidates(meta.list);
    if (o.only) { var only = String(o.only).toUpperCase().split(','); list = list.filter(function (c) { return only.indexOf(c.id) >= 0; }); }
  }
  // one file is one chart, however many airports list it
  var seen = Object.create(null);
  list = list.filter(function (c) { var k = c.id + '/' + c.pdf; if (seen[k]) return false; seen[k] = 1; return true; });
  var pdfDir = o.pdf || 'work/pdf', jobs = Math.max(1, +o.jobs || require('os').cpus().length);
  fs.mkdirSync(pdfDir, { recursive: true });
  if (o.ocr) fs.mkdirSync(o.ocr, { recursive: true });
  var tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'place-run-'));
  console.log('cycle ' + meta.cycle + ': ' + list.length + ' charts to look at, ' + jobs + ' at a time');
  var kids = [];
  for (var j = 0; j < jobs; j++) {
    var mine = list.filter(function (c, i) { return i % jobs === j; });
    if (!mine.length) continue;
    var f = path.join(tmp, 'shard-' + j + '.json');
    fs.writeFileSync(f, JSON.stringify({ cycle: meta.cycle, pdfDir: pdfDir, ocrDir: o.ocr || null, validate: !!o.validate, names: o.names || null, list: mine }));
    kids.push(new Promise(function (resolve, reject) {
      var file = f;
      cp.spawn(process.execPath, [__filename, '--shard', file, '--cifp', o.cifp], { stdio: ['ignore', 'inherit', 'inherit'] })
        .on('exit', function (code) { if (code === 0 && fs.existsSync(file + '.out')) resolve(JSON.parse(fs.readFileSync(file + '.out', 'utf8'))); else reject(new Error('a worker stopped with code ' + code)); });
    }));
  }
  return Promise.all(kids).then(function (parts) {
    var rows = [].concat.apply([], parts);
    rows.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : 1; });
    if (o.rows) fs.writeFileSync(o.rows, JSON.stringify(rows, null, 1));
    if (o.validate) return report(rows, o);
    publish(rows, meta.cycle, o.out);
  });
}

function publish(rows, cycle, outDir) {
  var dir = path.join(outDir, 'v' + FORMAT, 'place');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  var charts = {}, apts = Object.create(null), n = { looked: rows.length, georeferenced: 0, placed: 0, failed: 0 }, why = Object.create(null);
  rows.forEach(function (r) {
    if (r.geo) { n.georeferenced++; return; }
    if (r.failed) n.failed++;
    if (!r.ok) { var k = String(r.why).replace(/\d+/g, 'N'); why[k] = (why[k] || 0) + 1; return; }
    n.placed++; apts[r.id] = 1;
    var e = { c: r.corners, w: r.w, h: r.h, n: r.n };
    if (r.box) e.box = r.box;
    charts[r.pdf] = e;
  });
  // One file for the country: a few hundred charts at a hundred and fifty
  // bytes each. The extension reads it once and never has to ask by airport.
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: FORMAT, cycle: cycle, built: new Date().toISOString(), n: n, charts: charts }));
  var need = n.looked - n.georeferenced;
  console.log('charts with no georeferencing: ' + need + '; placed ' + n.placed + ' (' + Math.round(100 * n.placed / Math.max(1, need)) + '%), at ' + Object.keys(apts).length + ' airports');
  console.log('already georeferenced, left alone: ' + n.georeferenced + '; could not be fetched or read: ' + n.failed);
  Object.keys(why).sort(function (a, b) { return why[b] - why[a]; }).forEach(function (k) { console.log('  ' + String(why[k]).padStart(4) + '  ' + k); });
  // More than a few failures to fetch is the FAA's server, not the charts: do not publish a thin set as the cycle's.
  if (n.failed > 0.1 * rows.length) { console.error('too many charts could not be fetched'); process.exit(1); }
}

function report(rows, o) {
  var t = rows.filter(function (r) { return r.truth; }), pl = t.filter(function (r) { return r.ok; });
  var q = function (a, f) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN; };
  var e = pl.map(function (r) { return r.aptNm; });
  pl.filter(function (r) { return r.aptNm > 0.25; }).forEach(function (r) { console.log('  OUT ' + r.aptNm.toFixed(2) + ' nm  ' + r.id + ' ' + r.name + '  n=' + r.n + (r.line ? ' line' : '') + ' [' + r.fixes.join(' ') + ']'); });
  console.log('charts with a known true position: ' + t.length + '; placed ' + pl.length + ' (' + Math.round(100 * pl.length / Math.max(1, t.length)) + '%)');
  if (pl.length) console.log('error at the airport: median ' + q(e, 0.5).toFixed(2) + ' nm, 90th pct ' + q(e, 0.9).toFixed(2) + ', worst ' + q(e, 1).toFixed(2) + '; over 0.25 nm: ' + e.filter(function (x) { return x > 0.25; }).length + ', over 1 nm: ' + e.filter(function (x) { return x > 1; }).length);
  var lim = +o.fail || 0;
  if (lim && e.some(function (x) { return x > lim; })) { console.error('a placement is more than ' + lim + ' nm out'); process.exit(1); }
}

Promise.resolve().then(main).catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
