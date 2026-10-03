'use strict';
/*
 * Where on the page a fix actually IS, as opposed to where its name is printed.
 *
 * A fix is marked by something drawn: a waypoint star or a triangle (a blob,
 * fatter than any line), a tick or another line crossing the procedure track,
 * the end of a leg, or a corner in it. This finds every such mark in the
 * picture of the chart. It does not decide which mark belongs to which name:
 * each name is offered every mark near it, and the placement that the most
 * names agree on picks among them.
 *
 * marks(gray, w, h, pxPerPt) -> [{ x, y, kind }]  (pixels, origin top-left)
 */
function marks(gray, w, h, S) {
  const NOTHIN = false, HOLE_MIN = 6, MISS = 0, REACH = 4, OLDCROSS = false;
  const N = w * h, dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) dark[i] = gray[i] < 110 ? 1 : 0;
  // distance to the nearest light pixel (chamfer 3-4), in pixels
  const INF = 1e6, d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = dark[i] ? INF : 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!d[i]) continue;
    let v = d[i]; v = Math.min(v, d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + 1.4142, d[i - w + 1] + 1.4142); d[i] = v; }
  for (let y = h - 2; y > 0; y--) for (let x = w - 2; x > 0; x--) { const i = y * w + x; if (!d[i]) continue;
    let v = d[i]; v = Math.min(v, d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + 1.4142, d[i + w - 1] + 1.4142); d[i] = v; }
  const out = [];
  const half = 0.55 * S;          // half-width of a bold line: the track is about 1.4 pt wide
  const blob = 1.1 * S;           // anything this fat is a symbol, not a line
  const isDark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && dark[(y | 0) * w + (x | 0)] === 1;
  function arcs(cx, cy, r) {      // dark runs met going round a circle, with their mid-angles
    const n = Math.max(24, Math.round(2 * Math.PI * r)); const on = [];
    for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; on.push(isDark(cx + r * Math.cos(a), cy + r * Math.sin(a))); }
    const runs = []; let start = -1;
    // begin at a light sample so runs do not wrap
    let s0 = on.indexOf(false); if (s0 < 0) return null;
    for (let q = 1; q <= n; q++) { const k = (s0 + q) % n; if (on[k] && start < 0) start = q; if (!on[k] && start >= 0) { runs.push(((s0 + (start + q - 1) / 2) % n) * 2 * Math.PI / n); start = -1; } }
    return runs;
  }
  for (let y = 4; y < h - 4; y++) for (let x = 4; x < w - 4; x++) {
    const i = y * w + x, t = d[i];
    if (t < half) continue;
    // ridge: no neighbour is deeper
    if (d[i - 1] > t || d[i + 1] > t || d[i - w] > t || d[i + w] > t || d[i - w - 1] > t || d[i - w + 1] > t || d[i + w - 1] > t || d[i + w + 1] > t) continue;
    if (t >= blob && t < 6 * S) { out.push({ x, y, kind: 'blob', t }); continue; }
    if (t >= blob) continue;      // a filled area, not a mark
    const r1 = arcs(x, y, t + 0.9 * S), r2 = arcs(x, y, t + 1.8 * S);
    if (!r1 || !r2) continue;
    const n = Math.min(r1.length, r2.length);
    if (n >= 3) { if (OLDCROSS || NOTHIN) out.push({ x, y, kind: 'cross', t }); }
    else if (n === 1) out.push({ x, y, kind: 'end', t });
    else if (n === 2) { let da = Math.abs(r2[0] - r2[1]); if (da > Math.PI) da = 2 * Math.PI - da; if (da < 2.45) out.push({ x, y, kind: 'corner', t }); }
  }
  /*
   * Open symbols: the triangle of an intersection, the outline of a waypoint
   * or a navaid. Drawn as an outline, what marks them is the small patch of
   * paper they enclose — a light region a few points across with ink all the
   * way round. Its middle is the fix. (Letters enclose paper too; the caller
   * discards marks that fall inside a word.)
   */
  // A thin outline is one soft grey pixel wide at this size: anything that is
  // not clean paper is a wall here, or the patch leaks out through the line.
  const maxSide = 9 * S, minArea = 1.2 * S * S, maxArea = 45 * S * S;
  /*
   * Paper is not always white. Water on an FAA plate, and terrain on a DoD
   * one, is a flat grey tint, and a symbol drawn over it encloses a patch of
   * that tint, not of white. So the search is made once for each kind of
   * paper on the page: white, and every flat tint that covers a fair part of
   * it. (Missing this left only the POINTS of each star as marks on tinted
   * charts — the 0.35-0.48 nm cluster.)
   */
  const hist = new Float64Array(256); for (let i = 0; i < N; i++) hist[gray[i]]++;
  const papers = [[215, 255]];
  for (let v = 140; v < 250; v++) { if (hist[v] / N < 0.01) continue; if (hist[v - 1] > hist[v] || hist[v + 1] > hist[v]) continue; papers.push([v - 5, Math.min(v + 5, 252)]); }
  const wall = new Uint8Array(N), seen = new Uint8Array(N), stack = new Int32Array(N);
  for (const pp of papers) {
  for (let i = 0; i < N; i++) { wall[i] = (gray[i] < pp[0] || gray[i] > pp[1]) ? 1 : 0; seen[i] = 0; }
  for (let i0 = 0; i0 < N; i0++) {
    if (wall[i0] || seen[i0]) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, edge = false;
    stack[sp++] = i0; seen[i0] = 1;
    while (sp) { const i = stack[--sp], x = i % w, y = (i / w) | 0; area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge = true; continue; }
      const nb = [i - 1, i + 1, i - w, i + w];
      for (let k = 0; k < 4; k++) { const j = nb[k]; if (!wall[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; } } }
    if (edge || area < minArea || area > maxArea || x1 - x0 > maxSide || y1 - y0 > maxSide) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // What a symbol encloses is a fair size and roughly as wide as it is tall.
    // The counters of letters and the scraps of paper between the dots of a
    // localizer's shading are neither: they are not marks, and (worse) they
    // used to silence the real marks beside them.
    const a2 = area / (S * S), asp = Math.max(bw, bh) / Math.min(bw, bh);
    if (a2 < HOLE_MIN || asp > 1.5 || area / (bw * bh) < 0.42) continue;
    out.push({ x: sx / area, y: sy / area, kind: 'hole', t: 99 });
  }
  }
  /*
   * Thin lines. Most fixes on an ILS or a TACAN plate have no symbol at all:
   * the fix is where a hairline — a DME tick, a radial, the leader from its
   * name — meets the bold track, or where two hairlines cross. A hairline is
   * a pixel wide and grey, so it is looked for with a softer idea of ink, and
   * it must really be a line: followed outward from the point for three
   * points without a gap, which the dots of a localizer's shading are not.
   *   tick: a hairline leaving the bold track, at an angle to it
   *   x:    three or more hairlines leaving one point
   */
  if (!NOTHIN) {
  let lowPaper = 255; for (const pp of papers) if (pp[0] + 5 < lowPaper && pp[0] !== 215) lowPaper = pp[0] + 5;
  const softT = Math.min(200, lowPaper - 18);
  const soft = new Uint8Array(N); for (let i = 0; i < N; i++) soft[i] = gray[i] < softT ? 1 : 0;
  const isSoft = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < w && y < h && soft[y * w + x] === 1; };
  function softRuns(cx, cy, r) {           // [{a, wpx}] soft runs round a circle
    const n = Math.max(32, Math.round(2.2 * Math.PI * r)); const on = new Array(n);
    for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; on[k] = isSoft(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    const s0 = on.indexOf(false); if (s0 < 0) return null; const runs = []; let start = -1;
    for (let q = 1; q <= n; q++) { const k = (s0 + q) % n; if (on[k] && start < 0) start = q; if (!on[k] && start >= 0) { runs.push({ a: ((s0 + (start + q - 1) / 2) % n) * 2 * Math.PI / n, wpx: (q - start) * 2 * Math.PI * r / n }); start = -1; } }
    return runs;
  }
  function ray(cx, cy, a, r0, r1) {        // an unbroken line outward along a?
    const c = Math.cos(a), sn = Math.sin(a); let miss = 0;
    for (let r = r0; r <= r1; r += 1) { const x = cx + r * c, y = cy + r * sn;
      if (!(isSoft(x, y) || isSoft(x - 0.7 * sn, y + 0.7 * c) || isSoft(x + 0.7 * sn, y - 0.7 * c))) { if (++miss > MISS) return false; } }
    return true;
  }
  function width(cx, cy, a, r) {           // how wide the line is, across itself, at r
    const c = Math.cos(a), sn = Math.sin(a), x = cx + r * c, y = cy + r * sn; let n = 0;
    for (let k = -5; k <= 5; k++) if (isSoft(x - k * sn, y + k * c)) n++; return n;
  }
  const thinMax = 1.25 * S, reach = REACH * S; const raw = [];
  const adiff = (p, q) => { let v = Math.abs(p - q) % Math.PI; return v > Math.PI / 2 ? Math.PI - v : v; };   // between undirected lines
  for (let y = 12; y < h - 12; y++) for (let x = 12; x < w - 12; x++) {
    const i = y * w + x; if (!soft[i]) continue; const t = d[i];
    if (t >= blob) continue;
    const bold = t >= half;
    if (bold && (d[i - 1] > t || d[i + 1] > t || d[i - w] > t || d[i + w] > t)) continue;     // on the track: its middle only
    const rr = softRuns(x, y, t + 2 * S); if (!rr || rr.length < (bold ? 2 : 3)) continue;
    const thin = [], fat = [];
    for (const r of rr) { if (!ray(x, y, r.a, t + 1.5, t + reach)) continue; const wd = Math.min(width(x, y, r.a, t + 2 * S), width(x, y, r.a, t + 1.3 * S)); (wd <= thinMax ? thin : fat).push(r.a); }
    if (bold) {
      // a hairline leaving the track at an angle, or the track itself forking
      let fork = false; if (fat.length >= 3) for (let p = 0; p < fat.length && !fork; p++) for (let q = p + 1; q < fat.length; q++) if (adiff(fat[p], fat[q]) > 0.4) { fork = true; break; }
      if (!fork && !(fat.length && thin.some(a => fat.every(f => adiff(a, f) > 0.4)))) continue;
      raw.push({ x, y, kind: 'tick' });
    } else {
      if (fat.length || thin.length < 3) continue;
      // not three lines that are really one: some pair must make a real angle
      let ang = false; for (let p = 0; p < thin.length && !ang; p++) for (let q = p + 1; q < thin.length; q++) if (adiff(thin[p], thin[q]) > 0.4) { ang = true; break; }
      if (!ang) continue;
      raw.push({ x, y, kind: 'x' });
    }
  }
  // one mark per meeting: neighbours that found the same one, averaged
  const used = new Uint8Array(raw.length), cg = new Map(), cs = Math.ceil(1.2 * S);
  raw.forEach((m, k) => { const key = ((m.x / cs) | 0) + ',' + ((m.y / cs) | 0); if (!cg.has(key)) cg.set(key, []); cg.get(key).push(k); });
  for (let k = 0; k < raw.length; k++) { if (used[k]) continue; const q = [k]; used[k] = 1; let sx = 0, sy = 0, n = 0, tick = false;
    while (q.length) { const j = q.pop(), m = raw[j]; sx += m.x; sy += m.y; n++; if (m.kind === 'tick') tick = true;
      const gx = (m.x / cs) | 0, gy = (m.y / cs) | 0;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const L = cg.get((gx + a) + ',' + (gy + b)); if (L) for (const o of L) if (!used[o] && Math.hypot(raw[o].x - m.x, raw[o].y - m.y) <= 1.5) { used[o] = 1; q.push(o); } } }
    out.push({ x: sx / n, y: sy / n, kind: tick ? 'tick' : 'x', t: 50 }); }
  }
  // merge neighbours: one mark per feature, blobs first
  const order = { hole: 0, blob: 1, tick: 2, x: 3, cross: 4, corner: 5, end: 6 };
  out.sort((a, b) => order[a.kind] - order[b.kind] || b.t - a.t);
  const kept = [], R2 = (1.6 * S) * (1.6 * S), cell = Math.ceil(3 * S), grid = new Map();
  for (const m of out) { const gx = (m.x / cell) | 0, gy = (m.y / cell) | 0; let dup = false;
    for (let a = -1; a <= 1 && !dup; a++) for (let b = -1; b <= 1 && !dup; b++) { const L = grid.get((gx + a) + ',' + (gy + b)); if (L) for (const q of L) if ((q.x - m.x) * (q.x - m.x) + (q.y - m.y) * (q.y - m.y) < R2) { dup = true; break; } }
    if (dup) continue; kept.push(m); const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(m); }
  /*
   * A symbol has parts: the points of a waypoint star, the corners of a
   * triangle, where the track runs into it. Each is a mark in its own right
   * and each is a few points from the middle — the same few points, in the
   * same direction, at every symbol on the chart. Left in, "the right-hand
   * point of every star" is a set of marks that agrees with itself exactly
   * as well as the middles do, and places the chart a third of a mile out.
   * Where there is a symbol, its middle is the only mark.
   */
  // (and the fat joints of a star — where its arms and the track run into
  // the ring — are parts of it too: the hole in the middle is the fix)
  const holes = kept.filter(m => m.kind === 'hole');
  const nearHole = m => holes.some(q => Math.hypot(q.x - m.x, q.y - m.y) < 5.5 * S);
  const sym = kept.filter(m => m.kind === 'hole' || (m.kind === 'blob' && !nearHole(m)));
  const R = 5.5 * S, g2 = new Map(), c2 = Math.ceil(R);
  sym.forEach(m => { const k = ((m.x / c2) | 0) + ',' + ((m.y / c2) | 0); if (!g2.has(k)) g2.set(k, []); g2.get(k).push(m); });
  return kept.filter(m => {
    if (m.kind === 'hole') return true;
    if (m.kind === 'blob') return !nearHole(m);
    const gx = (m.x / c2) | 0, gy = (m.y / c2) | 0;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const L = g2.get((gx + a) + ',' + (gy + b)); if (L) for (const q of L) if (Math.hypot(q.x - m.x, q.y - m.y) < R) return false; }
    return true;
  });
}
module.exports = { marks };
