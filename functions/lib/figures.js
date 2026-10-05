// Pure-JS figure renderer: turn a compact figure spec into an SVG string. No
// Python, no native deps - the SVG is stored as an image/svg+xml asset and the
// exam UI renders it through the normal <img> path. Covers the figure types SAT
// math actually uses: coordinate/function graphs, scatter, line, and bar charts,
// plus a sanitized raw-SVG passthrough for free-form geometry.

const COLORS = {
  axis: '#16235A',
  grid: '#DCE1F2',
  plot: '#2F4BBF',
  plot2: '#C2911C',
  point: '#16235A',
  bar: '#2F4BBF',
  text: '#41507F',
};

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]
));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const fmt = (n) => { const r = Math.round(n * 1000) / 1000; return String(Number.isInteger(r) ? r : r); };

const wrap = (w, h, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="ui-sans-serif,system-ui,sans-serif">${inner}</svg>`;

// A "nice" tick step that yields roughly 6-10 ticks across a span.
function niceStep(span) {
  if (!(span > 0)) return 1;
  const raw = span / 8;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function ticks(a, b) {
  const step = niceStep(b - a);
  const out = [];
  for (let t = Math.ceil(a / step) * step; t <= b + 1e-9; t += step) {
    out.push(Math.abs(t) < 1e-9 ? 0 : t);
  }
  return out;
}

function evalFn(f, x) {
  if (!f || typeof f !== 'object') return NaN;
  const kind = f.kind || f.type;
  if (kind === 'linear') return num(f.m) * x + num(f.b);
  if (kind === 'quadratic') return num(f.a) * x * x + num(f.b) * x + num(f.c);
  if (kind === 'cubic') return num(f.a) * x ** 3 + num(f.b) * x * x + num(f.c) * x + num(f.d);
  if (Array.isArray(f.coeffs)) return f.coeffs.reduce((acc, c) => acc * x + num(c), 0); // highest-degree first
  return NaN;
}

function fnLabel(f) {
  const kind = f.kind || f.type;
  if (kind === 'linear') return `y = ${fmt(num(f.m))}x + ${fmt(num(f.b))}`;
  if (kind === 'quadratic') return `y = ${fmt(num(f.a))}x^2 + ${fmt(num(f.b))}x + ${fmt(num(f.c))}`;
  return 'a function';
}

// Coordinate plane with axes through the origin - for function graphs.
function coordinateGraph(spec) {
  let [x0, x1] = arr(spec.xRange).length === 2 ? spec.xRange.map(Number) : [-10, 10];
  let [y0, y1] = arr(spec.yRange).length === 2 ? spec.yRange.map(Number) : [-10, 10];
  if (!(x1 > x0)) { x0 = -10; x1 = 10; }
  if (!(y1 > y0)) { y0 = -10; y1 = 10; }
  const S = 300; const M = 26; const W = S + M * 2; const H = S + M * 2;
  const toPx = (x) => M + ((x - x0) / (x1 - x0)) * S;
  const toPy = (y) => M + (1 - (y - y0) / (y1 - y0)) * S;
  const p = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];

  for (const tx of ticks(x0, x1)) {
    const px = toPx(tx).toFixed(1);
    p.push(`<line x1="${px}" y1="${M}" x2="${px}" y2="${M + S}" stroke="${COLORS.grid}" stroke-width="1"/>`);
  }
  for (const ty of ticks(y0, y1)) {
    const py = toPy(ty).toFixed(1);
    p.push(`<line x1="${M}" y1="${py}" x2="${M + S}" y2="${py}" stroke="${COLORS.grid}" stroke-width="1"/>`);
  }

  const axisY = toPy(Math.min(Math.max(0, y0), y1));
  const axisX = toPx(Math.min(Math.max(0, x0), x1));
  p.push(`<line x1="${M}" y1="${axisY.toFixed(1)}" x2="${M + S}" y2="${axisY.toFixed(1)}" stroke="${COLORS.axis}" stroke-width="1.5"/>`);
  p.push(`<line x1="${axisX.toFixed(1)}" y1="${M}" x2="${axisX.toFixed(1)}" y2="${M + S}" stroke="${COLORS.axis}" stroke-width="1.5"/>`);

  for (const tx of ticks(x0, x1)) {
    if (Math.abs(tx) < 1e-9) continue;
    p.push(`<text x="${toPx(tx).toFixed(1)}" y="${(axisY + 12).toFixed(1)}" font-size="9" text-anchor="middle" fill="${COLORS.text}">${fmt(tx)}</text>`);
  }
  for (const ty of ticks(y0, y1)) {
    if (Math.abs(ty) < 1e-9) continue;
    p.push(`<text x="${(axisX - 5).toFixed(1)}" y="${(toPy(ty) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${COLORS.text}">${fmt(ty)}</text>`);
  }

  // Plot each function, splitting the polyline where it leaves the y-window.
  arr(spec.functions).forEach((f, fi) => {
    const N = 180; let seg = []; const segs = [];
    for (let i = 0; i <= N; i++) {
      const x = x0 + (x1 - x0) * (i / N);
      const y = evalFn(f, x);
      if (Number.isFinite(y) && y >= y0 && y <= y1) seg.push(`${toPx(x).toFixed(1)},${toPy(y).toFixed(1)}`);
      else { if (seg.length > 1) segs.push(seg); seg = []; }
    }
    if (seg.length > 1) segs.push(seg);
    const col = fi % 2 ? COLORS.plot2 : COLORS.plot;
    segs.forEach((s) => p.push(`<polyline points="${s.join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`));
  });

  arr(spec.points).forEach((pt) => {
    const x = Number(pt?.x); const y = Number(pt?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.push(`<circle cx="${toPx(x).toFixed(1)}" cy="${toPy(y).toFixed(1)}" r="3.5" fill="${COLORS.point}"/>`);
    if (pt.label) p.push(`<text x="${(toPx(x) + 6).toFixed(1)}" y="${(toPy(y) - 6).toFixed(1)}" font-size="10" fill="${COLORS.text}">${esc(pt.label)}</text>`);
  });

  return wrap(W, H, p.join(''));
}

// Framed plane (axes on the left/bottom) for line and scatter data plots.
function dataPlot(spec, connect) {
  const pts = arr(spec.points)
    .map((p) => ({ x: Number(p?.x), y: Number(p?.y), label: p?.label }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return null;

  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  let x0 = Math.min(...xs); let x1 = Math.max(...xs);
  let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (x1 === x0) { x0 -= 1; x1 += 1; }
  if (y1 === y0) { y0 -= 1; y1 += 1; }
  const padX = (x1 - x0) * 0.08; const padY = (y1 - y0) * 0.12;
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;

  const L = 50; const R = 18; const T = 18; const B = 42; const PW = 320; const PH = 240;
  const W = L + PW + R; const H = T + PH + B;
  const toPx = (x) => L + ((x - x0) / (x1 - x0)) * PW;
  const toPy = (y) => T + (1 - (y - y0) / (y1 - y0)) * PH;
  const p = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];

  for (const ty of ticks(y0, y1)) {
    const py = toPy(ty);
    p.push(`<line x1="${L}" y1="${py.toFixed(1)}" x2="${L + PW}" y2="${py.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    p.push(`<text x="${L - 6}" y="${(py + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${COLORS.text}">${fmt(ty)}</text>`);
  }
  for (const tx of ticks(x0, x1)) {
    const px = toPx(tx);
    p.push(`<line x1="${px.toFixed(1)}" y1="${T}" x2="${px.toFixed(1)}" y2="${T + PH}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    p.push(`<text x="${px.toFixed(1)}" y="${T + PH + 14}" font-size="9" text-anchor="middle" fill="${COLORS.text}">${fmt(tx)}</text>`);
  }
  p.push(`<line x1="${L}" y1="${T + PH}" x2="${L + PW}" y2="${T + PH}" stroke="${COLORS.axis}" stroke-width="1.3"/>`);
  p.push(`<line x1="${L}" y1="${T}" x2="${L}" y2="${T + PH}" stroke="${COLORS.axis}" stroke-width="1.3"/>`);

  if (connect) {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    p.push(`<polyline points="${sorted.map((q) => `${toPx(q.x).toFixed(1)},${toPy(q.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${COLORS.plot}" stroke-width="2"/>`);
  }
  pts.forEach((pt) => {
    p.push(`<circle cx="${toPx(pt.x).toFixed(1)}" cy="${toPy(pt.y).toFixed(1)}" r="3" fill="${COLORS.point}"/>`);
    if (pt.label) p.push(`<text x="${(toPx(pt.x) + 5).toFixed(1)}" y="${(toPy(pt.y) - 5).toFixed(1)}" font-size="9" fill="${COLORS.text}">${esc(pt.label)}</text>`);
  });

  if (spec.xLabel) p.push(`<text x="${L + PW / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="${COLORS.axis}">${esc(spec.xLabel)}</text>`);
  if (spec.yLabel) p.push(`<text x="14" y="${T + PH / 2}" font-size="11" text-anchor="middle" fill="${COLORS.axis}" transform="rotate(-90 14 ${T + PH / 2})">${esc(spec.yLabel)}</text>`);
  return wrap(W, H, p.join(''));
}

function barChart(spec) {
  const cats = arr(spec.categories).map(String);
  const vals = arr(spec.values).map(Number);
  const n = Math.min(cats.length, vals.length);
  if (!n) return null;

  const L = 50; const R = 18; const T = 18; const B = 44; const bw = 46; const gap = 22;
  const PW = n * bw + (n + 1) * gap; const PH = 240; const W = L + PW + R; const H = T + PH + B;
  const vmax = Math.max(1, ...vals.slice(0, n).filter(Number.isFinite));
  const step = niceStep(vmax); const yMax = Math.ceil(vmax / step) * step;
  const toPy = (v) => T + (1 - v / yMax) * PH;
  const p = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];

  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const py = toPy(v);
    p.push(`<line x1="${L}" y1="${py.toFixed(1)}" x2="${L + PW}" y2="${py.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    p.push(`<text x="${L - 6}" y="${(py + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="${COLORS.text}">${fmt(v)}</text>`);
  }
  p.push(`<line x1="${L}" y1="${T + PH}" x2="${L + PW}" y2="${T + PH}" stroke="${COLORS.axis}" stroke-width="1.3"/>`);

  for (let i = 0; i < n; i++) {
    const v = Number.isFinite(vals[i]) ? vals[i] : 0;
    const x = L + gap + i * (bw + gap); const y = toPy(Math.max(0, v));
    const barH = Math.max(0, T + PH - y);
    p.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${barH.toFixed(1)}" fill="${COLORS.bar}" rx="2"/>`);
    p.push(`<text x="${(x + bw / 2).toFixed(1)}" y="${T + PH + 14}" font-size="9" text-anchor="middle" fill="${COLORS.text}">${esc(cats[i])}</text>`);
  }
  if (spec.yLabel) p.push(`<text x="14" y="${T + PH / 2}" font-size="11" text-anchor="middle" fill="${COLORS.axis}" transform="rotate(-90 14 ${T + PH / 2})">${esc(spec.yLabel)}</text>`);
  if (spec.xLabel) p.push(`<text x="${L + PW / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="${COLORS.axis}">${esc(spec.xLabel)}</text>`);
  return wrap(W, H, p.join(''));
}

// Raw model-authored SVG (for geometry/other). Clip to the <svg> element and
// strip anything executable; rendered via <img> so script can't run regardless.
function sanitizeSvg(s) {
  if (typeof s !== 'string') return null;
  const start = s.indexOf('<svg');
  const end = s.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  let t = s.slice(start, end + 6)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(xlink:href|href)\s*=\s*("|')\s*(?!#)[^"']*\2/gi, '');
  if (!/xmlns=/.test(t)) t = t.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  return t;
}

/** A short text summary of the figure, for the verifier and accessibility. */
export function describeFigure(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if (spec.description) return String(spec.description);
  switch (spec.type) {
    case 'function-graph':
    case 'graph':
      return `graph of ${arr(spec.functions).map(fnLabel).join(', ') || 'a function'}`;
    case 'bar':
      return `bar chart: ${arr(spec.categories).map((c, i) => `${c}=${arr(spec.values)[i]}`).join(', ')}`;
    case 'line':
      return `line graph through ${arr(spec.points).map((p) => `(${p.x}, ${p.y})`).join(', ')}`;
    case 'scatter':
      return `scatterplot of ${arr(spec.points).map((p) => `(${p.x}, ${p.y})`).join(', ')}`;
    default:
      return String(spec.caption || 'figure');
  }
}

/**
 * Render a figure spec to an SVG string. Returns { svg, description } or null if
 * the spec is unsupported/malformed (caller then drops the figure).
 */
export function renderFigure(spec) {
  if (!spec || typeof spec !== 'object') return null;
  try {
    let svg = null;
    switch (spec.type) {
      case 'function-graph':
      case 'graph': svg = coordinateGraph(spec); break;
      case 'scatter': svg = dataPlot(spec, false); break;
      case 'line': svg = dataPlot(spec, true); break;
      case 'bar': svg = barChart(spec); break;
      case 'svg': svg = sanitizeSvg(spec.svg); break;
      default: return null;
    }
    if (!svg) return null;
    return { svg, description: describeFigure(spec) };
  } catch {
    return null;
  }
}
