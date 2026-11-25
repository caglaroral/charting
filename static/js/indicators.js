// Indicator definitions and calculations. Every calc returns {plotKey: Array<number|null>} aligned to bars.

const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

export function src(bars, s = 'close') {
  switch (s) {
    case 'open': return bars.map(b => b.open);
    case 'high': return bars.map(b => b.high);
    case 'low': return bars.map(b => b.low);
    case 'hl2': return bars.map(b => (b.high + b.low) / 2);
    case 'hlc3': return bars.map(b => (b.high + b.low + b.close) / 3);
    case 'ohlc4': return bars.map(b => (b.open + b.high + b.low + b.close) / 4);
    default: return bars.map(b => b.close);
  }
}

// ---------------------------------------------------------------- primitives
export function sma(a, n) {
  const out = new Array(a.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) { sum = 0; cnt = 0; continue; }
    sum += v; cnt++;
    if (cnt > n) { sum -= a[i - n]; cnt = n; }
    if (cnt === n) out[i] = sum / n;
  }
  return out;
}

export function ema(a, n) {
  const out = new Array(a.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null, seed = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v; cnt++;
      if (cnt === n) { prev = seed / n; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

// Wilder's smoothing (RMA)
export function rma(a, n) {
  const out = new Array(a.length).fill(null);
  let prev = null, seed = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) continue;
    if (prev == null) {
      seed += v; cnt++;
      if (cnt === n) { prev = seed / n; out[i] = prev; }
    } else {
      prev = (prev * (n - 1) + v) / n;
      out[i] = prev;
    }
  }
  return out;
}

export function wma(a, n) {
  const out = new Array(a.length).fill(null);
  const denom = n * (n + 1) / 2;
  for (let i = n - 1; i < a.length; i++) {
    let s = 0, ok = true;
    for (let j = 0; j < n; j++) {
      const v = a[i - j];
      if (v == null) { ok = false; break; }
      s += v * (n - j);
    }
    if (ok) out[i] = s / denom;
  }
  return out;
}

function stdev(a, n, mean) {
  const out = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    if (mean[i] == null) continue;
    let s = 0;
    for (let j = 0; j < n; j++) s += (a[i - j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

function highest(a, n) {
  const out = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let m = -Infinity;
    for (let j = 0; j < n; j++) m = Math.max(m, a[i - j]);
    out[i] = m;
  }
  return out;
}

function lowest(a, n) {
  const out = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    let m = Infinity;
    for (let j = 0; j < n; j++) m = Math.min(m, a[i - j]);
    out[i] = m;
  }
  return out;
}

function trueRange(bars) {
  return bars.map((b, i) => i === 0 ? b.high - b.low :
    Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
}

function maByType(type, a, n) {
  return type === 'EMA' ? ema(a, n) : type === 'WMA' ? wma(a, n) : type === 'RMA' ? rma(a, n) : sma(a, n);
}

function rsiCalc(a, n) {
  const up = a.map((v, i) => i === 0 ? null : Math.max(v - a[i - 1], 0));
  const dn = a.map((v, i) => i === 0 ? null : Math.max(a[i - 1] - v, 0));
  const ru = rma(up, n), rd = rma(dn, n);
  return ru.map((u, i) => u == null || rd[i] == null ? null : rd[i] === 0 ? 100 : 100 - 100 / (1 + u / rd[i]));
}

// ---------------------------------------------------------------- definitions
const P = (k, l, d, extra = {}) => ({ k, l, d, ...extra });
const L = (k, l, c, extra = {}) => ({ k, l, c, w: 2, kind: 'line', ...extra });

export const INDICATORS = {
  sma: {
    name: 'Moving Average (SMA)', short: 'MA', overlay: true,
    params: [P('length', 'Length', 9), P('source', 'Source', 'close', { opts: SOURCES })],
    plots: [L('ma', 'MA', '#2962ff')],
    calc: (b, p) => ({ ma: sma(src(b, p.source), p.length) }),
  },
  ema: {
    name: 'Exponential Moving Average (EMA)', short: 'EMA', overlay: true,
    params: [P('length', 'Length', 21), P('source', 'Source', 'close', { opts: SOURCES })],
    plots: [L('ma', 'EMA', '#f7a600')],
    calc: (b, p) => ({ ma: ema(src(b, p.source), p.length) }),
  },
  wma: {
    name: 'Weighted Moving Average (WMA)', short: 'WMA', overlay: true,
    params: [P('length', 'Length', 9), P('source', 'Source', 'close', { opts: SOURCES })],
    plots: [L('ma', 'WMA', '#e040fb')],
    calc: (b, p) => ({ ma: wma(src(b, p.source), p.length) }),
  },
  mas: {
    name: 'Moving Average Ribbon (4x)', short: 'MAs', overlay: true,
    params: [P('type', 'Type', 'SMA', { opts: ['SMA', 'EMA', 'WMA'] }), P('l1', 'MA 1', 20), P('l2', 'MA 2', 50), P('l3', 'MA 3', 100), P('l4', 'MA 4', 200)],
    plots: [L('m1', 'MA1', '#f5f5f5', { w: 1 }), L('m2', 'MA2', '#2962ff'), L('m3', 'MA3', '#ffeb3b', { w: 1 }), L('m4', 'MA4', '#ff2d78', { w: 3 })],
    calc: (b, p) => { const c = src(b); return { m1: maByType(p.type, c, p.l1), m2: maByType(p.type, c, p.l2), m3: maByType(p.type, c, p.l3), m4: maByType(p.type, c, p.l4) }; },
  },
  bb: {
    name: 'Bollinger Bands', short: 'BB', overlay: true,
    params: [P('length', 'Length', 20), P('mult', 'StdDev', 2), P('source', 'Source', 'close', { opts: SOURCES })],
    plots: [L('upper', 'Upper', '#2196f3', { w: 1 }), L('basis', 'Basis', '#ff6d00', { w: 1 }), L('lower', 'Lower', '#2196f3', { w: 1 })],
    calc: (b, p) => {
      const s = src(b, p.source), m = sma(s, p.length), sd = stdev(s, p.length, m);
      return { basis: m, upper: m.map((v, i) => v == null ? null : v + p.mult * sd[i]), lower: m.map((v, i) => v == null ? null : v - p.mult * sd[i]) };
    },
  },
  donchian: {
    name: 'Donchian Channels', short: 'DC', overlay: true,
    params: [P('length', 'Length', 20)],
    plots: [L('upper', 'Upper', '#2962ff', { w: 1 }), L('basis', 'Basis', '#ff6d00', { w: 1 }), L('lower', 'Lower', '#2962ff', { w: 1 })],
    calc: (b, p) => {
      const h = highest(b.map(x => x.high), p.length), l = lowest(b.map(x => x.low), p.length);
      return { upper: h, lower: l, basis: h.map((v, i) => v == null ? null : (v + l[i]) / 2) };
    },
  },
  keltner: {
    name: 'Keltner Channels', short: 'KC', overlay: true,
    params: [P('length', 'Length', 20), P('mult', 'Multiplier', 2), P('atr', 'ATR length', 10)],
    plots: [L('upper', 'Upper', '#26a69a', { w: 1 }), L('basis', 'Basis', '#26a69a', { w: 1 }), L('lower', 'Lower', '#26a69a', { w: 1 })],
    calc: (b, p) => {
      const m = ema(src(b), p.length), a = rma(trueRange(b), p.atr);
      return { basis: m, upper: m.map((v, i) => v == null || a[i] == null ? null : v + p.mult * a[i]), lower: m.map((v, i) => v == null || a[i] == null ? null : v - p.mult * a[i]) };
    },
  },
  vwap: {
    name: 'VWAP (anchored)', short: 'VWAP', overlay: true,
    params: [P('anchor', 'Anchor', 'Session', { opts: ['Session', 'Week', 'Month'] })],
    plots: [L('vwap', 'VWAP', '#00bcd4')],
    calc: (b, p) => {
      const out = []; let pv = 0, vv = 0, key = null;
      for (const x of b) {
        const d = new Date(x.time * 1000);
        const k = p.anchor === 'Month' ? d.getUTCFullYear() * 12 + d.getUTCMonth()
          : p.anchor === 'Week' ? Math.floor((x.time / 86400 + 3) / 7) : Math.floor(x.time / 86400);
        if (k !== key) { pv = 0; vv = 0; key = k; }
        const tp = (x.high + x.low + x.close) / 3;
        pv += tp * x.volume; vv += x.volume;
        out.push(vv ? pv / vv : tp);
      }
      return { vwap: out };
    },
  },
  supertrend: {
    name: 'Supertrend', short: 'ST', overlay: true,
    params: [P('period', 'ATR length', 10), P('mult', 'Multiplier', 3)],
    plots: [L('up', 'Up trend', '#26a69a'), L('down', 'Down trend', '#ef5350')],
    calc: (b, p) => {
      const atr = rma(trueRange(b), p.period);
      const up = new Array(b.length).fill(null), down = new Array(b.length).fill(null);
      let fu = null, fl = null, dir = 1;
      for (let i = 0; i < b.length; i++) {
        if (atr[i] == null) continue;
        const hl2 = (b[i].high + b[i].low) / 2;
        let bu = hl2 + p.mult * atr[i], bl = hl2 - p.mult * atr[i];
        const pc = i > 0 ? b[i - 1].close : b[i].close;
        if (fu != null) { bu = (bu < fu || pc > fu) ? bu : fu; bl = (bl > fl || pc < fl) ? bl : fl; }
        if (fu != null) {
          if (dir === -1 && b[i].close > fu) dir = 1;
          else if (dir === 1 && b[i].close < fl) dir = -1;
        }
        fu = bu; fl = bl;
        if (dir === 1) up[i] = bl; else down[i] = bu;
      }
      return { up, down };
    },
  },
  psar: {
    name: 'Parabolic SAR', short: 'SAR', overlay: true,
    params: [P('start', 'Start', 0.02), P('inc', 'Increment', 0.02), P('max', 'Max', 0.2)],
    plots: [L('sar', 'SAR', '#2962ff', { w: 1, dots: true })],
    calc: (b, p) => {
      const out = new Array(b.length).fill(null);
      if (b.length < 2) return { sar: out };
      let long = b[1].close >= b[0].close, af = p.start, ep = long ? b[0].high : b[0].low, sar = long ? b[0].low : b[0].high;
      for (let i = 1; i < b.length; i++) {
        sar = sar + af * (ep - sar);
        if (long) {
          sar = Math.min(sar, b[i - 1].low, i > 1 ? b[i - 2].low : b[i - 1].low);
          if (b[i].low < sar) { long = false; sar = ep; ep = b[i].low; af = p.start; }
          else if (b[i].high > ep) { ep = b[i].high; af = Math.min(af + p.inc, p.max); }
        } else {
          sar = Math.max(sar, b[i - 1].high, i > 1 ? b[i - 2].high : b[i - 1].high);
          if (b[i].high > sar) { long = true; sar = ep; ep = b[i].high; af = p.start; }
          else if (b[i].low < ep) { ep = b[i].low; af = Math.min(af + p.inc, p.max); }
        }
        out[i] = sar;
      }
      return { sar: out };
    },
  },
  volume: {
    name: 'Volume', short: 'Vol', overlay: true, volume: true,
    params: [P('ma', 'MA length (0=off)', 20)],
    plots: [{ k: 'vol', l: 'Vol', c: '#26a69a80', c2: '#ef535080', kind: 'histogram' }, L('ma', 'MA', '#ffa726', { w: 1 })],
    calc: (b, p) => {
      const v = b.map(x => x.volume);
      return { vol: v, ma: p.ma > 0 ? sma(v, p.ma) : v.map(() => null), _up: b.map(x => x.close >= x.open) };
    },
  },
  rsi: {
    name: 'Relative Strength Index (RSI)', short: 'RSI', overlay: false,
    params: [P('length', 'Length', 14), P('source', 'Source', 'close', { opts: SOURCES }), P('ma', 'MA length (0=off)', 14)],
    plots: [L('rsi', 'RSI', '#7e57c2'), L('ma', 'MA', '#f7c948', { w: 1 })],
    levels: [70, 50, 30], range: [0, 100],
    calc: (b, p) => { const r = rsiCalc(src(b, p.source), p.length); return { rsi: r, ma: p.ma > 0 ? sma(r, p.ma) : r.map(() => null) }; },
  },
  macd: {
    name: 'MACD', short: 'MACD', overlay: false,
    params: [P('fast', 'Fast', 12), P('slow', 'Slow', 26), P('signal', 'Signal', 9), P('source', 'Source', 'close', { opts: SOURCES })],
    plots: [{ k: 'hist', l: 'Histogram', c: '#26a69a', c2: '#ef5350', kind: 'histogram' }, L('macd', 'MACD', '#2962ff', { w: 1 }), L('signal', 'Signal', '#ff6d00', { w: 1 })],
    levels: [0],
    calc: (b, p) => {
      const s = src(b, p.source), f = ema(s, p.fast), sl = ema(s, p.slow);
      const m = f.map((v, i) => v == null || sl[i] == null ? null : v - sl[i]);
      const sg = ema(m, p.signal);
      return { macd: m, signal: sg, hist: m.map((v, i) => v == null || sg[i] == null ? null : v - sg[i]) };
    },
  },
  stoch: {
    name: 'Stochastic', short: 'Stoch', overlay: false,
    params: [P('k', '%K length', 14), P('smooth', '%K smoothing', 3), P('d', '%D smoothing', 3)],
    plots: [L('k', '%K', '#2962ff', { w: 1 }), L('d', '%D', '#ff6d00', { w: 1 })],
    levels: [80, 20], range: [0, 100],
    calc: (b, p) => {
      const h = highest(b.map(x => x.high), p.k), l = lowest(b.map(x => x.low), p.k);
      const raw = b.map((x, i) => h[i] == null ? null : h[i] === l[i] ? 50 : 100 * (x.close - l[i]) / (h[i] - l[i]));
      const k = sma(raw, p.smooth);
      return { k, d: sma(k, p.d) };
    },
  },
  stochrsi: {
    name: 'Stochastic RSI', short: 'StochRSI', overlay: false,
    params: [P('rsi', 'RSI length', 14), P('stoch', 'Stoch length', 14), P('k', 'K', 3), P('d', 'D', 3)],
    plots: [L('k', 'K', '#2962ff', { w: 1 }), L('d', 'D', '#ff6d00', { w: 1 })],
    levels: [80, 20], range: [0, 100],
    calc: (b, p) => {
      const r = rsiCalc(src(b), p.rsi);
      const out = r.map((v, i) => {
        if (v == null || i < p.stoch - 1) return null;
        let hi = -Infinity, lo = Infinity;
        for (let j = 0; j < p.stoch; j++) { const x = r[i - j]; if (x == null) return null; hi = Math.max(hi, x); lo = Math.min(lo, x); }
        return hi === lo ? 50 : 100 * (v - lo) / (hi - lo);
      });
      const k = sma(out, p.k);
      return { k, d: sma(k, p.d) };
    },
  },
  atr: {
    name: 'Average True Range (ATR)', short: 'ATR', overlay: false,
    params: [P('length', 'Length', 14)],
    plots: [L('atr', 'ATR', '#ef5350', { w: 1 })],
    calc: (b, p) => ({ atr: rma(trueRange(b), p.length) }),
  },
  cci: {
    name: 'Commodity Channel Index (CCI)', short: 'CCI', overlay: false,
    params: [P('length', 'Length', 20)],
    plots: [L('cci', 'CCI', '#2196f3', { w: 1 })],
    levels: [100, 0, -100],
    calc: (b, p) => {
      const tp = src(b, 'hlc3'), m = sma(tp, p.length);
      return {
        cci: tp.map((v, i) => {
          if (m[i] == null) return null;
          let md = 0; for (let j = 0; j < p.length; j++) md += Math.abs(tp[i - j] - m[i]);
          md /= p.length;
          return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
        }),
      };
    },
  },
  adx: {
    name: 'ADX / DMI', short: 'DMI', overlay: false,
    params: [P('length', 'DI length', 14), P('smooth', 'ADX smoothing', 14)],
    plots: [L('adx', 'ADX', '#ff6d00'), L('pdi', '+DI', '#26a69a', { w: 1 }), L('mdi', '-DI', '#ef5350', { w: 1 })],
    levels: [25],
    calc: (b, p) => {
      const pdm = b.map((x, i) => { if (!i) return 0; const u = x.high - b[i - 1].high, d = b[i - 1].low - x.low; return u > d && u > 0 ? u : 0; });
      const mdm = b.map((x, i) => { if (!i) return 0; const u = x.high - b[i - 1].high, d = b[i - 1].low - x.low; return d > u && d > 0 ? d : 0; });
      const tr = rma(trueRange(b), p.length), sp = rma(pdm, p.length), sm = rma(mdm, p.length);
      const pdi = sp.map((v, i) => v == null || !tr[i] ? null : 100 * v / tr[i]);
      const mdi = sm.map((v, i) => v == null || !tr[i] ? null : 100 * v / tr[i]);
      const dx = pdi.map((v, i) => v == null || mdi[i] == null ? null : (v + mdi[i]) === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / (v + mdi[i]));
      return { pdi, mdi, adx: rma(dx, p.smooth) };
    },
  },
  obv: {
    name: 'On Balance Volume (OBV)', short: 'OBV', overlay: false,
    params: [],
    plots: [L('obv', 'OBV', '#2962ff', { w: 1 })],
    calc: (b) => { let o = 0; return { obv: b.map((x, i) => (o += i === 0 ? 0 : x.close > b[i - 1].close ? x.volume : x.close < b[i - 1].close ? -x.volume : 0)) }; },
  },
  mfi: {
    name: 'Money Flow Index (MFI)', short: 'MFI', overlay: false,
    params: [P('length', 'Length', 14)],
    plots: [L('mfi', 'MFI', '#7e57c2', { w: 1 })],
    levels: [80, 20], range: [0, 100],
    calc: (b, p) => {
      const tp = src(b, 'hlc3');
      return {
        mfi: tp.map((v, i) => {
          if (i < p.length) return null;
          let pos = 0, neg = 0;
          for (let j = 0; j < p.length; j++) { const k = i - j, f = tp[k] * b[k].volume; if (tp[k] > tp[k - 1]) pos += f; else if (tp[k] < tp[k - 1]) neg += f; }
          return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
        }),
      };
    },
  },
  willr: {
    name: 'Williams %R', short: '%R', overlay: false,
    params: [P('length', 'Length', 14)],
    plots: [L('r', '%R', '#7e57c2', { w: 1 })],
    levels: [-20, -80], range: [-100, 0],
    calc: (b, p) => {
      const h = highest(b.map(x => x.high), p.length), l = lowest(b.map(x => x.low), p.length);
      return { r: b.map((x, i) => h[i] == null ? null : h[i] === l[i] ? -50 : -100 * (h[i] - x.close) / (h[i] - l[i])) };
    },
  },
  roc: {
    name: 'Rate of Change (ROC)', short: 'ROC', overlay: false,
    params: [P('length', 'Length', 9)],
    plots: [L('roc', 'ROC', '#2196f3', { w: 1 })],
    levels: [0],
    calc: (b, p) => ({ roc: b.map((x, i) => i < p.length ? null : 100 * (x.close / b[i - p.length].close - 1)) }),
  },
};

export function defaultParams(type) {
  const o = {};
  for (const p of INDICATORS[type].params) o[p.k] = p.d;
  return o;
}

export function defaultColors(type) {
  const o = {};
  for (const p of INDICATORS[type].plots) { o[p.k] = p.c; if (p.c2) o[p.k + '_2'] = p.c2; }
  return o;
}

export function label(inst) {
  const def = INDICATORS[inst.type];
  const vals = def.params.map(p => inst.params[p.k]).filter(v => v !== undefined && v !== 'close');
  return def.short + (vals.length ? ' ' + vals.join(' ') : '');
}
