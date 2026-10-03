'use strict';
/*
 * A chart with everything but its lettering taken off, for OCR.
 *
 * Tesseract is asked to find words on a page that is mostly lines: tracks,
 * radials, shading, terrain tint. It reads about six labels in ten. Letters
 * are small separate pieces of ink; nearly everything else is long, or pale.
 * So: tint goes to white, and any connected piece of ink bigger than a
 * letter can be is erased.
 */
function letters(ctx, w, h, S) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data, N = w * h;
  const ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const g = (d[4 * i] * 3 + d[4 * i + 1] * 6 + d[4 * i + 2]) / 10; ink[i] = g < 130 ? 1 : 0; }
  const lab = new Int32Array(N), stack = new Int32Array(N); const maxSide = 11 * S, minSide = 0.6 * S; let id = 0;
  const kill = [0];
  for (let i0 = 0; i0 < N; i0++) { if (!ink[i0] || lab[i0]) continue; id++; let sp = 0, x0 = w, x1 = 0, y0 = h, y1 = 0; stack[sp++] = i0; lab[i0] = id;
    while (sp) { const i = stack[--sp], x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (ink[j] && !lab[j]) { lab[j] = id; stack[sp++] = j; } } }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1; kill.push((bw > maxSide || bh > maxSide || (bw < minSide && bh < minSide)) ? 1 : 0); }
  for (let i = 0; i < N; i++) { const keep = ink[i] && !kill[lab[i]]; const v = keep ? 0 : 255; d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; d[4 * i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}
module.exports = { letters };
