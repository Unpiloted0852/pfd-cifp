/*
 * Place one chart: PDF bytes in, where its page belongs on the earth out.
 *
 * The steps, each in its own file:
 *   the names on the page      text layer, and OCR (here; clean.js)
 *   the marks on the page      snap.js
 *   which marks are which fix  plate-fix.js
 *
 * Needs pdfjs-dist and @napi-rs/canvas, and `tesseract` on the path.
 */
'use strict';
var fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
var FX = require('./plate-fix.js');
var G = require('./plate-geo.js');
var marks = require('./snap.js').marks;
var letters = require('./clean.js').letters;
var createCanvas = require('@napi-rs/canvas').createCanvas;

var S = 3;                 // pixels per point the marks are looked for at
var NEAR = 48;             // a label is within this many points of its fix
var KEEP = 40;             // marks offered per label, nearest first
var PAD = 1.2;

var pdfjs = null;
function lib() {
  if (pdfjs) return Promise.resolve(pdfjs);
  return import('pdfjs-dist/legacy/build/pdf.mjs').then(function (m) {
    m.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs = m; return m;
  });
}

function distNm(a, b, c, d) {
  var k = Math.cos((a + c) / 2 * Math.PI / 180);
  return Math.hypot((a - c) * 60, (b - d) * 60 * k);
}

/* The fixes a name could be, near here: of each name, its nearest position. */
function knownNear(fix, ref, maxNm, pred) {
  var known = Object.create(null);
  for (var n in fix) {
    if (!pred(n)) continue;
    var b = null, bd = maxNm, list = fix[n];
    for (var i = 0; i < list.length; i++) { var dd = distNm(list[i][0], list[i][1], ref[0], ref[1]); if (dd < bd) { bd = dd; b = list[i]; } }
    if (b) known[n] = b;
  }
  return known;
}

function raster(page, scale, clean) {
  var vp = page.getViewport({ scale: scale });
  var cv = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)), ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  return page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise.then(function () {
    if (clean) letters(ctx, cv.width, cv.height, scale);
    return { cv: cv, ctx: ctx };
  });
}

/*
 * Reading the names off a chart that has no text layer.
 *
 * Two readings, both Tesseract in sparse-text mode: the page as drawn, and
 * the page with everything but its lettering taken off (clean.js). Words are
 * NOT filtered by Tesseract's confidence, and a name is looked for INSIDE
 * each word as well as being one: on a chart Tesseract runs neighbouring
 * words together ("ISFO53DUYET", "3000DUMBA") and gives the result no
 * confidence at all, though every letter is right. Measured against the text
 * layer of 12 FAA plates: whole confident words find 61% of the fix labels;
 * this finds 96%, with about one false name per two charts — which agrees
 * with nothing and is dropped by the fit.
 *
 * -> [{ str, conf, x0, y0, x1, y1 }], points, origin BOTTOM-left.
 */
function ocrPass(page, vh, scale, clean, tmp, tag) {
  return raster(page, scale, clean).then(function (r) {
    var png = path.join(tmp, tag + '.png');
    fs.writeFileSync(png, r.cv.toBuffer('image/png'));
    return new Promise(function (resolve) {
      cp.execFile('tesseract', [png, 'stdout', '--psm', '11', '-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'tsv'],
        { encoding: 'utf8', maxBuffer: 1 << 26, env: Object.assign({}, process.env, { OMP_THREAD_LIMIT: '1' }) },
        function (err, out) {
          try { fs.unlinkSync(png); } catch (e) { /* nothing to remove */ }
          if (err && !out) { resolve({ words: [], failed: String(err.code || err.message) }); return; }
          var words = [];
          String(out).split('\n').slice(1).forEach(function (l) {
            var f = l.split('\t'); if (f.length < 12 || !f[11]) return;
            var wd = f[11].trim(); if (!wd) return;
            words.push({ str: wd, conf: +f[10], x0: +f[6] / scale, y0: vh - (+f[7] + +f[9]) / scale, x1: (+f[6] + +f[8]) / scale, y1: vh - +f[7] / scale });
          });
          resolve({ words: words });
        });
    });
  });
}

function ocrWords(page, vh, cache) {
  if (cache && fs.existsSync(cache)) return Promise.resolve(JSON.parse(fs.readFileSync(cache, 'utf8')));
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'place-'));
  return Promise.all([ocrPass(page, vh, 4.2, false, tmp, 'a'), ocrPass(page, vh, 5, true, tmp, 'f')]).then(function (r) {
    try { fs.rmdirSync(tmp); } catch (e) { /* left behind; the runner is thrown away */ }
    if (r[0].failed && r[1].failed) throw new Error('tesseract did not run: ' + r[0].failed);
    var words = r[0].words.concat(r[1].words);
    if (cache) fs.writeFileSync(cache, JSON.stringify(words));
    return words;
  });
}

/* Names among OCR words -> labels and the boxes of real words. */
function fromWords(words, known) {
  var lab = [], boxes = [];
  function add(name, px, py) {
    for (var i = 0; i < lab.length; i++) if (lab[i].name === name && Math.hypot(lab[i].px - px, lab[i].py - py) < 15) return;
    lab.push({ name: name, px: px, py: py, lat: known[name][0], lon: known[name][1] });
  }
  words.forEach(function (w) {
    var wd = w.str, ww = w.x1 - w.x0, hh = w.y1 - w.y0, cy = (w.y0 + w.y1) / 2;
    if (w.conf >= 30 && wd.length >= 2) boxes.push([w.x0, w.y0, w.x1, w.y1]);
    if (known[wd]) { add(wd, (w.x0 + w.x1) / 2, cy); return; }
    if (ww <= hh) return;                          // set vertically: where its letters are is not known
    for (var k = 0; k + 5 <= wd.length; k++) {     // three-letter idents only as whole words: "SEA" is in everything
      var sub = wd.substr(k, 5);
      if (known[sub]) add(sub, w.x0 + ww * (k + 2.5) / wd.length, cy);
    }
  });
  return { lab: lab, boxes: boxes };
}

/* The same from the PDF's own text, where it has any. Page space -> viewport points. */
function fromText(items, known, vp1, vh) {
  var at = function (x, y) { var p = vp1.convertToViewportPoint(x, y); return [p[0], vh - p[1]]; };
  var lab = FX.labels(items, known).map(function (l) { var p = at(l.px, l.py); return { name: l.name, px: p[0], py: p[1], lat: l.lat, lon: l.lon }; });
  var boxes = [];
  items.forEach(function (it) {
    if (!it.str || !it.str.trim() || !it.transform || Math.abs(it.transform[1]) > 0.01) return;
    var h = it.height || 8, a = at(it.transform[4], it.transform[5] - 0.25 * h), b = at(it.transform[4] + it.width, it.transform[5] + h);
    boxes.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
  });
  return { lab: lab, boxes: boxes };
}

/*
 * Where is this chart, roughly, when the airport is not in the CIFP?
 *
 * The five-letter words on it that are fix names somewhere: the place most
 * of them are within sixty miles of. Nine military fields need this.
 */
function guessRef(strings, fix) {
  var pts = [];
  strings.forEach(function (s) {
    for (var k = 0; k + 5 <= s.length; k++) { var list = fix[s.substr(k, 5)]; if (list) list.forEach(function (p) { pts.push([p, s.substr(k, 5)]); }); }
  });
  var best = null, bn = 2;
  pts.forEach(function (c) {
    var names = Object.create(null), n = 0;
    pts.forEach(function (q) { if (!names[q[1]] && distNm(c[0][0], c[0][1], q[0][0], q[0][1]) < 60) { names[q[1]] = 1; n++; } });
    if (n > bn) { bn = n; best = c[0]; }
  });
  return best;
}

/*
 * The plan view: the part of the page that is the map.
 *
 * A plate is ruled off into strips — briefing, plan, profile, minimums — by
 * lines right across it. The plan view is the strip the agreeing fixes are
 * in. Published so the extension can lay only the map on the map; without
 * it the whole sheet goes down, minimums and all.
 *
 * -> [x0, y0, x1, y1] in points, origin TOP-left, or null.
 */
function planBox(gray, w, h, pts) {
  var rows = [], y, x;
  for (y = 0; y < h; y++) {
    var run = 0, bestRun = 0, bs = 0, start = 0, gap = 0;
    for (x = 0; x < w; x++) {
      if (gray[y * w + x] < 128) { if (!run) start = x; run = x - start + 1; gap = 0; if (run > bestRun) { bestRun = run; bs = start; } }
      else if (run && ++gap > 2) { run = 0; }
    }
    if (bestRun >= 0.55 * w) rows.push([y, bs, bs + bestRun]);
  }
  if (rows.length < 2) return null;
  var ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
  pts.forEach(function (p) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; if (p[0] < xmin) xmin = p[0]; if (p[0] > xmax) xmax = p[0]; });
  var top = null, bot = null;
  rows.forEach(function (r) { if (r[0] < ymin) top = r; if (r[0] > ymax && !bot) bot = r; });
  if (!top || !bot || bot[0] - top[0] < 0.2 * h) return null;
  // The sides: the page's own frame, which the rules run between. Where the
  // two rules disagree (an airport sketch cut into a corner) the wider wins:
  // better a corner of something else than a map with its edge missing.
  var x0 = Math.min(top[1], bot[1]), x1 = Math.max(top[2], bot[2]);
  if (x0 > xmin || x1 < xmax) return null;
  return [x0 / S, top[0] / S, x1 / S, bot[0] / S].map(function (v) { return Math.round(v * 10) / 10; });
}

/*
 * placeChart(bytes, ctx, opt) -> Promise of
 *   { ok: true, corners: [[lat, lon] x4], w, h, box, n, n2, line, names, rmsPt, mPerPt }
 *   { ok: false, why, geo? }
 *
 * ctx: { fix, apt: { lat, lon, rw } | null }
 * opt: { anyway: place it even if it is georeferenced (validation),
 *        names: 'ocr' to ignore the text layer, ocrCache: file }
 *
 * corners are of the PAGE — top-left, top-right, bottom-right, bottom-left —
 * and w, h its size in points: what plate-fit in the extension takes.
 */
function placeChart(bytes, ctx, opt) {
  opt = opt || {};
  var info = G.parse(bytes);
  if (info.ok && !opt.anyway) return Promise.resolve({ ok: false, geo: true, why: 'already georeferenced' });
  var page, vp1, vw, vh, items, words, gray, w, h;
  return lib().then(function (L) {
    return L.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false }).promise;
  }).then(function (doc) { return doc.getPage(1); }).then(function (p) {
    page = p; vp1 = page.getViewport({ scale: 1 }); vw = vp1.width; vh = vp1.height;
    return Promise.all([page.getTextContent(), raster(page, S, false)]);
  }).then(function (r) {
    items = opt.names === 'ocr' ? [] : r[0].items;
    var cv = r[1].cv; w = cv.width; h = cv.height;
    var im = r[1].ctx.getImageData(0, 0, w, h).data; gray = new Uint8Array(w * h);
    for (var i = 0; i < w * h; i++) gray[i] = (im[4 * i] * 3 + im[4 * i + 1] * 6 + im[4 * i + 2]) / 10;
    return ocrWords(page, vh, opt.ocrCache);
  }).then(function (ws) {
    words = ws;
    var ref = ctx.apt ? [ctx.apt.lat, ctx.apt.lon] : guessRef(words.map(function (x) { return x.str; }).concat(items.map(function (x) { return x.str || ''; })), ctx.fix);
    if (!ref) return { ok: false, why: 'the airport is not in the CIFP and the chart names too few fixes to say where it is' };
    var known = knownNear(ctx.fix, ref, 60, function (n) { return n.length === 5; });
    // the runway waypoints of this airport (RW06R), which RNAV charts name
    if (ctx.apt) for (var k in ctx.apt.rw) known[k] = ctx.apt.rw[k];
    var nav = knownNear(ctx.fix, ref, 40, function (n) { return n.length === 3; });
    var both = Object.assign(Object.create(null), nav, known);

    // The names: the text layer where it has them, and OCR. Both, because a
    // DoD text layer is often there but scrambled.
    var t = fromText(items, both, vp1, vh), o = fromWords(words, both);
    var lab = t.lab.slice(), boxes = t.boxes.concat(o.boxes);
    o.lab.forEach(function (l) { if (!lab.some(function (q) { return q.name === l.name && Math.hypot(q.px - l.px, q.py - l.py) < 15; })) lab.push(l); });

    // a mark inside a word is part of a letter, not of the map
    var mk = marks(gray, w, h, S).filter(function (m) {
      var px = m.x / S, py = vh - m.y / S;
      for (var i = 0; i < boxes.length; i++) { var b = boxes[i]; if (px >= b[0] - PAD && px <= b[2] + PAD && py >= b[1] - PAD && py <= b[3] + PAD) return false; }
      return true;
    });
    // every mark near a name is somewhere that name's fix might be
    var cand = [];
    lab.forEach(function (Lb) {
      if (Lb.name.length === 3) return;
      var near = [];
      mk.forEach(function (m) { var dd = Math.hypot(m.x / S - Lb.px, vh - m.y / S - Lb.py); if (dd <= NEAR) near.push([dd, m]); });
      near.sort(function (a, b) { return a[0] - b[0]; });
      // symbols and line meetings, nearest first; a bare corner or line end only if it is the nearest thing
      var strong = near.filter(function (q) { return q[1].kind !== 'corner' && q[1].kind !== 'end'; }).slice(0, KEEP);
      var weak = near.filter(function (q) { return q[1].kind === 'corner' || q[1].kind === 'end'; }).slice(0, 1);
      strong.concat(weak).forEach(function (q) { cand.push({ name: Lb.name, px: q[1].x / S, py: vh - q[1].y / S, lat: Lb.lat, lon: Lb.lon, sym: q[1].kind === 'hole' }); });
    });
    /*
     * A navaid's ident is printed all over the chart — in every DME fix's
     * label, in the notes — and its own label is a box on a leader, far from
     * it. So where the ident is printed says nothing; but the navaid is drawn
     * as a symbol, and if the chart names it at all, it is offered every
     * symbol on the page. A wrong placement puts it on one of them by chance
     * about once in a thousand.
     */
    var navNames = Object.create(null);
    lab.forEach(function (l) { if (l.name.length === 3) navNames[l.name] = 1; });
    var syms = mk.filter(function (m) { return m.kind === 'hole' || m.kind === 'blob'; });
    Object.keys(navNames).forEach(function (n) { syms.forEach(function (m) { cand.push({ name: n, px: m.x / S, py: vh - m.y / S, lat: nav[n][0], lon: nav[n][1], wild: true }); }); });

    var r = FX.solve(cand);
    var namesSeen = Object.create(null), nNames = 0; lab.forEach(function (l) { if (!namesSeen[l.name]) { namesSeen[l.name] = 1; nNames++; } });
    if (!r.ok) return { ok: false, why: r.why, names: nNames, info: info };
    var g = function (x, y) { var q = FX.toGround(r.sim, x, y); return [Math.round(q.lat * 1e6) / 1e6, Math.round(q.lon * 1e6) / 1e6]; };
    var out = { ok: true, corners: [g(0, vh), g(vw, vh), g(vw, 0), g(0, 0)],
                w: Math.round(vw * 100) / 100, h: Math.round(vh * 100) / 100,
                n: r.n, n2: r.n2, rival: r.rival, nSym: r.nSym, line: !!r.line, fixes: r.names, rmsPt: r.rmsPt, mPerPt: r.mPerPt, names: nNames,
                sim: r.sim, info: info, ref: ref };
    var box = planBox(gray, w, h, r.pairs.map(function (p) { return [p.px * S, (vh - p.py) * S]; }));
    if (box) out.box = box;
    out.nw = r.names.filter(function (n) { return n.length !== 3; }).length;
    // where the fit puts the airport itself, on the page (points, origin top-left)
    var ends = ctx.apt ? Object.keys(ctx.apt.rw).map(function (k) { return ctx.apt.rw[k]; }) : [];
    if (!ends.length) ends = [ref];
    out.aptAt = ends.map(function (e) { var p = FX.toPage(r.sim, e[0], e[1]); return [p[0], vh - p[1]]; });
    out.aptIn = box ? out.aptAt.every(function (p) { return p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3]; }) : null;
    /*
     * The airport must be on the map. An approach plate's plan view always
     * shows the field. An INSET does not: "ROUTING TO HOOPE" in a corner of
     * Denver's ILS 17R is a little map of its own, five fixes drawn to one
     * scale, and they agree perfectly — on a placement that puts the airport
     * seventeen miles away, down in the minimums table. So the runways, where
     * this placement puts them, must fall in the same ruled-off strip of the
     * page as the fixes. If the strip cannot be found, or the airport is not
     * known, nothing is claimed.
     */
    if (!opt.loose) {
      if (!ctx.apt) return { ok: false, why: 'the airport is not in the CIFP, so the placement cannot be checked against it', names: nNames, info: info };
      if (out.aptIn !== true) return { ok: false, why: box ? 'the fixes agree, but on a placement that puts the airport outside the plan view (an inset)' : 'the plan view could not be made out', names: nNames, info: info };
    }
    return out;
  });
}

module.exports = { placeChart: placeChart, knownNear: knownNear, distNm: distNm, planBox: planBox, fromWords: fromWords, guessRef: guessRef, FX: FX, G: G };
