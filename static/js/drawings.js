// Drawing tools rendered as a lightweight-charts series primitive.
// Drawings store points as {t: UTC unix seconds, p: price}; they are shared across timeframes.
//
// Every tool is a small render function that draws through a helper `G`. G records what it drew
// (segments, polygons, circles, text boxes) so hit testing works for every tool without
// tool-specific code.

import { api } from './api.js';

// ============================================================================ registry
export const GROUPS = [
  { id: 'cursors', name: 'Cursors' },
  { id: 'lines', name: 'Trend line tools' },
  { id: 'fib', name: 'Gann and Fibonacci tools' },
  { id: 'patterns', name: 'Patterns' },
  { id: 'forecast', name: 'Forecasting and measurement tools' },
  { id: 'shapes', name: 'Geometric shapes' },
  { id: 'annotation', name: 'Annotation tools' },
];

export const TOOLS = {};
const R = {}; // id -> render(G, P, d)

/** pts: number of clicks | 'free' (drag) | 'multi' (click…, double-click to finish) | 'pos' */
function def(id, name, group, pts, render, opts = {}) {
  TOOLS[id] = { id, name, group, pts, ...opts };
  R[id] = render;
}

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff', '#9c27b0', '#e91e63'];
const fibColor = (i) => FIB_COLORS[i % FIB_COLORS.length];

const DEFAULT_STYLE = { color: '#2962ff', width: 2 };
const STYLE_BY_GROUP = {
  fib: { color: '#787b86', width: 1, fill: true },
  patterns: { color: '#2962ff', width: 2, fill: true },
  annotation: { color: '#d1d4dc', width: 1, fontSize: 14 },
};
const STYLE_BY_TOOL = {
  hline: { color: '#f7a600', width: 1 }, hray: { color: '#f7a600', width: 1 }, vline: { color: '#787b86', width: 1 }, crossline: { color: '#787b86', width: 1 },
  channel: { color: '#2962ff', width: 1, fill: true }, regression: { color: '#2962ff', width: 1, fill: true }, flattopbottom: { color: '#2962ff', width: 1, fill: true },
  disjoint: { color: '#2962ff', width: 1, fill: true }, rect: { color: '#9c27b0', width: 1, fill: true }, rotrect: { color: '#9c27b0', width: 1, fill: true },
  circle: { color: '#ff9800', width: 1, fill: true }, ellipse: { color: '#ff9800', width: 1, fill: true }, triangle: { color: '#089981', width: 1, fill: true },
  arc: { color: '#e91e63', width: 1, fill: true }, brush: { color: '#ff9800', width: 2 }, highlighter: { color: '#ffeb3b', width: 14 },
  longpos: { color: '#089981', width: 1 }, shortpos: { color: '#f23645', width: 1 }, avwap: { color: '#00bcd4', width: 2 },
  fixedvp: { color: '#2962ff', width: 1 }, anchoredvp: { color: '#2962ff', width: 1 }, pitchfork: { color: '#f23645', width: 1, fill: true },
  schiff: { color: '#f23645', width: 1, fill: true }, modschiff: { color: '#f23645', width: 1, fill: true }, insidepitchfork: { color: '#f23645', width: 1, fill: true },
  arrowup: { color: '#089981', width: 1, fontSize: 13 }, arrowdown: { color: '#f23645', width: 1, fontSize: 13 }, arrowmarker: { color: '#2962ff', width: 1 },
  pricelabel: { color: '#2962ff', width: 1, fontSize: 12 }, pricenote: { color: '#2962ff', width: 1, fontSize: 12 }, flagmark: { color: '#f23645', width: 1, fontSize: 12 },
  pin: { color: '#f23645', width: 1, fontSize: 13 }, signpost: { color: '#2962ff', width: 1, fontSize: 13 }, callout: { color: '#2962ff', width: 1, fontSize: 13 },
  comment: { color: '#2962ff', width: 1, fontSize: 13 }, note: { color: '#2962ff', width: 1, fontSize: 13 }, anchoredtext: { color: '#d1d4dc', width: 1, fontSize: 14 },
  forecast: { color: '#2962ff', width: 2 }, ghostfeed: { color: '#787b86', width: 1 }, barspattern: { color: '#2962ff', width: 1 },
  ruler: { color: '#2962ff', width: 1 }, zoom: { color: '#2962ff', width: 1 },
};
const defaultStyle = (tool) => ({ ...DEFAULT_STYLE, ...(STYLE_BY_GROUP[TOOLS[tool]?.group] || {}), ...(STYLE_BY_TOOL[tool] || {}) });

// ============================================================================ geometry helpers
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
const clone = (o) => JSON.parse(JSON.stringify(o));
const strip = (d) => { const o = {}; for (const k in d) if (k[0] !== '_') o[k] = d[k]; return o; };
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function hexA(color, a) {
  if (!color) return `rgba(41,98,255,${a})`;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  let c = color.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const n = parseInt(c.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function extendPts(a, b, back, fwd, size) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const k = (size.width + size.height) * 4 / len;
  return [back ? [a[0] - dx * k, a[1] - dy * k] : a, fwd ? [b[0] + dx * k, b[1] + dy * k] : b];
}

function quadPts(p0, c, p1, n = 32) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

function cubicPts(p0, c1, c2, p1, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p1[0],
      u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p1[1]]);
  }
  return out;
}

// quadratic control point so the curve passes through `through` at t = 0.5
const passCtrl = (a, b, through) => [2 * through[0] - (a[0] + b[0]) / 2, 2 * through[1] - (a[1] + b[1]) / 2];

// ============================================================================ drawing context
class G {
  constructor(ctx, size, mgr, d) {
    this.ctx = ctx; this.size = size; this.m = mgr; this.d = d;
    this.st = d.style || {};
    this.color = this.st.color || '#2962ff';
    this.hits = [];
    this.fs = this.st.fontSize || 13;
  }
  stroke(color = this.color, width = this.st.width || 1, dash = this.st.dash) {
    const c = this.ctx;
    c.strokeStyle = color; c.lineWidth = width;
    c.setLineDash(dash === 1 ? [6, 4] : dash === 2 ? [2, 3] : Array.isArray(dash) ? dash : []);
  }
  line(a, b, o = {}) {
    if (!a || !b) return;
    const c = this.ctx;
    c.save();
    this.stroke(o.color || this.color, o.width || this.st.width || 1, o.dash ?? this.st.dash);
    if (o.alpha != null) c.globalAlpha = o.alpha;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    c.restore();
    if (!o.nohit) this.hits.push({ s: [a[0], a[1], b[0], b[1]] });
  }
  ext(a, b, back, fwd) { return extendPts(a, b, back, fwd, this.size); }
  hline(y, x0 = 0, x1 = this.size.width, o = {}) { this.line([x0, y], [x1, y], o); }
  vline(x, o = {}) { this.line([x, 0], [x, this.size.height], o); }
  polyline(pts, o = {}) {
    const c = this.ctx;
    c.save();
    this.stroke(o.color || this.color, o.width || this.st.width || 1, o.dash ?? this.st.dash);
    if (o.alpha != null) c.globalAlpha = o.alpha;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    if (o.close) c.closePath();
    c.stroke();
    c.restore();
    if (!o.nohit) for (let i = 1; i < pts.length; i++) this.hits.push({ s: [...pts[i - 1], ...pts[i]], tol: o.tol });
    if (o.close && !o.nohit && pts.length > 2) this.hits.push({ s: [...pts[pts.length - 1], ...pts[0]] });
  }
  poly(pts, o = {}) {
    const c = this.ctx;
    const fill = o.fill === undefined ? (this.st.fill !== false ? hexA(o.color || this.color, o.alpha ?? 0.15) : null) : o.fill;
    if (fill) {
      c.save(); c.fillStyle = fill;
      c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]))); c.closePath(); c.fill();
      c.restore();
      if (!o.nohit) this.hits.push({ poly: pts });
    }
    if (o.stroke !== false) this.polyline(pts, { ...o, close: true });
  }
  rect(a, b, o = {}) { this.poly([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], o); }
  circle(cx, cy, r, o = {}) {
    const c = this.ctx;
    c.save();
    this.stroke(o.color || this.color, o.width || this.st.width || 1);
    c.beginPath(); c.arc(cx, cy, Math.abs(r), o.a0 ?? 0, o.a1 ?? Math.PI * 2, o.ccw);
    const fill = o.fill === undefined ? (this.st.fill !== false && o.a0 == null ? hexA(o.color || this.color, 0.12) : null) : o.fill;
    if (fill) { c.fillStyle = fill; c.fill(); }
    c.stroke();
    c.restore();
    if (!o.nohit) this.hits.push({ c: [cx, cy, Math.abs(r)], filled: !!fill, a0: o.a0, a1: o.a1 });
  }
  dot(p, r = 3.5, color = this.color) {
    const c = this.ctx;
    c.save(); c.fillStyle = color; c.beginPath(); c.arc(p[0], p[1], r, 0, Math.PI * 2); c.fill(); c.restore();
    this.hits.push({ c: [p[0], p[1], r + 2], filled: true });
  }
  font(px = this.fs, bold = false) { return `${bold ? '600 ' : ''}${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`; }
  /** text with optional background box; returns box [x, y, w, h] */
  text(str, x, y, o = {}) {
    const c = this.ctx;
    const fs = o.size || this.fs;
    c.save();
    c.font = this.font(fs, o.bold);
    const lines = String(str).split('\n');
    const w = Math.max(...lines.map(l => c.measureText(l).width));
    const lh = fs * 1.3, h = lines.length * lh;
    const pad = o.bg ? (o.pad ?? 6) : 0;
    let bx = x - pad, by = y - pad;
    if (o.align === 'center') bx = x - w / 2 - pad;
    else if (o.align === 'right') bx = x - w - pad;
    if (o.valign === 'bottom') by = y - h - pad;
    else if (o.valign === 'middle') by = y - h / 2 - pad;
    const box = [bx, by, w + pad * 2, h + pad * 2];
    if (o.bg) {
      c.fillStyle = o.bg;
      c.beginPath();
      if (c.roundRect) c.roundRect(...box, o.radius ?? 4); else c.rect(...box);
      c.fill();
      if (o.border) { c.strokeStyle = o.border; c.lineWidth = 1; c.stroke(); }
    }
    c.fillStyle = o.color || this.color;
    c.textBaseline = 'top';
    lines.forEach((l, i) => c.fillText(l, bx + pad, by + pad + i * lh + (lh - fs) / 2));
    c.restore();
    if (!o.nohit) this.hits.push({ box });
    return box;
  }
  fmtP(p) { return this.m.h.fmtPrice(p); }
  y(price) { return this.m.toY(price); }
  price(y) { return this.m._series.coordinateToPrice(y); }
  bars() { return this.m.h.getBars(); }
  idx(t) { return this.m._barsIdx(t + this.m.h.tz()); }
  xOfIdx(l) { return this.m.h.chart.timeScale().logicalToCoordinate(l); }
}

// ============================================================================ tool renderers
const label = (G, txt, p, o = {}) => G.text(txt, p[0], p[1], { bg: o.bg || G.color, color: '#fff', size: 11, bold: true, align: 'center', valign: o.below ? undefined : 'bottom', pad: 4, ...o });

function measureInfo(G, d) {
  const [a, b] = d.points;
  const dp = b.p - a.p, pct = a.p ? dp / a.p * 100 : 0;
  const l1 = G.idx(a.t), l2 = G.idx(b.t);
  const nb = Math.round(l2 - l1), secs = Math.abs(b.t - a.t);
  const dur = secs >= 86400 ? `${Math.floor(secs / 86400)}d ${Math.floor(secs % 86400 / 3600)}h` : `${Math.floor(secs / 3600)}h ${Math.floor(secs % 3600 / 60)}m`;
  return { dp, pct, nb, dur, txtP: `${dp >= 0 ? '+' : ''}${G.fmtP(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)` };
}

// ---- cursors (not drawings)
for (const [id, name] of [['cross', 'Cross'], ['dot', 'Dot'], ['arrowcursor', 'Arrow'], ['eraser', 'Eraser']]) {
  def(id, name, 'cursors', 0, () => {}, { cursor: true });
}

// ---- trend line tools
def('trend', 'Trend Line', 'lines', 2, (G, P) => {
  // extend left / right as seen on the chart, whichever point was placed first
  const [l, r] = P[0][0] <= P[1][0] ? [P[0], P[1]] : [P[1], P[0]];
  G.line(...G.ext(l, r, !!G.st.extendLeft, !!G.st.extend));
}, { alert: true, extend: true, extendLeft: true, key: 'Alt+T' });
def('ray', 'Ray', 'lines', 2, (G, P) => G.line(...G.ext(P[0], P[1], false, true)), { alert: true });
def('infoline', 'Info Line', 'lines', 2, (G, P, d) => {
  G.line(P[0], P[1]);
  const m = measureInfo(G, d);
  const ang = Math.atan2(P[0][1] - P[1][1], P[1][0] - P[0][0]) * 180 / Math.PI;
  G.text(`${m.txtP}\n${m.nb} bars, ${m.dur}\n${ang.toFixed(1)}°`, P[1][0] + 10, P[1][1], { bg: 'rgba(30,34,45,.92)', color: '#d1d4dc', size: 11, valign: 'middle', border: G.color });
});
def('extended', 'Extended Line', 'lines', 2, (G, P) => G.line(...G.ext(P[0], P[1], true, true)), { alert: true });
def('trendangle', 'Trend Angle', 'lines', 2, (G, P) => {
  G.line(P[0], P[1]);
  const r = Math.min(60, dist(P[0], P[1]));
  G.line(P[0], [P[0][0] + r + 10, P[0][1]], { dash: 1, nohit: true });
  const ang = Math.atan2(P[0][1] - P[1][1], P[1][0] - P[0][0]);
  G.circle(P[0][0], P[0][1], r * 0.7, { a0: Math.min(0, -ang), a1: Math.max(0, -ang), fill: null, nohit: true });
  G.text(`${(ang * 180 / Math.PI).toFixed(1)}°`, P[0][0] + r * 0.8, P[0][1] - (ang > 0 ? 16 : -4), { size: 11, nohit: true });
});
def('hline', 'Horizontal Line', 'lines', 1, (G, P) => G.hline(P[0][1]), { alert: true, key: 'Alt+H', axis: 'price' });
def('hray', 'Horizontal Ray', 'lines', 1, (G, P) => G.hline(P[0][1], P[0][0]), { alert: true, axis: 'price' });
def('vline', 'Vertical Line', 'lines', 1, (G, P) => G.vline(P[0][0]), { key: 'Alt+V', axis: 'time' });
def('crossline', 'Cross Line', 'lines', 1, (G, P) => { G.hline(P[0][1]); G.vline(P[0][0]); }, { alert: true, axis: 'both' });

function channelDy(P) {
  const [[x1, y1], [x2, y2]] = P;
  if (!P[2]) return 0;
  const [x3, y3] = P[2];
  return x2 === x1 ? y3 - y1 : y3 - (y1 + (y2 - y1) * (x3 - x1) / (x2 - x1));
}
def('channel', 'Parallel Channel', 'lines', 3, (G, P, d) => {
  const dy = channelDy(P);
  // extend left / right as seen on the chart
  const [l, r] = P[0][0] <= P[1][0] ? [P[0], P[1]] : [P[1], P[0]];
  const [a, b] = G.ext(l, r, !!G.st.extendLeft, !!G.st.extend);
  const off = (p, k) => [p[0], p[1] + dy * k];
  if (G.st.fill !== false) G.poly([a, b, off(b, 1), off(a, 1)], { stroke: false });
  G.line(a, b); G.line(off(a, 1), off(b, 1));
  G.line(off(a, 0.5), off(b, 0.5), { dash: 1, alpha: 0.6, nohit: true });
  d._dy = dy;
}, { alert: true, fill: true, extend: true, extendLeft: true, handles: (P, d) => [P[0], P[1], [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 + (d._dy || 0)]] });
def('regression', 'Regression Trend', 'lines', 2, (G, P, d) => {
  const bars = G.bars();
  let i0 = Math.round(G.idx(d.points[0].t)), i1 = Math.round(G.idx(d.points[1].t));
  if (i0 > i1) [i0, i1] = [i1, i0];
  i0 = Math.max(0, i0); i1 = Math.min(bars.length - 1, i1);
  const n = i1 - i0 + 1;
  if (n < 2) return G.line(P[0], P[1]);
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { const y = bars[i0 + i].close; sx += i; sy += y; sxy += i * y; sxx += i * i; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
  let dev = 0;
  for (let i = 0; i < n; i++) dev = Math.max(dev, Math.abs(bars[i0 + i].close - (icpt + slope * i)));
  const xa = G.xOfIdx(i0), xb = G.xOfIdx(i1);
  const pa = icpt, pb = icpt + slope * (n - 1);
  const c0 = [xa, G.y(pa)], c1 = [xb, G.y(pb)];
  const u0 = [xa, G.y(pa + dev)], u1 = [xb, G.y(pb + dev)], l0 = [xa, G.y(pa - dev)], l1 = [xb, G.y(pb - dev)];
  if (G.st.fill !== false) { G.poly([u0, u1, c1, c0], { stroke: false, color: '#2962ff', alpha: 0.1 }); G.poly([c0, c1, l1, l0], { stroke: false, color: '#f23645', alpha: 0.1 }); }
  G.line(c0, c1, { dash: 1 }); G.line(u0, u1); G.line(l0, l1);
  d._handles = [c0, c1];
}, { fill: true, handles: (P, d) => d._handles || P, timeOnly: true });
def('flattopbottom', 'Flat Top/Bottom', 'lines', 3, (G, P) => {
  const y = P[2] ? P[2][1] : P[1][1];
  const a2 = [P[0][0], y], b2 = [P[1][0], y];
  if (G.st.fill !== false) G.poly([P[0], P[1], b2, a2], { stroke: false });
  G.line(P[0], P[1]); G.line(a2, b2);
}, { fill: true, handles: (P) => [P[0], P[1], P[2] ? [(P[0][0] + P[1][0]) / 2, P[2][1]] : P[1]] });
def('disjoint', 'Disjoint Channel', 'lines', 3, (G, P) => {
  const y2 = P[2] ? P[2][1] : P[0][1];
  const a2 = [P[0][0], y2], b2 = [P[1][0], y2 - (P[1][1] - P[0][1])];
  if (G.st.fill !== false) G.poly([P[0], P[1], b2, a2], { stroke: false });
  G.line(P[0], P[1]); G.line(a2, b2);
}, { fill: true, handles: (P) => [P[0], P[1], P[2] ? [P[0][0], P[2][1]] : P[0]] });

function pitchfork(G, P, origin) {
  if (!P[2]) return G.line(P[0], P[1]);
  const m = mid(P[1], P[2]);
  const dir = [m[0] - origin[0], m[1] - origin[1]];
  const far = (p) => [p[0] + dir[0] * 20, p[1] + dir[1] * 20];
  if (G.st.fill !== false) {
    G.poly([P[1], far(P[1]), far(m), m], { stroke: false, color: '#089981', alpha: 0.1 });
    G.poly([m, far(m), far(P[2]), P[2]], { stroke: false, color: '#2962ff', alpha: 0.1 });
  }
  G.line(origin, far(m));
  G.line(P[1], far(P[1])); G.line(P[2], far(P[2]));
  G.line(P[1], P[2], { dash: 1 });
  if (origin !== P[0]) G.line(P[0], P[1], { dash: 2, nohit: true });
}
def('pitchfork', 'Pitchfork', 'lines', 3, (G, P) => pitchfork(G, P, P[0]), { fill: true });
def('schiff', 'Schiff Pitchfork', 'lines', 3, (G, P) => pitchfork(G, P, [P[0][0], (P[0][1] + P[1][1]) / 2]), { fill: true });
def('modschiff', 'Modified Schiff Pitchfork', 'lines', 3, (G, P) => pitchfork(G, P, mid(P[0], P[1])), { fill: true });
def('insidepitchfork', 'Inside Pitchfork', 'lines', 3, (G, P) => pitchfork(G, P, P[2] ? mid(P[0], mid(P[1], P[2])) : P[0]), { fill: true });

// ---- Gann and Fibonacci
def('fib', 'Fib Retracement', 'fib', 2, (G, P, d) => {
  const p0 = d.points[0].p, p1 = d.points[1].p;
  const left = Math.min(P[0][0], P[1][0]), right = G.st.extend ? G.size.width : Math.max(P[0][0], P[1][0]);
  let prevY = null;
  [...FIB, 1.618, 2.618].forEach((lv, i) => {
    const price = p1 + (p0 - p1) * lv, y = G.y(price);
    if (y == null) return;
    if (G.st.fill !== false && prevY != null) G.poly([[left, prevY], [right, prevY], [right, y], [left, y]], { stroke: false, color: fibColor(i), alpha: 0.08, nohit: true });
    G.line([left, y], [right, y], { color: fibColor(i), dash: 0 });
    G.text(`${lv} (${G.fmtP(price)})`, left + 4, y - 14, { color: fibColor(i), size: 11, nohit: true });
    prevY = y;
  });
  G.line(P[0], [P[1][0], G.y(p1)], { color: '#787b86', dash: 1, nohit: true });
}, { fill: true, extend: true, key: 'Alt+F' });
def('fibext', 'Trend-Based Fib Extension', 'fib', 3, (G, P, d) => {
  G.polyline(P, { dash: 1 });
  if (!P[2]) return;
  const [a, b, c] = d.points;
  const left = P[2][0], right = G.st.extend ? G.size.width : P[2][0] + Math.abs(P[1][0] - P[0][0]);
  FIB_EXT.forEach((lv, i) => {
    const price = c.p + (b.p - a.p) * lv, y = G.y(price);
    G.line([left, y], [right, y], { color: fibColor(i), dash: 0 });
    G.text(`${lv} (${G.fmtP(price)})`, left + 4, y - 14, { color: fibColor(i), size: 11, nohit: true });
  });
}, { extend: true });
def('fibchannel', 'Fib Channel', 'fib', 3, (G, P) => {
  const dy = channelDy(P);
  [...FIB, 1.618].forEach((lv, i) => {
    const o = dy * lv;
    G.line(...G.ext([P[0][0], P[0][1] + o], [P[1][0], P[1][1] + o], false, !!G.st.extend), { color: fibColor(i), dash: 0 });
  });
}, { extend: true, handles: (P) => P });
const FIB_SEQ = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
def('fibtimezone', 'Fib Time Zone', 'fib', 2, (G, P) => {
  const dx = P[1][0] - P[0][0];
  FIB_SEQ.forEach((k, i) => { const x = P[0][0] + dx * k; if (x > -50 && x < G.size.width + 50) { G.vline(x, { color: fibColor(i), dash: 0 }); G.text(String(k), x + 3, 4, { color: fibColor(i), size: 11, nohit: true }); } });
});
def('fibfan', 'Fib Speed Resistance Fan', 'fib', 2, (G, P) => {
  const [a, b] = P;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  [0.25, 0.382, 0.5, 0.618, 0.75, 1].forEach((lv, i) => {
    G.line(...G.ext(a, [a[0] + dx, a[1] + dy * lv], false, true), { color: fibColor(i + 1), dash: 0 });
    G.line(...G.ext(a, [a[0] + dx * lv, a[1] + dy], false, true), { color: fibColor(i + 1), dash: 0, alpha: 0.6 });
  });
  G.rect(a, b, { fill: null, dash: 2 });
});
def('fibtime', 'Trend-Based Fib Time', 'fib', 3, (G, P) => {
  G.polyline(P, { dash: 1 });
  if (!P[2]) return;
  const dx = P[1][0] - P[0][0];
  [0, 0.382, 0.5, 0.618, 1, 1.382, 1.618, 2, 2.618].forEach((lv, i) => {
    const x = P[2][0] + dx * lv;
    G.vline(x, { color: fibColor(i), dash: 0 });
    G.text(String(lv), x + 3, 4, { color: fibColor(i), size: 11, nohit: true });
  });
});
def('fibcircles', 'Fib Circles', 'fib', 2, (G, P) => {
  const r = dist(P[0], P[1]);
  [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618].forEach((lv, i) => G.circle(P[0][0], P[0][1], r * lv, { color: fibColor(i + 1), fill: null }));
  G.line(P[0], P[1], { dash: 1 });
});
def('fibspiral', 'Fib Spiral', 'fib', 2, (G, P) => {
  const r0 = Math.max(4, dist(P[0], P[1]) / 8);
  const b = Math.log(1.618) / (Math.PI / 2);
  const a0 = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]);
  const pts = [];
  for (let th = 0; th < Math.PI * 8; th += 0.08) {
    const r = r0 * Math.exp(b * th);
    if (r > (G.size.width + G.size.height) * 2) break;
    pts.push([P[0][0] + r * Math.cos(a0 + th), P[0][1] + r * Math.sin(a0 + th)]);
  }
  G.polyline(pts);
  G.line(P[0], P[1], { dash: 1 });
});
def('fibarcs', 'Fib Speed Resistance Arcs', 'fib', 2, (G, P) => {
  const r = dist(P[0], P[1]);
  const up = P[0][1] < P[1][1];
  [0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach((lv, i) => G.circle(P[1][0], P[1][1], r * lv, { color: fibColor(i + 1), fill: null, a0: up ? Math.PI : 0, a1: up ? 2 * Math.PI : Math.PI }));
  G.line(P[0], P[1], { dash: 1 });
});
def('fibwedge', 'Fib Wedge', 'fib', 3, (G, P) => {
  G.line(P[0], P[1]);
  if (!P[2]) return;
  G.line(P[0], P[2]);
  const r = dist(P[0], P[1]);
  let a1 = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]), a2 = Math.atan2(P[2][1] - P[0][1], P[2][0] - P[0][0]);
  const ccw = ((a2 - a1 + 2 * Math.PI) % (2 * Math.PI)) > Math.PI;
  [0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach((lv, i) => G.circle(P[0][0], P[0][1], r * lv, { color: fibColor(i + 1), fill: null, a0: a1, a1: a2, ccw }));
});
def('pitchfan', 'Pitchfan', 'fib', 3, (G, P) => {
  G.line(P[0], P[1]);
  if (!P[2]) return;
  G.line(P[1], P[2], { dash: 1 });
  [0, 0.382, 0.5, 0.618, 1].forEach((lv, i) => {
    const t = [P[1][0] + (P[2][0] - P[1][0]) * lv, P[1][1] + (P[2][1] - P[1][1]) * lv];
    G.line(...G.ext(P[0], t, false, true), { color: fibColor(i + 1), dash: 0 });
  });
});
const GANN = [0, 0.25, 0.382, 0.5, 0.618, 0.75, 1];
function gannGrid(G, P, diag) {
  const [a, b] = P;
  GANN.forEach((lv, i) => {
    const y = a[1] + (b[1] - a[1]) * lv, x = a[0] + (b[0] - a[0]) * lv;
    G.line([a[0], y], [b[0], y], { color: fibColor(i), dash: 0 });
    G.line([x, a[1]], [x, b[1]], { color: fibColor(i), dash: 0, alpha: 0.7 });
  });
  if (G.st.fill !== false) G.rect(a, b, { stroke: false, alpha: 0.05 });
  if (diag) { G.line(a, b, { dash: 1 }); G.line([a[0], b[1]], [b[0], a[1]], { dash: 1 }); }
}
def('gannbox', 'Gann Box', 'fib', 2, (G, P) => gannGrid(G, P, true), { fill: true });
def('gannsquarefixed', 'Gann Square Fixed', 'fib', 2, (G, P) => {
  const s = Math.max(Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
  const b = [P[0][0] + Math.sign(P[1][0] - P[0][0] || 1) * s, P[0][1] + Math.sign(P[1][1] - P[0][1] || 1) * s];
  gannGrid(G, [P[0], b], true);
  const r = s;
  for (const lv of [0.5, 1]) G.circle(P[0][0], P[0][1], r * lv, { fill: null, dash: 2, nohit: true });
}, { fill: true });
def('gannsquare', 'Gann Square', 'fib', 2, (G, P) => {
  gannGrid(G, P, true);
  const [a, b] = P;
  for (let i = 1; i < 4; i++) {
    G.line(a, [b[0], a[1] + (b[1] - a[1]) * i / 4], { dash: 2, alpha: 0.6, nohit: true });
    G.line(a, [a[0] + (b[0] - a[0]) * i / 4, b[1]], { dash: 2, alpha: 0.6, nohit: true });
  }
}, { fill: true });
def('gannfan', 'Gann Fan', 'fib', 2, (G, P) => {
  const [a, b] = P;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ratios = [[1, 8], [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1]];
  ratios.forEach(([n, k], i) => {
    const t = [a[0] + dx / k * (k >= n ? 1 : 1), a[1] + dy * n / k];
    const end = k >= n ? [a[0] + dx, a[1] + dy * n / k] : [a[0] + dx * k / n, a[1] + dy];
    void t;
    G.line(...G.ext(a, end, false, true), { color: fibColor(i), dash: 0 });
    G.text(`${n}/${k}`, end[0] + 3, end[1] - 6, { color: fibColor(i), size: 10, nohit: true });
  });
});

// ---- patterns
function pattern(G, P, labels, fills = [], ratios = []) {
  if (G.st.fill !== false) for (const tri of fills) if (tri.every(i => P[i])) G.poly(tri.map(i => P[i]), { stroke: false, alpha: 0.12 });
  G.polyline(P);
  for (const [a, b, c] of ratios) {
    if (!P[c]) continue;
    const r = Math.abs((P[c][1] - P[b][1]) / ((P[b][1] - P[a][1]) || 1));
    G.line(P[a], P[c], { dash: 1, alpha: 0.6, nohit: true });
    const m = mid(P[a], P[c]);
    G.text(r.toFixed(3), m[0], m[1], { bg: 'rgba(30,34,45,.85)', color: '#d1d4dc', size: 10, align: 'center', valign: 'middle', pad: 3, nohit: true });
  }
  P.forEach((p, i) => {
    if (!labels[i]) return;
    const up = i > 0 ? p[1] < P[i - 1][1] : (P[1] ? p[1] < P[1][1] : true);
    label(G, labels[i], [p[0], p[1] + (up ? -6 : 6)], { below: !up, bg: G.color });
  });
}
def('xabcd', 'XABCD Pattern', 'patterns', 5, (G, P) => pattern(G, P, ['X', 'A', 'B', 'C', 'D'], [[0, 1, 2], [2, 3, 4]], [[0, 1, 2], [1, 2, 3], [2, 3, 4]]), { fill: true });
def('cypher', 'Cypher Pattern', 'patterns', 5, (G, P) => pattern(G, P, ['X', 'A', 'B', 'C', 'D'], [[0, 1, 2], [2, 3, 4]], [[0, 1, 2], [1, 2, 3]]), { fill: true });
def('headshoulders', 'Head and Shoulders', 'patterns', 7, (G, P) => {
  pattern(G, P, ['', 'Left Shoulder', '', 'Head', '', 'Right Shoulder', ''], [[0, 1, 2], [2, 3, 4], [4, 5, 6]]);
  if (P[4]) G.line(...G.ext(P[2], P[4], true, true), { dash: 1 });
}, { fill: true });
def('abcd', 'ABCD Pattern', 'patterns', 4, (G, P) => pattern(G, P, ['A', 'B', 'C', 'D'], [], [[0, 1, 2], [1, 2, 3]]));
def('trianglepattern', 'Triangle Pattern', 'patterns', 4, (G, P) => {
  pattern(G, P, ['A', 'B', 'C', 'D'], [[0, 1, 2], [1, 2, 3]]);
  if (P[2]) G.line(...G.ext(P[0], P[2], false, true), { dash: 1 });
  if (P[3]) G.line(...G.ext(P[1], P[3], false, true), { dash: 1 });
}, { fill: true });
def('threedrives', 'Three Drives Pattern', 'patterns', 7, (G, P) => pattern(G, P, ['', '1', 'A', '2', 'B', '3', ''], [], [[1, 2, 3], [3, 4, 5]]));
const elliott = (labels) => (G, P) => {
  G.polyline(P);
  P.forEach((p, i) => {
    if (!labels[i]) return;
    const up = i > 0 ? p[1] < P[i - 1][1] : true;
    G.text(labels[i], p[0], p[1] + (up ? -6 : 6), { color: G.color, size: 12, bold: true, align: 'center', valign: up ? 'bottom' : undefined, nohit: true });
    G.dot(p, 2.5);
  });
};
def('elliott_impulse', 'Elliott Impulse Wave (12345)', 'patterns', 6, elliott(['(0)', '(1)', '(2)', '(3)', '(4)', '(5)']));
def('elliott_correction', 'Elliott Correction Wave (ABC)', 'patterns', 4, elliott(['(0)', '(A)', '(B)', '(C)']));
def('elliott_triangle', 'Elliott Triangle Wave (ABCDE)', 'patterns', 6, elliott(['(0)', '(A)', '(B)', '(C)', '(D)', '(E)']));
def('elliott_double', 'Elliott Double Combo Wave (WXY)', 'patterns', 4, elliott(['(0)', '(W)', '(X)', '(Y)']));
def('elliott_triple', 'Elliott Triple Combo Wave (WXYXZ)', 'patterns', 6, elliott(['(0)', '(W)', '(X)', '(Y)', '(X)', '(Z)']));
def('cycliclines', 'Cyclic Lines', 'patterns', 2, (G, P) => {
  const dx = P[1][0] - P[0][0];
  if (Math.abs(dx) < 2) return G.vline(P[0][0]);
  for (let k = -200; k <= 200; k++) {
    const x = P[0][0] + dx * k;
    if (x < -10 || x > G.size.width + 10) continue;
    G.vline(x, { dash: k === 0 || k === 1 ? 0 : 1 });
  }
});
def('timecycles', 'Time Cycles', 'patterns', 2, (G, P) => {
  const dx = Math.abs(P[1][0] - P[0][0]) || 1, r = dx / 2;
  for (let k = -100; k < 100; k++) {
    const cx = P[0][0] + dx * k + r;
    if (cx + r < 0 || cx - r > G.size.width) continue;
    G.circle(cx, P[0][1], r, { a0: Math.PI, a1: 2 * Math.PI, fill: null });
  }
  G.hline(P[0][1], P[0][0], G.size.width, { dash: 2, nohit: true });
});
def('sineline', 'Sine Line', 'patterns', 2, (G, P) => {
  const half = P[1][0] - P[0][0] || 1, amp = (P[1][1] - P[0][1]) / 2, cy = (P[0][1] + P[1][1]) / 2;
  const pts = [];
  for (let x = 0; x <= G.size.width; x += 3) pts.push([x, cy - amp * Math.cos(Math.PI * (x - P[0][0]) / half)]);
  G.polyline(pts);
});

// ---- forecasting and measurement
def('longpos', 'Long Position', 'forecast', 'pos', (G, P, d) => position(G, P, d));
def('shortpos', 'Short Position', 'forecast', 'pos', (G, P, d) => position(G, P, d));
function position(G, P, d) {
  const [[x0, y0], [x1, yt], [, ys]] = P;
  const left = Math.min(x0, x1), w = Math.abs(x1 - x0);
  G.rect([left, y0], [left + w, yt], { fill: 'rgba(8,153,129,0.22)', stroke: false });
  G.rect([left, y0], [left + w, ys], { fill: 'rgba(242,54,69,0.22)', stroke: false });
  G.line([left, y0], [left + w, y0], { color: '#787b86', width: 1, dash: 0 });
  const e = d.points[0].p, tp = d.points[1].p, sp = d.points[2].p;
  const tpPct = Math.abs(tp - e) / e * 100, spPct = Math.abs(sp - e) / e * 100;
  const rr = Math.abs(e - sp) ? Math.abs(tp - e) / Math.abs(e - sp) : 0;
  const cx = left + w / 2;
  const tOff = yt < y0 ? -4 : 4, sOff = ys > y0 ? 4 : -4;
  G.text(`Target: ${G.fmtP(tp)} (${tpPct.toFixed(2)}%)`, cx, yt + tOff, { bg: '#089981', color: '#fff', size: 11, bold: true, align: 'center', valign: tOff < 0 ? 'bottom' : undefined, pad: 4, nohit: true });
  G.text(`Stop: ${G.fmtP(sp)} (${spPct.toFixed(2)}%)`, cx, ys + sOff, { bg: '#f23645', color: '#fff', size: 11, bold: true, align: 'center', valign: sOff < 0 ? 'bottom' : undefined, pad: 4, nohit: true });
  G.text(`Entry ${G.fmtP(e)} · R/R ${rr.toFixed(2)}`, cx, y0 + (tOff > 0 ? -4 : 4), { bg: '#5d606b', color: '#fff', size: 11, bold: true, align: 'center', valign: tOff > 0 ? 'bottom' : undefined, pad: 4, nohit: true });
}
TOOLS.longpos.handles = TOOLS.shortpos.handles = (P) => [P[0], [P[0][0], P[1][1]], [P[0][0], P[2][1]], [P[1][0], P[0][1]]];
def('forecast', 'Forecast', 'forecast', 2, (G, P, d) => {
  const up = d.points[1].p >= d.points[0].p;
  const c = up ? '#089981' : '#f23645';
  G.line(P[0], P[1], { color: c, dash: 1 });
  G.dot(P[0], 4, '#787b86'); G.dot(P[1], 4, c);
  const m = measureInfo(G, d);
  G.text(`${m.txtP}\n${m.nb} bars`, P[1][0] + 8, P[1][1], { bg: c, color: '#fff', size: 11, bold: true, valign: 'middle', pad: 5 });
});
def('barspattern', 'Bars Pattern', 'forecast', 3, (G, P, d) => {
  const bars = G.bars();
  let i0 = Math.round(G.idx(d.points[0].t)), i1 = Math.round(G.idx(d.points[1].t));
  if (i0 > i1) [i0, i1] = [i1, i0];
  i0 = Math.max(0, i0); i1 = Math.min(bars.length - 1, i1);
  G.line(P[0], P[1], { dash: 2 });
  if (!P[2] || i1 <= i0) return;
  const startL = G.idx(d.points[2].t), off = d.points[2].p - bars[i0].open;
  const ts = G.m.h.chart.timeScale();
  const bw = Math.max(1, (ts.logicalToCoordinate(startL + 1) - ts.logicalToCoordinate(startL)) * 0.35);
  for (let i = i0; i <= i1; i++) {
    const b = bars[i], x = ts.logicalToCoordinate(startL + (i - i0));
    if (x == null) continue;
    const c = b.close >= b.open ? G.color : hexA(G.color, 0.45);
    G.line([x, G.y(b.high + off)], [x, G.y(b.low + off)], { color: c, width: 1, dash: 0 });
    G.line([x - bw, G.y(b.open + off)], [x, G.y(b.open + off)], { color: c, width: 1, dash: 0, nohit: true });
    G.line([x, G.y(b.close + off)], [x + bw, G.y(b.close + off)], { color: c, width: 1, dash: 0, nohit: true });
  }
});
def('ghostfeed', 'Ghost Feed', 'forecast', 2, (G, P, d) => {
  const [a, b] = d.points;
  const l0 = G.idx(a.t), l1 = G.idx(b.t), n = Math.max(1, Math.round(l1 - l0));
  let seed = 0; for (const ch of d.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ts = G.m.h.chart.timeScale();
  const bw = Math.max(1, (ts.logicalToCoordinate(l0 + 1) - ts.logicalToCoordinate(l0)) * 0.35);
  const vol = Math.abs(b.p - a.p) / n * 1.5 || a.p * 0.002;
  let prev = a.p;
  for (let i = 1; i <= n; i++) {
    const target = a.p + (b.p - a.p) * i / n;
    const close = target + (rnd() - 0.5) * vol * 2;
    const hi = Math.max(prev, close) + rnd() * vol, lo = Math.min(prev, close) - rnd() * vol;
    const x = ts.logicalToCoordinate(l0 + i);
    if (x != null) {
      const c = close >= prev ? 'rgba(8,153,129,.55)' : 'rgba(242,54,69,.55)';
      G.line([x, G.y(hi)], [x, G.y(lo)], { color: c, width: 1, dash: 0, nohit: true });
      G.rect([x - bw, G.y(prev)], [x + bw, G.y(close)], { fill: c, stroke: false, nohit: true });
    }
    prev = close;
  }
  G.line(P[0], P[1], { dash: 2, alpha: 0.6 });
});
def('projection', 'Projection', 'forecast', 3, (G, P, d) => {
  G.polyline(P);
  if (!P[2]) return;
  if (G.st.fill !== false) G.poly(P, { stroke: false, alpha: 0.1 });
  const [a, b, c] = d.points;
  const r1 = (b.p - a.p) / a.p * 100, r2 = (c.p - b.p) / b.p * 100;
  const ratio = Math.abs((c.p - b.p) / ((b.p - a.p) || 1));
  G.text(`${r1 >= 0 ? '+' : ''}${r1.toFixed(2)}%`, ...mid(P[0], P[1]), { bg: 'rgba(30,34,45,.85)', color: '#d1d4dc', size: 11, align: 'center', valign: 'middle', pad: 3, nohit: true });
  G.text(`${r2 >= 0 ? '+' : ''}${r2.toFixed(2)}% (${ratio.toFixed(3)})`, ...mid(P[1], P[2]), { bg: 'rgba(30,34,45,.85)', color: '#d1d4dc', size: 11, align: 'center', valign: 'middle', pad: 3, nohit: true });
}, { fill: true });
def('avwap', 'Anchored VWAP', 'forecast', 1, (G, P, d) => {
  const bars = G.bars();
  const i0 = Math.max(0, Math.round(G.idx(d.points[0].t)));
  let pv = 0, vv = 0;
  const pts = [];
  for (let i = i0; i < bars.length; i++) {
    const b = bars[i], tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume; vv += b.volume;
    const x = G.xOfIdx(i);
    if (x != null && vv) pts.push([x, G.y(pv / vv)]);
  }
  if (pts.length > 1) G.polyline(pts);
  G.dot(P[0], 3.5);
  d._last = vv ? pv / vv : null;
});
function volumeProfile(G, i0, i1, xLeft, xRight) {
  const bars = G.bars();
  if (i0 > i1) [i0, i1] = [i1, i0];
  i0 = Math.max(0, i0); i1 = Math.min(bars.length - 1, i1);
  if (i1 < i0) return;
  let lo = Infinity, hi = -Infinity;
  for (let i = i0; i <= i1; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); }
  const rows = 24, step = (hi - lo) / rows || 1;
  const up = new Array(rows).fill(0), dn = new Array(rows).fill(0);
  // OHLCV approximation: spread each bar's volume evenly across its high-low range
  for (let i = i0; i <= i1; i++) {
    const b = bars[i];
    const r0 = Math.max(0, Math.floor((b.low - lo) / step)), r1 = Math.min(rows - 1, Math.floor((b.high - lo) / step));
    const share = b.volume / (r1 - r0 + 1);
    for (let r = r0; r <= r1; r++) (b.close >= b.open ? up : dn)[r] += share;
  }
  const tot = up.map((v, i) => v + dn[i]);
  const max = Math.max(...tot) || 1;
  const poc = tot.indexOf(Math.max(...tot));
  // value area 70%
  const sum = tot.reduce((a, b) => a + b, 0);
  let va = tot[poc], a = poc, b = poc;
  while (va < sum * 0.7 && (a > 0 || b < rows - 1)) {
    const na = a > 0 ? tot[a - 1] : -1, nb = b < rows - 1 ? tot[b + 1] : -1;
    if (nb >= na) va += tot[++b]; else va += tot[--a];
  }
  const width = Math.max(40, (xRight - xLeft) * 0.3);
  for (let r = 0; r < rows; r++) {
    const y0 = G.y(lo + r * step), y1 = G.y(lo + (r + 1) * step);
    const inVa = r >= a && r <= b;
    const wu = up[r] / max * width, wd = dn[r] / max * width;
    G.rect([xLeft, y0 - 0.5], [xLeft + wu, y1 + 0.5], { fill: inVa ? 'rgba(8,153,129,.45)' : 'rgba(8,153,129,.2)', stroke: false });
    G.rect([xLeft + wu, y0 - 0.5], [xLeft + wu + wd, y1 + 0.5], { fill: inVa ? 'rgba(242,54,69,.45)' : 'rgba(242,54,69,.2)', stroke: false });
  }
  const yp = G.y(lo + (poc + 0.5) * step);
  G.line([xLeft, yp], [xRight, yp], { color: '#ff9800', width: 1, dash: 0, nohit: true });
  G.rect([xLeft, G.y(hi)], [xRight, G.y(lo)], { fill: null, color: G.color, dash: 2, nohit: true });
}
def('fixedvp', 'Fixed Range Volume Profile', 'forecast', 2, (G, P, d) => {
  volumeProfile(G, Math.round(G.idx(d.points[0].t)), Math.round(G.idx(d.points[1].t)), Math.min(P[0][0], P[1][0]), Math.max(P[0][0], P[1][0]));
  G.vline(P[0][0], { dash: 2, alpha: 0.4, nohit: true }); G.vline(P[1][0], { dash: 2, alpha: 0.4, nohit: true });
}, { timeOnly: true, handles: (P) => P.map(p => [p[0], 14]) });
def('anchoredvp', 'Anchored Volume Profile', 'forecast', 1, (G, P, d) => {
  const n = G.bars().length;
  volumeProfile(G, Math.round(G.idx(d.points[0].t)), n - 1, P[0][0], G.xOfIdx(n - 1) ?? G.size.width);
  G.vline(P[0][0], { dash: 2, alpha: 0.5 });
}, { timeOnly: true, handles: (P) => [[P[0][0], 14]] });
def('pricerange', 'Price Range', 'forecast', 2, (G, P, d) => {
  const m = measureInfo(G, d);
  const c = m.dp >= 0 ? '#2962ff' : '#f23645';
  G.rect(P[0], P[1], { color: c, alpha: 0.18, stroke: false });
  const mx = (P[0][0] + P[1][0]) / 2;
  G.line([mx, P[0][1]], [mx, P[1][1]], { color: c, width: 1, dash: 0 });
  G.hline(P[0][1], P[0][0], P[1][0], { color: c, width: 1, dash: 0 }); G.hline(P[1][1], P[0][0], P[1][0], { color: c, width: 1, dash: 0 });
  G.text(m.txtP, mx, Math.min(P[0][1], P[1][1]) - 4, { bg: c, color: '#fff', size: 11, bold: true, align: 'center', valign: 'bottom', pad: 4, nohit: true });
});
def('daterange', 'Date Range', 'forecast', 2, (G, P, d) => {
  const m = measureInfo(G, d);
  const c = '#2962ff';
  G.rect(P[0], P[1], { color: c, alpha: 0.18, stroke: false });
  const my = (P[0][1] + P[1][1]) / 2;
  G.line([P[0][0], my], [P[1][0], my], { color: c, width: 1, dash: 0 });
  G.vline(P[0][0], { color: c, width: 1, dash: 0, nohit: true });
  G.vline(P[1][0], { color: c, width: 1, dash: 0, nohit: true });
  G.text(`${m.nb} bars, ${m.dur}`, (P[0][0] + P[1][0]) / 2, Math.max(P[0][1], P[1][1]) + 6, { bg: c, color: '#fff', size: 11, bold: true, align: 'center', pad: 4, nohit: true });
});
function measureRender(G, P, d) {
  const m = measureInfo(G, d);
  const c = m.dp >= 0 ? '#2962ff' : '#f23645';
  G.rect(P[0], P[1], { color: c, alpha: 0.18, stroke: false });
  const mx = (P[0][0] + P[1][0]) / 2, my = (P[0][1] + P[1][1]) / 2;
  G.line([mx, P[0][1]], [mx, P[1][1]], { color: c, width: 1, dash: 0 });
  G.line([P[0][0], my], [P[1][0], my], { color: c, width: 1, dash: 0 });
  const up = m.dp >= 0;
  G.text(`${m.txtP}\n${m.nb} bars, ${m.dur}`, mx, up ? Math.min(P[0][1], P[1][1]) - 6 : Math.max(P[0][1], P[1][1]) + 6, { bg: c, color: '#fff', size: 12, bold: true, align: 'center', valign: up ? 'bottom' : undefined, pad: 6, nohit: true });
}
def('measure', 'Date and Price Range', 'forecast', 2, measureRender);
def('ruler', 'Measure', 'forecast', 2, measureRender, { temp: true, hidden: true });
def('zoom', 'Zoom In', 'forecast', 2, (G, P) => G.rect(P[0], P[1], { color: '#2962ff', alpha: 0.12, dash: 1 }), { temp: true, hidden: true });

// ---- geometric shapes
def('brush', 'Brush', 'shapes', 'free', (G, P) => G.polyline(P));
def('highlighter', 'Highlighter', 'shapes', 'free', (G, P) => G.polyline(P, { alpha: 0.35, tol: 8 }));
def('arrowmarker', 'Arrow Marker', 'shapes', 2, (G, P) => {
  const [a, b] = P, ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = dist(a, b);
  const w = Math.max(4, Math.min(14, L * 0.08)), hl = Math.min(L * 0.4, w * 3);
  const rot = ([x, y]) => [a[0] + x * Math.cos(ang) - y * Math.sin(ang), a[1] + x * Math.sin(ang) + y * Math.cos(ang)];
  G.poly([[0, -w / 2], [L - hl, -w / 2], [L - hl, -w * 1.5], [L, 0], [L - hl, w * 1.5], [L - hl, w / 2], [0, w / 2]].map(rot), { fill: G.color, stroke: false });
});
def('arrow', 'Arrow', 'shapes', 2, (G, P) => {
  const [a, b] = P;
  G.line(a, b);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 10 + (G.st.width || 1) * 2;
  G.line(b, [b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)], { dash: 0 });
  G.line(b, [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)], { dash: 0 });
});
const arrowMark = (dir) => (G, P, d) => {
  const [x, y] = P[0], s = 9;
  const pts = dir > 0
    ? [[x, y], [x + s, y + s], [x + s / 2.4, y + s], [x + s / 2.4, y + s * 2.2], [x - s / 2.4, y + s * 2.2], [x - s / 2.4, y + s], [x - s, y + s]]
    : [[x, y], [x + s, y - s], [x + s / 2.4, y - s], [x + s / 2.4, y - s * 2.2], [x - s / 2.4, y - s * 2.2], [x - s / 2.4, y - s], [x - s, y - s]];
  G.poly(pts, { fill: G.color, stroke: false });
  if (d.text) G.text(d.text, x, dir > 0 ? y + s * 2.2 + 4 : y - s * 2.2 - 4, { color: G.color, align: 'center', valign: dir > 0 ? undefined : 'bottom' });
};
def('arrowup', 'Arrow Mark Up', 'shapes', 1, arrowMark(1), { text: true });
def('arrowdown', 'Arrow Mark Down', 'shapes', 1, arrowMark(-1), { text: true });
def('rect', 'Rectangle', 'shapes', 2, (G, P) => G.rect(P[0], P[1]), { alert: true, fill: true });
def('rotrect', 'Rotated Rectangle', 'shapes', 3, (G, P) => {
  if (!P[2]) return G.line(P[0], P[1]);
  const [a, b, c] = P;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const h = (c[0] - b[0]) * nx + (c[1] - b[1]) * ny;
  G.poly([a, b, [b[0] + nx * h, b[1] + ny * h], [a[0] + nx * h, a[1] + ny * h]]);
}, { fill: true });
def('path', 'Path', 'shapes', 'multi', (G, P) => {
  G.polyline(P);
  if (P.length < 2) return;
  const a = P[P.length - 2], b = P[P.length - 1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 12;
  G.line(b, [b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)], { dash: 0 });
  G.line(b, [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)], { dash: 0 });
});
def('polyline', 'Polyline', 'shapes', 'multi', (G, P) => {
  if (P.length > 2 && G.st.fill !== false && G.st.closed) G.poly(P); else G.polyline(P, { close: !!G.st.closed });
}, { fill: true });
def('circle', 'Circle', 'shapes', 2, (G, P) => G.circle(P[0][0], P[0][1], dist(P[0], P[1])), { fill: true });
def('ellipse', 'Ellipse', 'shapes', 2, (G, P) => {
  const cx = (P[0][0] + P[1][0]) / 2, cy = (P[0][1] + P[1][1]) / 2, rx = Math.abs(P[1][0] - P[0][0]) / 2, ry = Math.abs(P[1][1] - P[0][1]) / 2;
  const pts = [];
  for (let i = 0; i < 64; i++) { const a = i / 64 * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  G.poly(pts);
}, { fill: true });
def('triangle', 'Triangle', 'shapes', 3, (G, P) => (P[2] ? G.poly(P) : G.line(P[0], P[1])), { fill: true });
def('arc', 'Arc', 'shapes', 3, (G, P) => {
  if (!P[2]) return G.line(P[0], P[1]);
  G.poly(quadPts(P[0], passCtrl(P[0], P[1], P[2]), P[1]));
}, { fill: true });
def('curve', 'Curve', 'shapes', 3, (G, P) => (P[2] ? G.polyline(quadPts(P[0], passCtrl(P[0], P[1], P[2]), P[1])) : G.line(P[0], P[1])));
def('doublecurve', 'Double Curve', 'shapes', 4, (G, P) => {
  if (!P[3]) return G.polyline(P);
  G.polyline(cubicPts(P[0], P[2], P[3], P[1]));
  G.line(P[0], P[2], { dash: 2, alpha: 0.4, nohit: true }); G.line(P[1], P[3], { dash: 2, alpha: 0.4, nohit: true });
});

// ---- annotation
const txt = (d, def0 = 'Text') => (d.text == null || d.text === '' ? def0 : d.text);
def('text', 'Text', 'annotation', 1, (G, P, d) => G.text(txt(d), P[0][0], P[0][1], { color: G.color, bg: G.st.bg ? hexA(G.st.bg, 0.85) : null, valign: 'bottom' }), { text: true });
def('anchoredtext', 'Anchored Text', 'annotation', 1, (G, P, d) => G.text(txt(d), P[0][0], P[0][1], { color: G.color, bg: 'rgba(30,34,45,.9)', border: '#363a45', valign: 'middle', pad: 8 }), { text: true });
def('note', 'Note', 'annotation', 1, (G, P, d) => {
  G.dot(P[0], 4);
  const box = G.text(txt(d, 'Note'), P[0][0] + 10, P[0][1] - 10, { color: '#d1d4dc', bg: 'rgba(30,34,45,.95)', border: G.color, valign: 'bottom', pad: 8 });
  G.line(P[0], [box[0], box[1] + box[3]], { width: 1, dash: 0, nohit: true });
}, { text: true });
def('pricenote', 'Price Note', 'annotation', 2, (G, P, d) => {
  G.dot(P[0], 3.5);
  G.line(P[0], P[1], { width: 1, dash: 0 });
  G.text(G.fmtP(d.points[0].p), P[1][0], P[1][1], { bg: G.color, color: '#fff', size: 12, align: 'center', valign: 'middle', pad: 5 });
});
def('pin', 'Pin', 'annotation', 1, (G, P, d) => {
  const [x, y] = P[0];
  G.circle(x, y - 18, 8, { fill: G.color });
  G.poly([[x - 5, y - 13], [x + 5, y - 13], [x, y]], { fill: G.color, stroke: false });
  G.circle(x, y - 18, 3, { fill: '#fff', color: '#fff', nohit: true });
  if (d.text) G.text(d.text, x + 12, y - 18, { color: '#d1d4dc', bg: 'rgba(30,34,45,.95)', border: G.color, valign: 'middle' });
}, { text: true });
def('callout', 'Callout', 'annotation', 2, (G, P, d) => {
  const box = G.text(txt(d, 'Callout'), P[1][0], P[1][1], { color: '#fff', bg: G.color, align: 'center', valign: 'middle', pad: 8 });
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  const ang = Math.atan2(P[0][1] - cy, P[0][0] - cx), w = 8;
  G.poly([[cx + w * Math.cos(ang + 1.57), cy + w * Math.sin(ang + 1.57)], P[0], [cx + w * Math.cos(ang - 1.57), cy + w * Math.sin(ang - 1.57)]], { fill: G.color, stroke: false });
}, { text: true });
def('comment', 'Comment', 'annotation', 1, (G, P, d) => {
  const [x, y] = P[0];
  const box = G.text(txt(d, 'Comment'), x, y - 12, { color: '#fff', bg: G.color, valign: 'bottom', pad: 8, radius: 10 });
  G.poly([[box[0] + 6, box[1] + box[3] - 1], [x, y], [box[0] + 18, box[1] + box[3] - 1]], { fill: G.color, stroke: false });
}, { text: true });
def('pricelabel', 'Price Label', 'annotation', 1, (G, P, d) => {
  const [x, y] = P[0];
  const box = G.text(G.fmtP(d.points[0].p), x + 10, y - 22, { color: '#fff', bg: G.color, valign: 'bottom', pad: 5 });
  G.poly([[box[0] + 4, box[1] + box[3] - 1], [x, y], [box[0] + 14, box[1] + box[3] - 1]], { fill: G.color, stroke: false });
});
def('signpost', 'Signpost', 'annotation', 1, (G, P, d) => {
  const [x, y] = P[0];
  G.line([x, y], [x, y - 50], { width: 2, dash: 0 });
  G.dot([x, y], 3);
  G.text(txt(d, 'Signpost'), x, y - 50, { color: '#fff', bg: G.color, align: 'center', valign: 'bottom', pad: 6 });
}, { text: true });
def('flagmark', 'Flag Mark', 'annotation', 1, (G, P, d) => {
  const [x, y] = P[0];
  G.line([x, y], [x, y - 28], { width: 2, dash: 0 });
  G.poly([[x, y - 28], [x + 18, y - 23], [x, y - 17]], { fill: G.color, stroke: false });
  if (d.text) G.text(d.text, x + 22, y - 24, { color: G.color, valign: 'middle', size: 12 });
}, { text: true });

for (const t of Object.values(TOOLS)) if (t.text) t.textEdit = true;

const HANDLE_R = 5;
const HIT_TOL = 6;

// ============================================================================ manager
export class DrawingManager {
  /**
   * host: { chart, container, getBars(), tfSec(), tz(), symbol(), fmtPrice(p), fmtTime(t),
   *         magnet(), keepDrawing(), onSelect(d|null), onToolChange(tool), editText(d), toast(), onZoom(l0, l1) }
   */
  constructor(host) {
    this.h = host;
    this.drawings = [];
    this.tool = 'cursor';
    this.cursorMode = 'cross';
    this.selectedId = null;
    this.hoverId = null;
    this.creating = null;
    this.drag = null;
    this.hidden = false;
    this.locked = false;
    this.alertLines = [];
    this.alertDrawingIds = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.synced = new Map();
    this.temp = null; // temporary drawing (Measure)
    this._scrollEnabled = true;
    this._axisCache = [];
    this._timeAxisCache = [];

    const self = this;
    this._views = [{
      zOrder: () => 'top',
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => self._render(context, mediaSize)) }),
    }];
    this.primitive = {
      attached: ({ requestUpdate }) => { self._requestUpdate = requestUpdate; },
      detached: () => { self._requestUpdate = null; },
      updateAllViews: () => { self._rebuildAxisViews(); },
      paneViews: () => self._views,
      priceAxisViews: () => self._axisCache,
      timeAxisViews: () => self._timeAxisCache,
    };
    this._bindEvents();
  }

  // ------------------------------------------------------------------ public API
  attach(series) {
    if (this._series) { try { this._series.detachPrimitive(this.primitive); } catch { /* gone */ } }
    this._series = series;
    series.attachPrimitive(this.primitive);
  }

  update() { this._rebuildAxisViews(); if (this._requestUpdate) this._requestUpdate(); }

  setDrawings(list) {
    this.drawings = list.filter(d => TOOLS[d.tool]).map(d => ({ style: {}, ...d }));
    this.synced = new Map(this.drawings.map(d => [d.id, JSON.stringify(strip(d))]));
    this.undoStack = []; this.redoStack = [];
    this.temp = null;
    this.select(null);
    this.update();
  }

  setTool(tool) {
    this._cancelCreating();
    if (TOOLS[tool]?.cursor) {
      this.cursorMode = tool;
      this.tool = 'cursor';
      this.h.chart.applyOptions({ crosshair: { vertLine: { visible: tool === 'cross' }, horzLine: { visible: tool === 'cross' } } });
    } else this.tool = tool;
    this._setScroll(this.tool === 'cursor');
    this._applyCursor();
    this.h.onToolChange?.(this.tool);
  }

  _applyCursor() {
    const c = this.h.container.style;
    if (this.tool !== 'cursor') c.cursor = 'crosshair';
    else c.cursor = this.cursorMode === 'eraser' ? 'cell' : this.cursorMode === 'arrowcursor' ? 'default' : this.cursorMode === 'dot' ? 'crosshair' : '';
  }

  select(id) {
    this.selectedId = id;
    this.h.onSelect?.(this.selected());
    this.update();
  }

  selected() { return this.drawings.find(d => d.id === this.selectedId) || null; }

  updateSelected(patch, stylePatch) {
    const d = this.selected();
    if (!d) return;
    this.checkpoint();
    Object.assign(d, patch || {});
    if (stylePatch) d.style = { ...d.style, ...stylePatch };
    this.commit();
  }

  removeSelected() {
    const d = this.selected();
    if (!d) return;
    this.checkpoint();
    this.drawings = this.drawings.filter(x => x !== d);
    this.select(null);
    this.commit();
  }

  remove(d) {
    this.checkpoint();
    this.drawings = this.drawings.filter(x => x !== d);
    if (this.selectedId === d.id) this.select(null);
    this.commit();
  }

  cloneSelected() {
    const d = this.selected();
    if (!d) return;
    this.checkpoint();
    const c = clone(strip(d));
    c.id = uid();
    const sec = this.h.tfSec();
    c.points = c.points.map(p => ({ t: p.t + sec * 5, p: p.p }));
    c.z = this._nextZ();
    this.drawings.push(c);
    this.select(c.id);
    this.commit();
  }

  removeAll() {
    if (!this.drawings.length) return;
    this.checkpoint();
    this.drawings = [];
    this.select(null);
    this.commit();
  }

  checkpoint() {
    this.undoStack.push(JSON.stringify(this.drawings.map(strip)));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.drawings.map(strip)));
    this.drawings = JSON.parse(this.undoStack.pop());
    if (!this.selected()) this.select(null);
    this.commit();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.drawings.map(strip)));
    this.drawings = JSON.parse(this.redoStack.pop());
    if (!this.selected()) this.select(null);
    this.commit();
  }

  commit() {
    this.update();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._persist(), 300);
  }

  async _persist() {
    const symbol = this.h.symbol();
    const changed = [], seen = new Set();
    for (const d of this.drawings) {
      seen.add(d.id);
      const s = JSON.stringify(strip(d));
      if (this.synced.get(d.id) !== s) changed.push(strip(d));
    }
    const deleted = [...this.synced.keys()].filter(id => !seen.has(id));
    try {
      if (changed.length) await api.saveDrawings(symbol, changed);
      if (deleted.length) await api.deleteDrawings(symbol, deleted);
      for (const d of changed) this.synced.set(d.id, JSON.stringify(d));
      for (const id of deleted) this.synced.delete(id);
    } catch (e) {
      console.error('drawing save failed', e);
      this.h.toast?.('Could not save drawings: ' + e.message, 'error');
    }
  }

  // ------------------------------------------------------------------ coordinates
  _barsIdx(t) {
    const bars = this.h.getBars();
    const n = bars.length, sec = this.h.tfSec();
    if (!n) return null;
    if (t <= bars[0].time) return (t - bars[0].time) / sec;
    if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / sec;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bars[m].time <= t) lo = m; else hi = m; }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }

  _idxTime(l) {
    const bars = this.h.getBars(), n = bars.length, sec = this.h.tfSec();
    if (!n) return 0;
    if (l <= 0) return bars[0].time + l * sec;
    if (l >= n - 1) return bars[n - 1].time + (l - (n - 1)) * sec;
    const i = Math.floor(l), f = l - i;
    return bars[i].time + f * (bars[i + 1].time - bars[i].time);
  }

  toX(tUtc) {
    const l = this._barsIdx(tUtc + this.h.tz());
    return l == null ? null : this.h.chart.timeScale().logicalToCoordinate(l);
  }

  toY(p) { return this._series ? this._series.priceToCoordinate(p) : null; }

  xy(pt) { return [this.toX(pt.t), this.toY(pt.p)]; }

  fromXY(x, y, snap = true) {
    let l = this.h.chart.timeScale().coordinateToLogical(x);
    if (l == null) return null;
    if (snap) l = Math.round(l);
    let p = this._series.coordinateToPrice(y);
    if (p == null) return null;
    if (snap && this.h.magnet()) {
      const bars = this.h.getBars();
      const b = bars[Math.max(0, Math.min(bars.length - 1, l))];
      if (b) {
        let best = null, bd = 40;
        for (const v of [b.open, b.high, b.low, b.close]) {
          const dd = Math.abs(this.toY(v) - y);
          if (dd < bd) { bd = dd; best = v; }
        }
        if (best != null) p = best;
      }
    }
    return { t: Math.round(this._idxTime(l) - this.h.tz()), p };
  }

  // ------------------------------------------------------------------ axis labels
  _rebuildAxisViews() {
    const out = [], tout = [];
    const s = this._series;
    if (!s) { this._axisCache = out; this._timeAxisCache = tout; return; }
    const plabel = (price, color, prefix = '') => ({
      coordinate: () => { const y = s.priceToCoordinate(price); return y == null ? -1000 : y; },
      text: () => prefix + this.h.fmtPrice(price), textColor: () => '#ffffff', backColor: () => color,
      visible: () => true, tickVisible: () => true,
    });
    const tlabel = (t, color) => ({
      coordinate: () => { const x = this.toX(t); return x == null ? -1000 : x; },
      text: () => this.h.fmtTime(t + this.h.tz()), textColor: () => '#ffffff', backColor: () => color,
      visible: () => true, tickVisible: () => true,
    });
    if (!this.hidden) {
      for (const d of this.drawings) {
        if (d.hidden || !d.points[0]) continue;
        const ax = TOOLS[d.tool]?.axis;
        if (ax === 'price' || ax === 'both') out.push(plabel(d.points[0].p, d.style.color || '#f7a600'));
        if (ax === 'time' || ax === 'both') tout.push(tlabel(d.points[0].t, d.style.color || '#787b86'));
      }
      const sel = this.selected();
      if (sel && !TOOLS[sel.tool]?.axis && sel.points.length <= 8) {
        for (const p of sel.points) { out.push(plabel(p.p, '#2962ff')); tout.push(tlabel(p.t, '#2962ff')); }
      }
    }
    for (const a of this.alertLines) out.push(plabel(a.price, a.color || '#ff9800', '⏰ '));
    this._axisCache = out;
    this._timeAxisCache = tout;
  }

  // ------------------------------------------------------------------ rendering
  _render(ctx, size) {
    ctx.save();
    for (const a of this.alertLines) {
      const y = this.toY(a.price);
      if (y == null) continue;
      ctx.strokeStyle = a.color || '#ff9800'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size.width, y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!this.hidden) {
      const list = [...this.drawings].sort((a, b) => (a.z || 0) - (b.z || 0));
      if (this.creating) list.push(this.creating.d);
      if (this.temp) list.push(this.temp);
      for (const d of list) {
        if (d.hidden) continue;
        try { this._drawOne(ctx, d, size); } catch (e) { console.warn('draw failed', d.tool, e); }
      }
      const sel = this.selected();
      if (sel && !sel.hidden) this._drawHandles(ctx, sel);
      if (this.creating) this._drawHandles(ctx, this.creating.d);
    }
    ctx.restore();
  }

  _drawOne(ctx, d, size) {
    const P = d.points.map(p => this.xy(p));
    if (!P.length || P.some(([x, y]) => x == null || y == null)) { d._hits = []; return; }
    const g = new G(ctx, size, this, d);
    if (d.id === this.hoverId) g.st = { ...g.st, width: (g.st.width || 1) + 0.5 };
    R[d.tool]?.(g, P, d);
    d._hits = g.hits;
    d._P = P;
    if (this.alertDrawingIds.has(d.id)) {
      ctx.font = g.font(12);
      ctx.fillStyle = '#ff9800';
      const p = P[P.length - 1];
      ctx.fillText('⏰', Math.min(p[0] + 4, size.width - 60), p[1] - 4);
    }
  }

  _handlePositions(d) {
    const def = TOOLS[d.tool];
    if (!def || def.pts === 'free') return [];
    const P = d._P || d.points.map(p => this.xy(p));
    if (P.some(p => p[0] == null)) return [];
    return def.handles ? def.handles(P, d) : P;
  }

  _drawHandles(ctx, d) {
    ctx.setLineDash([]);
    for (const [x, y] of this._handlePositions(d)) {
      if (x == null || y == null) continue;
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#131722'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#2962ff'; ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ hit testing
  _hit(x, y) {
    if (this.hidden) return null;
    const sel = this.selected();
    if (sel && !sel.hidden) {
      const hs = this._handlePositions(sel);
      for (let i = 0; i < hs.length; i++) if (hs[i][0] != null && Math.hypot(hs[i][0] - x, hs[i][1] - y) <= HANDLE_R + 3) return { d: sel, handle: i };
    }
    const list = [...this.drawings].filter(d => !d.hidden).sort((a, b) => (b.z || 0) - (a.z || 0));
    for (const d of list) if (this._hitBody(d, x, y)) return { d, handle: -1 };
    return null;
  }

  _hitBody(d, x, y) {
    for (const h of d._hits || []) {
      if (h.s) { if (distSeg(x, y, ...h.s) <= (h.tol || HIT_TOL)) return true; }
      else if (h.poly) { if (inPoly(x, y, h.poly)) return true; }
      else if (h.box) { const [bx, by, bw, bh] = h.box; if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return true; }
      else if (h.c) {
        const [cx, cy, r] = h.c, dd = Math.hypot(x - cx, y - cy);
        if (h.filled ? dd <= r : Math.abs(dd - r) <= HIT_TOL) {
          if (h.a0 == null) return true;
          let a = Math.atan2(y - cy, x - cx);
          const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const a0 = norm(h.a0), a1 = norm(h.a1); a = norm(a);
          if (a0 <= a1 ? a >= a0 && a <= a1 : a >= a0 || a <= a1) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ interaction
  // The price pane may sit below indicator panes: coordinates are relative to its top edge.
  _mainPane() {
    try { return this._series ? this._series.getPane() : this.h.chart.panes()[0]; } catch { return this.h.chart.panes()[0]; }
  }

  _paneHeight() {
    const p = this._mainPane();
    return p ? p.getHeight() : this.h.container.clientHeight;
  }

  _local(e) {
    const r = this.h.container.getBoundingClientRect();
    const pe = this._mainPane()?.getHTMLElement();
    const top = pe ? pe.getBoundingClientRect().top - r.top : 0;
    return [e.clientX - r.left, e.clientY - r.top - top];
  }

  _inPane(x, y) {
    return x >= 0 && y >= 0 && x <= this.h.chart.timeScale().width() && y <= this._paneHeight();
  }

  _setScroll(on) {
    if (this._scrollEnabled === on) return;
    this._scrollEnabled = on;
    this.h.chart.applyOptions({ handleScroll: on, handleScale: on });
  }

  _nextZ() { return this.drawings.reduce((m, d) => Math.max(m, d.z || 0), 0) + 1; }

  _newDrawing(tool, pt) {
    const d = { id: uid(), tool, points: [], style: defaultStyle(tool), z: this._nextZ() };
    const sec = this.h.tfSec();
    const def = TOOLS[tool];
    if (def.pts === 'pos') {
      const s = tool === 'longpos' ? 1 : -1;
      const t1 = pt.t + sec * 25;
      d.points = [{ ...pt }, { t: t1, p: pt.p * (1 + s * 0.02) }, { t: t1, p: pt.p * (1 - s * 0.01) }];
    } else if (def.pts === 1) d.points = [{ ...pt }];
    else d.points = [{ ...pt }, { ...pt }];
    if (def.textEdit) d.text = '';
    return d;
  }

  _finishCreating() {
    const d = this.creating.d;
    this.creating = null;
    const def = TOOLS[d.tool];
    if (def.pts === 'multi' && d.points.length > 2) d.points.pop(); // drop the rubber-band point
    if (d.tool === 'zoom') {
      const l0 = this._barsIdx(d.points[0].t + this.h.tz()), l1 = this._barsIdx(d.points[1].t + this.h.tz());
      if (Math.abs(l1 - l0) >= 2) this.h.onZoom?.(Math.min(l0, l1), Math.max(l0, l1));
      this.setTool('cursor');
      this.update();
      return;
    }
    if (def.temp) {
      this.temp = d;
      this.setTool('cursor');
      this.update();
      return;
    }
    this.checkpoint();
    this.drawings.push(d);
    this.setTool(this.h.keepDrawing?.() ? d.tool : 'cursor');
    this.select(d.id);
    this.commit();
    if (def.textEdit && d.tool !== 'arrowup' && d.tool !== 'arrowdown' && d.tool !== 'flagmark' && d.tool !== 'pin') this.h.editText?.(d);
  }

  _cancelCreating() {
    if (!this.creating) return;
    const c = this.creating;
    if (TOOLS[c.d.tool].pts === 'multi' && c.d.points.length > 2) { this._finishCreating(); return; }
    this.creating = null;
    this.update();
  }

  _bindEvents() {
    const el = this.h.container;
    el.addEventListener('pointerdown', (e) => this._onDown(e), true);
    el.addEventListener('pointermove', (e) => this._onMove(e), true);
    window.addEventListener('pointermove', (e) => this._onDragMove(e));
    window.addEventListener('pointerup', (e) => this._onUp(e));
    el.addEventListener('dblclick', (e) => {
      if (this.creating && TOOLS[this.creating.d.tool].pts === 'multi') { e.stopPropagation(); this._finishCreating(); return; }
      const [x, y] = this._local(e);
      const hit = this._hit(x, y);
      if (hit && TOOLS[hit.d.tool]?.textEdit) { e.stopPropagation(); this.h.editText?.(hit.d); }
    }, true);
    el.addEventListener('pointerleave', () => { if (!this.drag && this.tool === 'cursor') this._setScroll(true); });
  }

  _onDown(e) {
    if (e.button !== 0 || !this._series) return;
    const [x, y] = this._local(e);
    if (!this._inPane(x, y)) return;
    if (this.temp) { this.temp = null; this.update(); }

    if (this.tool !== 'cursor') {
      e.preventDefault(); e.stopPropagation();
      const pt = this.fromXY(x, y);
      if (!pt) return;
      const def = TOOLS[this.tool];
      if (this.creating) {
        const c = this.creating, d = c.d;
        if (def.pts === 'multi') { d.points[d.points.length - 1] = pt; d.points.push({ ...pt }); this.update(); return; }
        d.points[c.step] = pt;
        if (c.step + 1 >= def.pts) { this._finishCreating(); return; }
        c.step++;
        d.points.push({ ...pt });
        this.update();
        return;
      }
      const d = this._newDrawing(this.tool, pt);
      if (def.pts === 1 || def.pts === 'pos') { this.creating = { d }; this._finishCreating(); return; }
      if (def.pts === 'free') { d.points = [pt]; this.creating = { d, free: true }; this._pressed = true; this.update(); return; }
      this.creating = { d, step: 1, downX: x, downY: y };
      this._pressed = true;
      this.update();
      return;
    }

    const hit = this._hit(x, y);
    if (!hit) { if (this.selectedId) this.select(null); return; }
    e.preventDefault(); e.stopPropagation();
    if (this.cursorMode === 'eraser') { this.remove(hit.d); return; }
    this._setScroll(false);
    if (hit.d.id !== this.selectedId) this.select(hit.d.id);
    if (hit.d.locked || this.locked) return;
    const start = this.fromXY(x, y, false);
    this.drag = { d: hit.d, handle: hit.handle, start, startL: this.h.chart.timeScale().coordinateToLogical(x), orig: clone(hit.d.points), moved: false, before: JSON.stringify(this.drawings.map(strip)) };
  }

  _onMove(e) {
    if (this.drag || !this._series) return;
    const [x, y] = this._local(e);
    if (this.creating) {
      const c = this.creating, d = c.d;
      if (c.free) { if (this._pressed) { const p = this.fromXY(x, y, false); if (p) d.points.push(p); this.update(); } return; }
      const pt = this.fromXY(x, y);
      if (!pt) return;
      d.points[d.points.length - 1] = pt;
      this.update();
      return;
    }
    if (this.tool !== 'cursor') return;
    if (!this._inPane(x, y)) { if (this.hoverId) { this.hoverId = null; this.update(); } this._setScroll(true); return; }
    const hit = this._hit(x, y);
    const id = hit ? hit.d.id : null;
    if (id !== this.hoverId) { this.hoverId = id; this.update(); }
    if (hit) this.h.container.style.cursor = this.cursorMode === 'eraser' ? 'cell' : hit.handle >= 0 ? 'grab' : 'pointer';
    else this._applyCursor();
    this._setScroll(!hit);
  }

  _onDragMove(e) {
    if (!this.drag) return;
    const [x, y] = this._local(e);
    const dr = this.drag, d = dr.d;
    const def = TOOLS[d.tool];
    const pt = this.fromXY(x, y, dr.handle >= 0);
    if (!pt) return;
    dr.moved = true;
    if (dr.handle >= 0) {
      if (def.pts === 'pos') {
        if (dr.handle === 0) d.points[0] = { t: pt.t, p: pt.p };
        else if (dr.handle === 1) d.points[1].p = pt.p;
        else if (dr.handle === 2) d.points[2].p = pt.p;
        else { d.points[1].t = pt.t; d.points[2].t = pt.t; }
      } else if (d.tool === 'hline') d.points[0].p = pt.p;
      else if (d.tool === 'vline') d.points[0].t = pt.t;
      else if (def.timeOnly) d.points[dr.handle] = { t: pt.t, p: d.points[dr.handle].p };
      else d.points[dr.handle] = pt;
    } else {
      const l = this.h.chart.timeScale().coordinateToLogical(x);
      const p = this._series.coordinateToPrice(y);
      if (l == null || p == null) return;
      const dl = Math.round(l - dr.startL), dp = p - dr.start.p;
      d.points = dr.orig.map(o => {
        const ol = this._barsIdx(o.t + this.h.tz());
        return { t: Math.round(this._idxTime(ol + dl) - this.h.tz()), p: o.p + dp };
      });
    }
    this.update();
  }

  _onUp(e) {
    this._pressed = false;
    if (this.creating) {
      const c = this.creating;
      if (c.free) { if (c.d.points.length > 1) this._finishCreating(); else this._cancelCreating(); return; }
      // drag-to-draw: releasing away from the press point finishes 2-point tools
      if (c.step === 1 && TOOLS[c.d.tool].pts === 2) {
        const [x, y] = this._local(e);
        if (Math.hypot(x - c.downX, y - c.downY) > 8) this._finishCreating();
      }
      return;
    }
    if (!this.drag) return;
    const dr = this.drag;
    this.drag = null;
    if (dr.moved) {
      this.undoStack.push(dr.before);
      this.redoStack = [];
      this.commit();
      this.h.onSelect?.(this.selected());
    }
  }

  onKey(e) {
    if (e.key === 'Escape') {
      if (this.creating) this._cancelCreating();
      else if (this.temp) { this.temp = null; this.update(); }
      else if (this.tool !== 'cursor') this.setTool('cursor');
      else this.select(null);
      return true;
    }
    if (e.key === 'Enter' && this.creating && TOOLS[this.creating.d.tool].pts === 'multi') { this._finishCreating(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) { this.removeSelected(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { this.undo(); return true; }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { this.redo(); return true; }
    if (e.altKey && !e.ctrlKey) {
      const k = e.key.toLowerCase();
      const map = { t: 'trend', h: 'hline', v: 'vline', f: 'fib', r: 'rect', c: 'channel', j: 'hray', i: 'ray' };
      if (map[k]) { this.setTool(map[k]); return true; }
    }
    return false;
  }
}
