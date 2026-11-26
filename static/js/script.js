// Custom indicator runtime ("ChartScript"): plain JavaScript with a Pine-like, vectorized API.
// Shared by the browser sandbox (chart rendering) and the Node worker (server-side alerts).
// Series are plain arrays aligned with bars (null = na). See docs/CHARTSCRIPT.md.

import { sma, ema, wma, rma, src } from './indicators.js';

export const TEMPLATE = `// ChartScript: JavaScript with a Pine-like API. Series are arrays aligned to bars.
indicator('My Indicator', { overlay: true })

const fast = input('Fast MA', 9)
const slow = input('Slow MA', 21)
const source = input.source('Source', 'close')

const f = ta.ema(source, fast)
const s = ta.ema(source, slow)

plot(f, { title: 'Fast', color: '#2962ff' })
plot(s, { title: 'Slow', color: '#ff6d00', width: 2 })

plotshape(ta.crossover(f, s), { title: 'Buy', location: 'belowbar', color: '#26a69a', shape: 'triangleup', text: 'BUY' })
plotshape(ta.crossunder(f, s), { title: 'Sell', location: 'abovebar', color: '#ef5350', shape: 'triangledown', text: 'SELL' })
`;

const isArr = Array.isArray;
const at = (x, i) => (isArr(x) ? x[i] : x);

// Pine/TV style timeframe ids -> app timeframe ids
export function normTf(tf) {
  const s = String(tf).trim();
  const map = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', 720: '12h', D: '1D', '1D': '1D', d: '1D', W: '1W', '1W': '1W', M: '1M', '1M': '1M' };
  if (map[s]) return map[s];
  const m = /^(\d+)\s*(m|h|d|w)$/i.exec(s);
  if (m) {
    const u = m[2].toLowerCase();
    return u === 'm' ? `${m[1]}m` : u === 'h' ? `${m[1]}h` : u === 'd' ? `${m[1]}D` : `${m[1]}W`;
  }
  return s;
}

const NAMED = {
  aqua: '#00bcd4', black: '#363a45', blue: '#2962ff', fuchsia: '#e040fb', gray: '#787b86', green: '#4caf50',
  lime: '#00e676', maroon: '#880e4f', navy: '#311b92', olive: '#808000', orange: '#ff9800', purple: '#9c27b0',
  red: '#ff5252', silver: '#b2b5be', teal: '#00897b', white: '#ffffff', yellow: '#ffeb3b',
};

function parseColor(c) {
  if (c == null) return null;
  c = String(c);
  let m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
  return null;
}

const colorApi = {
  ...NAMED,
  rgb: (r, g, b, transp = 0) => `rgba(${r},${g},${b},${+(1 - transp / 100).toFixed(3)})`,
  new: (c, transp = 0) => { const p = parseColor(c); return p ? `rgba(${p[0]},${p[1]},${p[2]},${+(1 - transp / 100).toFixed(3)})` : c; },
};

const mathApi = {};
for (const k of Object.getOwnPropertyNames(Math)) mathApi[k] = Math[k];
mathApi.avg = (...xs) => (xs.some(v => v == null) ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
mathApi.sum = (...xs) => xs.reduce((a, b) => a + b, 0);

/**
 * env: { tf, tfSec, tfSecs: {tf: sec}, htf: {tf: bars[]} }
 * Returns { meta, inputs, plots, hlines, shapes, requests } — requests lists timeframes that
 * security() needed but env.htf did not provide (the host fetches them and runs again).
 */
export function runScript(code, bars, inputValues = {}, evaluator = defaultEvaluator, env = {}) {
  const out = { meta: { name: 'Custom', overlay: false }, inputs: [], plots: [], hlines: [], shapes: [], fills: [], requests: [] };
  const usedKeys = new Set();
  const keyFor = (title, prefix) => {
    const base = String(title || prefix).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '') || prefix;
    let k = base, j = 2;
    while (usedKeys.has(k)) k = `${base}_${j++}`;
    usedKeys.add(k);
    return k;
  };
  const main = makeScope(bars);
  const n = bars.length;
  const srcMap = { open: main.open, high: main.high, low: main.low, close: main.close, hl2: main.hl2, hlc3: main.hlc3, ohlc4: main.ohlc4, volume: main.volume };

  const input = (title, def, opts) => {
    if (isArr(def)) return input.source(title, 'close'); // input(close, ...) style
    const k = 'in_' + keyFor(title, 'input');
    const v = inputValues[k] !== undefined ? inputValues[k] : def;
    out.inputs.push({ k, l: String(title), d: def, opts: isArr(opts) ? opts : undefined });
    return typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? (v === true || v === 'true') : v;
  };
  input.int = input.float = input.bool = input.string = (t, d, o) => input(t, d, o);
  input.select = (t, d, opts) => input(t, d, opts);
  input.source = (t, d = 'close') => srcMap[input(t, d, Object.keys(srcMap))] || main.close;

  // Per-bar colors; na (null) means invisible, like Pine's na color.
  const NA_COLOR = 'rgba(0,0,0,0)';
  const colorsFor = (c) => {
    if (typeof c === 'function') return Array.from({ length: n }, (_, i) => c(i) || NA_COLOR);
    if (isArr(c)) return Array.from({ length: n }, (_, i) => c[i] || NA_COLOR);
    return null;
  };
  const baseColor = (c, fallback) => (typeof c === 'string' ? c : fallback);
  const PALETTE = ['#2962ff', '#ff6d00', '#26a69a', '#e040fb', '#ffeb3b'];

  const security = (tf, fn, opts = {}) => {
    tf = normTf(tf);
    if (tf === env.tf) return main.toSeries(fn(main));
    const htf = env.htf && env.htf[tf];
    if (!htf) { if (!out.requests.includes(tf)) out.requests.push(tf); return new Array(n).fill(null); }
    const hs = makeScope(htf);
    const vals = hs.toSeries(fn(hs));
    const hsec = (env.tfSecs && env.tfSecs[tf]) || 0, csec = env.tfSec || 0;
    const res = new Array(n).fill(null);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = bars[i].time;
      while (j + 1 < htf.length && htf[j + 1].time <= t) j++;
      if (!htf.length || htf[j].time > t) continue;
      // lookahead_off: an HTF value is known only once its bar has closed
      const closed = opts.lookahead || t + csec >= htf[j].time + hsec;
      res[i] = closed ? vals[j] : (j > 0 ? vals[j - 1] : null);
    }
    return res;
  };

  const scope = {
    indicator: (name, opts = {}) => {
      out.meta.name = String(name); out.meta.overlay = !!opts.overlay;
      if (opts.precision != null && Number.isFinite(+opts.precision)) out.meta.precision = +opts.precision;
    },
    input,
    plot: (s, o = {}) => {
      const i = out.plots.length;
      out.plots.push({
        k: keyFor(o.title, 'plot'), title: o.title || `Plot ${i + 1}`,
        color: baseColor(o.color, PALETTE[i % PALETTE.length]), colors: colorsFor(o.color),
        width: o.width || o.linewidth || 1, style: String(o.style || 'line').replace(/^style_/, ''), data: main.toSeries(s),
      });
    },
    hline: (v, o = {}) => out.hlines.push({ value: Number(v), color: o.color || '#787b86', title: o.title || String(v) }),
    // location: abovebar | belowbar | top | bottom (fixed at the pane edge) | absolute (y = series value)
    plotshape: (cond, o = {}) => {
      const location = String(o.location || 'abovebar').toLowerCase().replace(/^location\./, '');
      const raw = main.toSeries(cond);
      out.shapes.push({
        k: keyFor(o.title, 'shape'), title: o.title || 'Shape', location,
        color: baseColor(o.color, '#2962ff'), colors: colorsFor(o.color),
        shape: String(o.shape || o.style || 'circle').toLowerCase().replace(/^shape\./, ''), text: o.text || '',
        textColor: o.textcolor || o.textColor || null,
        size: String(o.size || 'auto').toLowerCase().replace(/^size\./, ''),
        data: location === 'absolute' ? raw.map(v => v != null && v === v && v !== false) : raw.map(Boolean),
        values: location === 'absolute' ? raw.map(v => (typeof v === 'number' && v === v ? v : null)) : undefined,
      });
    },
    // fill(a, b, {color}) shades the area between two series; color may be per bar (array / i => color).
    // Gradient form (Pine fill(p1, p2, top_value, bottom_value, top_color, bottom_color)):
    // fill(a, b, {topValue, bottomValue, topColor, bottomColor}); a null color end is transparent.
    fill: (a, b, o = {}) => {
      const grad = o.topValue != null || o.bottomValue != null;
      out.fills.push(grad ? {
        a: main.toSeries(a), b: main.toSeries(b), gradient: true,
        top: main.toSeries(o.topValue ?? a), bottom: main.toSeries(o.bottomValue ?? b),
        topColor: baseColor(o.topColor, NA_COLOR), topColors: colorsFor(o.topColor),
        bottomColor: baseColor(o.bottomColor, NA_COLOR), bottomColors: colorsFor(o.bottomColor),
      } : {
        a: main.toSeries(a), b: main.toSeries(b), color: baseColor(o.color, 'rgba(41,98,255,0.15)'), colors: colorsFor(o.color),
      });
    },
    security,
    timeframe: env.tf || '', timeframe_sec: env.tfSec || 0,
    color: colorApi, math: mathApi,
    ...main,
  };
  delete scope.toSeries;
  evaluator(code, scope);
  return out;
}

function defaultEvaluator(code, scope) {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, '"use strict";\n' + code);
  fn(...names.map(k => scope[k]));
}

// Series + ta API bound to one bar array (used for the chart timeframe and for security()).
function makeScope(bars) {
  const n = bars.length;
  const toSeries = (x) => isArr(x) ? Array.from({ length: n }, (_, i) => (x[i] == null || Number.isNaN(x[i]) ? null : x[i]))
    : Array.from({ length: n }, () => (x == null || Number.isNaN(x) ? null : x));
  const open = bars.map(b => b.open), high = bars.map(b => b.high), low = bars.map(b => b.low);
  const close = bars.map(b => b.close), volume = bars.map(b => b.volume), time = bars.map(b => b.time);
  const hl2 = src(bars, 'hl2'), hlc3 = src(bars, 'hlc3'), ohlc4 = src(bars, 'ohlc4');
  const bar_index = bars.map((_, i) => i);

  const map2 = (a, b, f) => Array.from({ length: n }, (_, i) => {
    const x = at(a, i), y = at(b, i);
    return x == null || y == null ? null : f(x, y);
  });
  const add = (a, b) => map2(a, b, (x, y) => x + y);
  const sub = (a, b) => map2(a, b, (x, y) => x - y);
  const mul = (a, b) => map2(a, b, (x, y) => x * y);
  const div = (a, b) => map2(a, b, (x, y) => (y === 0 ? null : x / y));
  const max = (a, b) => map2(a, b, Math.max);
  const min = (a, b) => map2(a, b, Math.min);
  const abs = (a) => toSeries(a).map(x => (x == null ? null : Math.abs(x)));
  const series = (f) => { const r = new Array(n); for (let i = 0; i < n; i++) { const v = f(i); r[i] = v == null || Number.isNaN(v) ? null : v; } return r; };
  const shift = (s, k = 1) => { s = toSeries(s); return s.map((_, i) => (i - k >= 0 && i - k < n ? s[i - k] : null)); };
  const nz = (x, y = 0) => (isArr(x) ? x.map(v => (v == null || Number.isNaN(v) ? y : v)) : (x == null || Number.isNaN(x) ? y : x));
  const na = (x) => x == null || Number.isNaN(x);

  const ta = makeTA(bars, { map2, toSeries, sub, n, high, low, close, volume });
  return { open, high, low, close, volume, time, hl2, hlc3, ohlc4, bar_index, n, ta, add, sub, mul, div, max, min, abs, series, shift, nz, na, toSeries };
}

function makeTA(bars, { map2, toSeries, sub, n, high: highArr, low: lowArr, close: closeArr, volume: volArr }) {
  const win = (s, len, f) => {
    s = toSeries(s);
    return Array.from({ length: n }, (_, i) => {
      if (i < len - 1) return null;
      const w = s.slice(i - len + 1, i + 1);
      return w.some(v => v == null) ? null : f(w);
    });
  };
  const tr = () => bars.map((b, i) => i === 0 ? b.high - b.low :
    Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  const change = (s, k = 1) => { s = toSeries(s); return s.map((v, i) => (i < k || v == null || s[i - k] == null ? null : v - s[i - k])); };
  const pair = (a, b, i) => [isArr(a) ? a[i - 1] : a, isArr(a) ? a[i] : a, isArr(b) ? b[i - 1] : b, isArr(b) ? b[i] : b];
  const crossover = (a, b) => Array.from({ length: n }, (_, i) => {
    if (i === 0) return false;
    const [a0, a1, b0, b1] = pair(a, b, i);
    return a0 != null && a1 != null && b0 != null && b1 != null && a0 <= b0 && a1 > b1;
  });
  const crossunder = (a, b) => Array.from({ length: n }, (_, i) => {
    if (i === 0) return false;
    const [a0, a1, b0, b1] = pair(a, b, i);
    return a0 != null && a1 != null && b0 != null && b1 != null && a0 >= b0 && a1 < b1;
  });
  const rsi = (s, len = 14) => {
    s = toSeries(s);
    const up = s.map((v, i) => (i === 0 || v == null || s[i - 1] == null ? null : Math.max(v - s[i - 1], 0)));
    const dn = s.map((v, i) => (i === 0 || v == null || s[i - 1] == null ? null : Math.max(s[i - 1] - v, 0)));
    const ru = rma(up, len), rd = rma(dn, len);
    return ru.map((u, i) => (u == null || rd[i] == null ? null : rd[i] === 0 ? 100 : 100 - 100 / (1 + u / rd[i])));
  };
  const stdev = (s, len) => win(s, len, w => { const m = w.reduce((x, y) => x + y, 0) / len; return Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / len); });
  const highest = (s, len) => (len === undefined ? win(highArr, s, w => Math.max(...w)) : win(s, len, w => Math.max(...w)));
  const lowest = (s, len) => (len === undefined ? win(lowArr, s, w => Math.min(...w)) : win(s, len, w => Math.min(...w)));
  const linreg = (s, len, offset = 0) => win(s, len, w => {
    // least squares over x = 0..len-1, evaluated at x = len-1-offset (Pine ta.linreg)
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let x = 0; x < len; x++) { sx += x; sy += w[x]; sxy += x * w[x]; sxx += x * x; }
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx || 1);
    const icpt = (sy - slope * sx) / len;
    return icpt + slope * (len - 1 - offset);
  });
  const mfi = (s, len = 14) => {
    s = toSeries(s);
    return Array.from({ length: n }, (_, i) => {
      if (i < len) return null;
      let pos = 0, neg = 0;
      for (let j = i - len + 1; j <= i; j++) {
        if (s[j] == null || s[j - 1] == null) return null;
        const f = s[j] * volArr[j];
        if (s[j] > s[j - 1]) pos += f; else if (s[j] < s[j - 1]) neg += f;
      }
      return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    });
  };
  const stoch = (s, h, l, len) => {
    // Pine: ta.stoch(source, high, low, length); also ta.stoch(length) on close/high/low
    if (h === undefined) { len = s; s = closeArr; h = highArr; l = lowArr; }
    const hh = highest(h, len), ll = lowest(l, len), x = toSeries(s);
    return x.map((v, i) => (v == null || hh[i] == null || ll[i] == null ? null : hh[i] === ll[i] ? 0 : 100 * (v - ll[i]) / (hh[i] - ll[i])));
  };
  return {
    sma: (s, l) => sma(toSeries(s), l), ema: (s, l) => ema(toSeries(s), l), wma: (s, l) => wma(toSeries(s), l), rma: (s, l) => rma(toSeries(s), l),
    rsi, tr, atr: (len = 14) => rma(tr(), len), stdev, highest, lowest, change, linreg, mfi, stoch,
    mom: (s, k = 10) => change(s, k),
    roc: (s, k = 9) => { s = toSeries(s); return s.map((v, i) => (i < k || v == null || !s[i - k] ? null : 100 * (v / s[i - k] - 1))); },
    cum: (s) => { let c = 0; return toSeries(s).map(v => (c += v || 0)); },
    cci: (s, len = 20) => {
      const x = toSeries(s), m = sma(x, len);
      return x.map((v, i) => {
        if (m[i] == null) return null;
        let md = 0; for (let j = 0; j < len; j++) md += Math.abs(x[i - j] - m[i]);
        md /= len; return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
      });
    },
    crossover, crossunder,
    cross: (a, b) => { const o = crossover(a, b), u = crossunder(a, b); return o.map((v, i) => v || u[i]); },
    macd: (s, f = 12, sl = 26, sig = 9) => {
      const m = sub(ema(toSeries(s), f), ema(toSeries(s), sl)); const sg = ema(m, sig);
      return { macd: m, signal: sg, hist: sub(m, sg) };
    },
    bb: (s, len = 20, mult = 2) => {
      const b = sma(toSeries(s), len), sd = stdev(s, len);
      return { basis: b, upper: map2(b, sd, (x, y) => x + mult * y), lower: map2(b, sd, (x, y) => x - mult * y) };
    },
    supertrend: (mult = 3, period = 10) => {
      const a = rma(tr(), period), line = new Array(n).fill(null), dir = new Array(n).fill(null);
      let fu = null, fl = null, d = 1;
      for (let i = 0; i < n; i++) {
        if (a[i] == null) continue;
        const hl2 = (bars[i].high + bars[i].low) / 2, pc = i ? bars[i - 1].close : bars[i].close;
        let bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
        if (fu != null) {
          bu = bu < fu || pc > fu ? bu : fu; bl = bl > fl || pc < fl ? bl : fl;
          if (d === -1 && bars[i].close > fu) d = 1; else if (d === 1 && bars[i].close < fl) d = -1;
        }
        fu = bu; fl = bl; line[i] = d === 1 ? bl : bu; dir[i] = d;
      }
      return { line, dir };
    },
    vwap: () => {
      let pv = 0, vv = 0, key = null;
      return bars.map(b => {
        const k = Math.floor(b.time / 86400);
        if (k !== key) { pv = 0; vv = 0; key = k; }
        const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; vv += b.volume;
        return vv ? pv / vv : tp;
      });
    },
    pivothigh: (l = 5, r = 5) => highArr.map((v, i) => {
      if (i < l + r) return null;
      const c = i - r, cv = highArr[c];
      for (let j = c - l; j <= i; j++) if (j !== c && highArr[j] >= cv) return null;
      return cv;
    }),
    pivotlow: (l = 5, r = 5) => lowArr.map((v, i) => {
      if (i < l + r) return null;
      const c = i - r, cv = lowArr[c];
      for (let j = c - l; j <= i; j++) if (j !== c && lowArr[j] <= cv) return null;
      return cv;
    }),
    valuewhen: (cond, s, occ = 0) => {
      const hits = [];
      return toSeries(cond).map((c, i) => { if (c) hits.push(isArr(s) ? s[i] : s); return hits.length > occ ? hits[hits.length - 1 - occ] : null; });
    },
    barssince: (cond) => { let last = null; return toSeries(cond).map((c, i) => { if (c) last = i; return last == null ? null : i - last; }); },
  };
}
