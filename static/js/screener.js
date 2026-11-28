// Bottom panel: Screener (saved screens + screener alerts), Strategy Tester (backtests) and Paper Trading.
// Everything is computed by the backtester service through the backend (/api/screener, /api/backtest,
// /api/papers). Conditions use the backtest engine's format:
//   operand  {ind, p, f, tf, sh} | {px, tf, sh} | {const}      (tf '' = the screen's / strategy's timeframe)
//   cond     {a, op: '<' | '>' | 'xup' | 'xdn', b}
//   strategy {tf, long: {entry: [cond], stop, tp} | null, short: ...}, exit = {k: 'pct', v} | {k: 'atr', m, p} | null
import { api } from './api.js';
import { el, $, toast, showMenu, modal, confirmDialog, promptDialog, ICONS } from './ui.js';
import * as dialogs from './dialogs.js';

let app, S;
let meta = null;

const NAMES = {
  sma: 'SMA', ema: 'EMA', hma: 'HMA', tema: 'TEMA', tvwema: 'TVWEMA', vwap: 'VWAP', rsi: 'RSI', cci: 'CCI',
  stochrsi: 'Stoch RSI', mfi: 'MFI', ao: 'Awesome Osc.', dpo: 'DPO', macd: 'MACD', adx: 'ADX', bb: 'Bollinger',
  donchian: 'Donchian', keltner: 'Keltner', supertrend: 'Supertrend', psar: 'Parabolic SAR', wavetrend: 'WaveTrend',
  atr: 'ATR', obv: 'OBV',
};
const PARAMS = {
  macd: ['Fast', 'Slow', 'Signal'], bb: ['Length', 'Mult'], keltner: ['Length', 'Mult', 'ATR'], stochrsi: ['RSI', 'Stoch', 'K', 'D'],
  supertrend: ['ATR', 'Factor', 'Source'], wavetrend: ['Channel', 'Average', 'Signal'], dpo: ['Period', 'Smooth', 'ATR'],
  psar: ['Step', 'Max'], ao: ['Fast', 'Slow'],
};
const OPS = { '<': 'less than', '>': 'greater than', xup: 'crosses up', xdn: 'crosses down' };
const OP_SHORT = { '<': '<', '>': '>', xup: '↗ crosses', xdn: '↘ crosses' };
const PRICES = { open: 'Open', high: 'High', low: 'Low', close: 'Close', volume: 'Volume' };
const TF_SECONDS = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '12h': 43200, '1D': 86400, '1W': 604800 };
const CHANNELS = { app: 'In-app', telegram: 'Telegram', email: 'E-mail', webhook: 'Webhook' };

const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

// ======================================================================= formatting
export function opLabel(o) {
  if (!o) return '?';
  if ('const' in o) return String(o.const);
  const sh = o.sh ? `[${o.sh}]` : '';
  const tf = o.tf ? ` ${o.tf}` : '';
  if (o.px) return `${PRICES[o.px] || o.px}${sh}${tf}`;
  const ind = meta?.indicators.find(i => i.name === o.ind);
  const p = (o.p && o.p.length ? o.p : ind?.defaults || []).join(',');
  return `${NAMES[o.ind] || o.ind}${o.f ? '.' + o.f : ''}${p ? `(${p})` : ''}${sh}${tf}`;
}
const condLabel = (c) => `${opLabel(c.a)} ${OP_SHORT[c.op]} ${opLabel(c.b)}`;
const exitLabel = (e) => (!e ? 'none' : e.k === 'pct' ? `${+(e.v * 100).toFixed(4)}%` : `${e.m}× ATR(${e.p})`);

function fmtVal(v) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return v.toFixed(0);
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a === 0) return '0';
  return Number(v.toPrecision(4)).toString();
}
const fmtMoney = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
const fmtPct = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const cls = (v) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');
const utcDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const fmtDT = (sec) => app.fmtTime ? app.fmtTime(sec + S.tzOffset) : new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');

// ======================================================================= operand / condition editors
function operandEditor(o, { allowConst = false, testid = '' } = {}) {
  let cur = JSON.parse(JSON.stringify(o || { ind: 'rsi', p: [] }));
  const box = el('div', { class: 'op-ed', 'data-testid': testid || null });
  const kindOf = (x) => ('const' in x ? 'const' : x.px ? 'px' : 'ind');
  const tfSel = () => el('select', { 'data-role': 'tf', title: 'Timeframe', onchange: (e) => { cur.tf = e.target.value || null; } },
    el('option', { value: '' }, 'Same timeframe'), meta.timeframes.map(t => el('option', { value: t, selected: cur.tf === t }, t)));
  const shift = () => el('label', { title: 'Bars ago (0 = the last closed bar)' }, 'bars ago',
    el('input', { class: 'pin', type: 'number', min: 0, max: 50, value: cur.sh || 0, 'data-role': 'sh', oninput: (e) => { cur.sh = Math.max(0, Math.min(50, +e.target.value || 0)); } }));
  const render = () => {
    box.innerHTML = '';
    const kind = el('select', { 'data-role': 'kind', onchange: (e) => {
      const k = e.target.value;
      cur = k === 'const' ? { const: 0 } : k === 'px' ? { px: 'close', tf: null, sh: 0 } : { ind: 'rsi', p: [], tf: null, sh: 0 };
      render();
    } }, el('option', { value: 'ind', selected: kindOf(cur) === 'ind' }, 'Indicator'), el('option', { value: 'px', selected: kindOf(cur) === 'px' }, 'Price'),
    allowConst ? el('option', { value: 'const', selected: kindOf(cur) === 'const' }, 'Value') : null);
    box.append(kind);
    const k = kindOf(cur);
    if (k === 'const') {
      box.append(el('input', { type: 'number', step: 'any', value: cur.const, 'data-role': 'value', style: { width: '110px' }, oninput: (e) => { cur.const = +e.target.value; } }));
      return;
    }
    if (k === 'px') {
      box.append(el('select', { 'data-role': 'px', onchange: (e) => { cur.px = e.target.value; } },
        Object.entries(PRICES).map(([v, l]) => el('option', { value: v, selected: cur.px === v }, l))), tfSel(), shift());
      return;
    }
    const ind = meta.indicators.find(i => i.name === cur.ind) || meta.indicators[0];
    box.append(el('select', { 'data-role': 'ind', onchange: (e) => { cur = { ind: e.target.value, p: [], tf: cur.tf, sh: cur.sh }; render(); } },
      meta.indicators.map(i => el('option', { value: i.name, selected: i.name === ind.name }, NAMES[i.name] || i.name))));
    if (ind.fields.length) {
      if (!ind.fields.includes(cur.f)) cur.f = ind.fields[0];
      box.append(el('select', { 'data-role': 'field', onchange: (e) => { cur.f = e.target.value; } }, ind.fields.map(f => el('option', { value: f, selected: f === cur.f }, f))));
    } else delete cur.f;
    const p = ind.defaults.map((d, i) => (cur.p && cur.p[i] != null ? cur.p[i] : d));
    cur.p = p.slice();
    ind.defaults.forEach((d, i) => {
      const name = (PARAMS[ind.name] || [])[i] || 'Length';
      const inp = typeof d === 'string'
        ? el('select', { 'data-role': `p${i}`, onchange: (e) => { cur.p[i] = e.target.value; } }, ['hlc3', 'hl2'].map(v => el('option', { value: v, selected: p[i] === v }, v)))
        : el('input', { class: 'pin', type: 'number', step: 'any', min: 0, value: p[i], 'data-role': `p${i}`, oninput: (e) => { cur.p[i] = +e.target.value; } });
      box.append(el('label', {}, name, inp));
    });
    box.append(tfSel(), shift());
  };
  render();
  return { el: box, get: () => {
    const o2 = JSON.parse(JSON.stringify(cur));
    if (o2.ind) { // drop trailing parameters equal to the defaults (shorter labels)
      const d = meta.indicators.find(i => i.name === o2.ind)?.defaults || [];
      while (o2.p.length && o2.p[o2.p.length - 1] === d[o2.p.length - 1]) o2.p.pop();
    }
    if (!o2.tf) delete o2.tf;
    if (!o2.sh) delete o2.sh;
    return o2;
  } };
}

function condDialog(cond, title = 'Condition') {
  return new Promise(resolve => {
    const c = cond || { a: { ind: 'rsi', p: [] }, op: '<', b: { const: 30 } };
    const A = operandEditor(c.a, { testid: 'cond-a' });
    const B = operandEditor(c.b, { allowConst: true, testid: 'cond-b' });
    const op = el('select', { 'data-testid': 'cond-op' }, Object.entries(OPS).map(([v, l]) => el('option', { value: v, selected: v === c.op }, l)));
    let done = false;
    const m = modal({ title, width: '640px', onClose: () => { if (!done) resolve(null); },
      body: el('div', { class: 'cond-ed' }, el('b', {}, 'Value'), A.el, op, el('b', {}, 'Compared with'), B.el,
        el('div', { class: 'help' }, 'Evaluated on the last closed bar. "Crosses up": below on the bar before, above on this bar. Indicators on another timeframe use its last closed bar.')),
      footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn primary', 'data-testid': 'cond-ok', onclick: () => { done = true; m.close(); resolve({ a: A.get(), op: op.value, b: B.get() }); } }, 'OK')] });
  });
}

function columnDialog(o) {
  return new Promise(resolve => {
    const A = operandEditor(o || { ind: 'ema', p: [200] }, { testid: 'col-a' });
    let done = false;
    const m = modal({ title: 'Column', width: '600px', onClose: () => { if (!done) resolve(null); },
      body: el('div', { class: 'cond-ed' }, A.el),
      footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: 'btn primary', 'data-testid': 'col-ok', onclick: () => { done = true; m.close(); resolve(A.get()); } }, 'OK')] });
  });
}

function condChips(list, onChange, { addLabel = '+ Filter', testid = 'filter' } = {}) {
  const box = el('div', { class: 'chips' });
  const render = () => {
    box.innerHTML = '';
    list.forEach((c, i) => box.append(el('span', { class: 'chip', 'data-testid': `${testid}-chip`, title: 'Edit', onclick: async () => {
      const n = await condDialog(c); if (n) { list[i] = n; render(); onChange(); }
    } }, condLabel(c), el('button', { class: 'x', title: 'Remove', onclick: (e) => { e.stopPropagation(); list.splice(i, 1); render(); onChange(); } }, '×'))));
    box.append(el('button', { class: 'btn small ghost', 'data-testid': `${testid}-add`, onclick: async () => {
      if (list.length >= meta.max_conds) return toast(`At most ${meta.max_conds} conditions`, 'error');
      const n = await condDialog(); if (n) { list.push(n); render(); onChange(); }
    } }, addLabel));
  };
  render();
  return { el: box, render };
}

// ======================================================================= strategy editor
function exitEditor(e, label, testid) {
  let cur = e ? { ...e } : null;
  const box = el('div', { class: 'st-row' });
  const render = () => {
    box.innerHTML = '';
    box.append(el('label', {}, label), el('select', { 'data-testid': `${testid}-kind`, onchange: (ev) => {
      const k = ev.target.value;
      cur = k === 'pct' ? { k: 'pct', v: 0.02 } : k === 'atr' ? { k: 'atr', m: 2, p: 14 } : null; render();
    } }, [['', 'None'], ['pct', '% of entry'], ['atr', 'ATR multiple']].map(([v, l]) => el('option', { value: v, selected: (cur?.k || '') === v }, l))));
    if (cur?.k === 'pct') box.append(el('input', { class: 'st-num', type: 'number', step: 'any', min: 0.01, value: +(cur.v * 100).toFixed(4), 'data-testid': `${testid}-v`, oninput: (ev) => { cur.v = (+ev.target.value || 0) / 100; } }), '%');
    if (cur?.k === 'atr') box.append(el('input', { class: 'st-num', type: 'number', step: 'any', min: 0.1, value: cur.m, title: 'Multiple', oninput: (ev) => { cur.m = +ev.target.value; } }), '× ATR',
      el('input', { class: 'st-num', type: 'number', min: 1, value: cur.p, title: 'ATR period', oninput: (ev) => { cur.p = Math.round(+ev.target.value); } }));
  };
  render();
  return { el: box, get: () => cur };
}

function strategyEditor(st, { screens = [], onChange } = {}) {
  const s = JSON.parse(JSON.stringify(st || { tf: '1h', long: { entry: [], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } }, short: null }));
  const box = el('div', { class: 'st-form' });
  const tf = el('select', { 'data-testid': 'st-tf' }, meta.timeframes.map(t => el('option', { value: t, selected: t === s.tf }, t)));
  const sides = {};
  const sideBox = (side) => {
    const on = !!s[side];
    const sd = s[side] || { entry: [], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } };
    const chips = condChips(sd.entry, () => onChange?.(), { addLabel: '+ Entry condition', testid: `${side}-entry` });
    const stop = exitEditor(sd.stop, 'Stop', `${side}-stop`), tp = exitEditor(sd.tp, 'Take profit', `${side}-tp`);
    const cb = el('input', { type: 'checkbox', checked: on, 'data-testid': `st-${side}`, onchange: (e) => wrap.classList.toggle('off', !e.target.checked) });
    const wrap = el('div', { class: `st-side ${on ? '' : 'off'}` }, el('label', { class: 'st-side-head' }, cb, side === 'long' ? 'Long' : 'Short'),
      el('div', { class: 'muted' }, 'Enter when all conditions hold at a bar\'s close (fill at the next open):'), chips.el, stop.el, tp.el);
    sides[side] = { cb, sd, chips, stop, tp };
    return wrap;
  };
  const fromScreen = screens.length ? el('select', { onchange: (e) => {
    const sc = screens.find(x => x.id === e.target.value);
    e.target.value = '';
    if (!sc) return;
    tf.value = sc.spec.tf;
    const L = sides.long;
    L.sd.entry.splice(0, L.sd.entry.length, ...JSON.parse(JSON.stringify(sc.spec.conds)));
    L.cb.checked = true; L.cb.dispatchEvent(new Event('change'));
    L.chips.render();
    onChange?.();
  } }, el('option', { value: '' }, 'Load entry from a saved screen…'), screens.map(sc => el('option', { value: sc.id }, sc.name))) : null;
  box.append(el('div', { class: 'st-row' }, el('label', {}, 'Timeframe'), tf, fromScreen), sideBox('long'), sideBox('short'));
  return { el: box, get: () => {
    const out = { tf: tf.value, long: null, short: null };
    for (const side of ['long', 'short']) {
      const x = sides[side];
      if (x.cb.checked) out[side] = { entry: x.sd.entry, stop: x.stop.get(), tp: x.tp.get() };
    }
    return out;
  } };
}

function strategySummary(st) {
  const parts = [];
  for (const side of ['long', 'short']) {
    const sd = st[side];
    if (sd) parts.push(`${side === 'long' ? 'Long' : 'Short'}: ${sd.entry.map(condLabel).join(' AND ')} · stop ${exitLabel(sd.stop)} · TP ${exitLabel(sd.tp)}`);
  }
  return parts.join(' | ');
}

// ======================================================================= trades on the chart
// Two sources: trades picked in the tester / paper trading (`shown`, until the symbol changes) and the strategy
// added to the chart (`chartStrat`, re-run on the chart's symbol and timeframe like a TradingView strategy).
// Entries are arrows, exits circles labelled TP / SL with the net, the stop and take-profit levels of each trade
// dashed lines from its entry to its exit.
let shown = null;      // {symbol, tf, trades, open}
let markerApi = null, markerSeries = null;
let levelSeries = [];
let chartStrat = null;   // {id, name, strategy, size, visible}: saved with the chart layout (S.chartStrategy)
const saveChartStrat = () => { S.chartStrategy = chartStrat; app.saveLayout(); };
// the screen open in the screener ({id, name, spec}), saved with the chart layout too (S.activeScreen)
const getActiveScreen = () => S.activeScreen || null;
const setActiveScreen = (cur) => { S.activeScreen = cur ? JSON.parse(JSON.stringify(cur)) : null; app.saveLayout(); };
let chartRun = null;   // {key, symbol, tf, strategy, r, trades, open, total, error, busy}

function layer() {
  if (shown && shown.symbol === S.symbol && shown.tf === S.tf) return shown;
  if (chartStrat && chartStrat.visible !== false && chartRun && !chartRun.error && chartRun.symbol === S.symbol && chartRun.tf === S.tf) return chartRun;
  return null;
}
const exitTag = (t) => (t.reason === 'sl' ? 'SL' : t.reason === 'tp' ? 'TP' : 'Exit');

function applyMarkers() {
  if (!app.mainSeries) return;
  const L = layer();
  const off = S.tzOffset || 0;
  const list = [];
  if (L) {
    for (const t of L.trades) {
      const long = t.side > 0;
      list.push({ time: t.entry_ts + off, position: long ? 'belowBar' : 'aboveBar', color: long ? '#089981' : '#f23645', shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'Long' : 'Short' });
      if (t.exit_ts != null) {
        const below = (t.reason === 'sl') === long;   // a long's stop and a short's take-profit sit below the price
        list.push({ time: t.exit_ts + off, position: below ? 'belowBar' : 'aboveBar', color: t.net >= 0 ? '#26a69a' : '#ef5350', shape: 'circle', text: `${exitTag(t)} ${fmtMoney(t.net)}` });
      }
    }
    if (L.open) {
      const long = L.open.side > 0;
      list.push({ time: L.open.entry_ts + off, position: long ? 'belowBar' : 'aboveBar', color: '#2962ff', shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'Long' : 'Short'} (open)` });
    }
    list.sort((a, b) => a.time - b.time);
  }
  if (markerSeries !== app.mainSeries) { markerApi = null; markerSeries = app.mainSeries; }
  if (!markerApi) {
    if (list.length) markerApi = LightweightCharts.createSeriesMarkers(app.mainSeries, list);
  } else markerApi.setMarkers(list);
  drawLevels(L);
}

function drawLevels(L) {
  for (const s of levelSeries) { try { app.chart.removeSeries(s); } catch { /* chart rebuilt */ } }
  levelSeries = [];
  if (!L || !app.chart) return;
  const off = S.tzOffset || 0;
  const items = [...L.trades, ...(L.open ? [{ ...L.open, exit_ts: null }] : [])].filter(t => t.stop != null || t.tp != null)
    .sort((a, b) => a.entry_ts - b.entry_ts);
  if (!items.length) return;
  const lastT = S.view.length ? S.view[S.view.length - 1].time : null;
  // one series per level: a segment takes the color of its first point (LWC 5; whitespace does not break a
  // line), so each trade's line starts at its entry in color and the segment from its exit to the next trade is
  // transparent
  const data = { stop: [], tp: [] };
  const COLORS = { stop: '#f23645', tp: '#089981' };
  for (const t of items) {
    const a = t.entry_ts + off, b = t.exit_ts != null ? t.exit_ts + off : lastT;
    if (b == null || b < a) continue;
    for (const k of ['stop', 'tp']) {
      const arr = data[k];
      if (t[k] == null || (arr.length && arr[arr.length - 1].time >= a)) continue;
      if (b > a) arr.push({ time: a, value: t[k], color: COLORS[k] });
      arr.push({ time: b, value: t[k], color: 'transparent' });
    }
  }
  const pane = app.mainPaneIndex?.() || 0;
  for (const k of ['stop', 'tp']) {
    if (!data[k].length) continue;
    const s = app.chart.addSeries(LightweightCharts.LineSeries, { color: COLORS[k], lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false, pointMarkersVisible: false, autoscaleInfoProvider: () => null, title: '' }, pane);
    s.setData(data[k]);
    levelSeries.push(s);
  }
}

async function showTrades(symbol, tf, trades, open = null) {
  shown = { symbol, tf, trades, open };
  if (S.symbol !== symbol || S.tf !== tf) await app.setSymbol(symbol, { tf });
  applyMarkers();
}
function clearTrades() { shown = null; applyMarkers(); }
async function focusTrade(t) {
  const off = S.tzOffset || 0;
  const err = await app.goTo(t.entry_ts + off, t.exit_ts != null ? t.exit_ts + off : null);
  if (err) toast(err, 'error');
}

async function ensureMeta() {
  if (!meta) meta = await api.screenerMeta();
  return meta;
}

// ---- the strategy on the chart
function addToChart(s) {
  chartStrat = { id: s.id || null, name: s.name || 'Strategy', strategy: JSON.parse(JSON.stringify(s.strategy)), size: s.size || 1000, visible: true };
  saveChartStrat();
  shown = null;
  runChartStrategy(true);
  toast(`"${chartStrat.name}" added to the chart (runs on the chart's symbol and timeframe)`, 'ok');
}
function removeFromChart() {
  chartStrat = null; chartRun = null;
  saveChartStrat();
  applyMarkers(); app.renderLegend?.();
}

async function runChartStrategy(force = false) {
  if (!chartStrat || !S.bars?.length) return;
  const tf = S.tf, symbol = S.symbol;
  const key = `${symbol}|${tf}|${S.bars[0].time}|${S.bars[S.bars.length - 1].time}|${JSON.stringify(chartStrat.strategy)}|${chartStrat.size}`;
  if (!force && chartRun && chartRun.key === key) return;
  const prev = chartRun && chartRun.symbol === symbol && chartRun.tf === tf ? chartRun : null;
  chartRun = { ...(prev || { trades: [] }), key, symbol, tf, busy: true, error: null };
  app.renderLegend?.();
  const strategy = { ...chartStrat.strategy, tf };
  let next;
  try {
    await ensureMeta();
    if (!meta.timeframes.includes(tf)) throw new Error(`the backtester has no ${tf} timeframe`);
    const start = S.bars[0].time - (S.tzOffset || 0);
    const r = await api.backtest({ source: app.symbolSource(symbol) || meta.sources[0]?.prefix, strategy, symbols: [symbol],
      start, end: Math.floor(Date.now() / 1000), size: chartStrat.size || 1000 });
    const s = r.symbols[0] || {};
    next = { key, symbol, tf, strategy, r, trades: s.trades || [], open: null, total: s.metrics || null, error: s.skipped || null, start: s.start || start };
  } catch (e) {
    next = { key, symbol, tf, strategy, trades: [], error: e.message };
  }
  if (!chartRun || chartRun.key !== key) return;   // superseded by a newer run
  chartRun = next;
  applyMarkers();
  app.renderLegend?.();
}

function strategyLegend() {
  if (!chartStrat) return null;
  const R = chartRun && chartRun.symbol === S.symbol && chartRun.tf === S.tf ? chartRun : null;
  const m = R?.total;
  const info = !R || R.busy ? el('span', { class: 'muted' }, 'running…')
    : R.error ? el('span', { class: 'err', title: R.error }, '⚠ ' + R.error.slice(0, 80))
      : el('span', {}, `${m?.trades ?? 0} trades · `, el('span', { class: cls(m?.net) }, fmtMoney(m?.net ?? 0)),
        m?.win_pct != null ? ` · win ${m.win_pct.toFixed(1)}%` : '', m?.profit_factor != null ? ` · PF ${m.profit_factor.toFixed(2)}` : '');
  const vis = chartStrat.visible !== false;
  const toggle = () => { chartStrat.visible = !vis; saveChartStrat(); applyMarkers(); app.renderLegend?.(); };
  return el('div', { class: `lg-ind lg-strat ${vis ? '' : 'off'}`, 'data-testid': 'chart-strategy' },
    el('span', { class: 'lg-name', title: strategySummary(chartStrat.strategy) }, `Strategy: ${chartStrat.name}`),
    el('span', { class: 'lg-vals' }, info),
    el('span', { class: 'lg-actions' },
      el('button', { class: 'lg-act', title: vis ? 'Hide' : 'Show', 'data-testid': 'cs-toggle', html: vis ? ICONS.eye : ICONS.eyeOff, onclick: toggle }),
      el('button', { class: 'lg-act', title: 'Strategy report (equity curve, trades)', 'data-testid': 'cs-report', html: ICONS.stats, onclick: openChartReport }),
      el('button', { class: 'lg-act', title: 'Edit in the Strategy Tester', 'data-testid': 'cs-edit', html: ICONS.gear, onclick: async () => {
        await openPanel('tester');
        views.tester?.edit({ id: chartStrat.id, name: chartStrat.name, strategy: { ...chartStrat.strategy, tf: S.tf }, size: chartStrat.size });
      } }),
      el('button', { class: 'lg-act', title: 'Remove from the chart', 'data-testid': 'cs-remove', html: ICONS.trash.replace(/16/g, '14'), onclick: removeFromChart })));
}

async function openChartReport() {
  if (!chartRun?.r) return toast(chartRun?.error || 'The strategy has not run yet', 'error');
  await openPanel('tester');
  views.tester?.showResult(chartRun.r, chartRun.strategy, { size: chartStrat.size || 1000, title: `${chartStrat.name} on ${app.symbolName(chartRun.symbol)} ${chartRun.tf} (chart)` });
}

function tradesTable(trades, { onPick } = {}) {
  const tb = el('tbody');
  for (const t of trades) {
    tb.append(el('tr', { onclick: () => onPick?.(t) },
      el('td', {}, t.symbol ? app.symbolName(t.symbol) : (t.side > 0 ? 'Long' : 'Short')),
      t.symbol ? el('td', { class: 'l' }, t.side > 0 ? 'Long' : 'Short') : null,
      el('td', {}, fmtDT(t.entry_ts)), el('td', {}, fmtVal(t.entry_px)),
      el('td', {}, t.exit_ts != null ? fmtDT(t.exit_ts) : 'open'), el('td', {}, fmtVal(t.exit_px)),
      el('td', { class: cls(t.net) }, fmtMoney(t.net))));
  }
  const first = trades[0]?.symbol ? ['Symbol', 'Side'] : ['Side'];
  return el('table', { class: 'sc-table', 'data-testid': 'trades-table' },
    el('thead', {}, el('tr', {}, [...first, 'Entry', 'Price', 'Exit', 'Price', 'Net'].map(h => el('th', {}, h)))), tb);
}

// ======================================================================= strategy report
// Overview (key numbers, equity curve and drawdown), Performance (all / long / short), the list of trades and,
// for several symbols, a row per symbol. Used for backtests, the strategy on the chart and paper trading.
function perfStats(trades, tfSec) {
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.net, 0);
  const bars = (t) => t.bars ?? Math.round((t.exit_ts - t.entry_ts) / tfSec);
  const avg = (a, f) => (a.length ? a.reduce((x, t) => x + f(t), 0) / a.length : null);
  let cw = 0, cl = 0, mcw = 0, mcl = 0, eq = 0, peak = 0, dd = 0;
  for (const t of trades.slice().sort((a, b) => a.exit_ts - b.exit_ts)) {
    if (t.net > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    mcw = Math.max(mcw, cw); mcl = Math.max(mcl, cl);
    eq += t.net; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
  }
  const gp = sum(wins), gl = -sum(losses);
  const aw = avg(wins, t => t.net), al = avg(losses, t => t.net);
  return {
    net: sum(trades), gross_profit: gp, gross_loss: -gl, pf: gl > 0 ? gp / gl : null, trades: trades.length,
    wins: wins.length, losses: losses.length, win_pct: trades.length ? wins.length / trades.length * 100 : null,
    avg: avg(trades, t => t.net), avg_win: aw, avg_loss: al, ratio: aw != null && al ? aw / -al : null,
    best: wins.length ? Math.max(...wins.map(t => t.net)) : null, worst: losses.length ? Math.min(...losses.map(t => t.net)) : null,
    mcw, mcl, bars: avg(trades, bars), bars_win: avg(wins, bars), bars_loss: avg(losses, bars), max_dd: trades.length ? dd : null,
    sl: trades.filter(t => t.reason === 'sl').length, tp: trades.filter(t => t.reason === 'tp').length,
    run_up: avg(trades.filter(t => t.run_up != null), t => t.run_up), draw: avg(trades.filter(t => t.draw != null), t => -t.draw),
  };
}

const PERF_ROWS = [
  ['net', 'Net profit', 'm'], ['gross_profit', 'Gross profit', 'm'], ['gross_loss', 'Gross loss', 'm'], ['pf', 'Profit factor', 'r'],
  ['max_dd', 'Max drawdown (closed trades)', 'm'], ['trades', 'Total trades', 'n'], ['wins', 'Winning trades', 'n'], ['losses', 'Losing trades', 'n'],
  ['win_pct', 'Percent profitable', 'p'], ['avg', 'Avg trade', 'm'], ['avg_win', 'Avg winning trade', 'm'], ['avg_loss', 'Avg losing trade', 'm'],
  ['ratio', 'Ratio avg win / avg loss', 'r'], ['best', 'Largest winning trade', 'm'], ['worst', 'Largest losing trade', 'm'],
  ['mcw', 'Max consecutive wins', 'n'], ['mcl', 'Max consecutive losses', 'n'], ['bars', 'Avg bars in trades', 'b'],
  ['bars_win', 'Avg bars in winning trades', 'b'], ['bars_loss', 'Avg bars in losing trades', 'b'],
  ['run_up', 'Avg run-up', 'm'], ['draw', 'Avg drawdown', 'm'], ['tp', 'Exits at take profit', 'n'], ['sl', 'Exits at stop', 'n'],
];
function fmtStat(v, kind) {
  if (v == null || Number.isNaN(v)) return '—';
  if (kind === 'm') return fmtMoney(v);
  if (kind === 'p') return v.toFixed(2) + '%';
  if (kind === 'r') return v.toFixed(3);
  if (kind === 'b') return v.toFixed(1);
  return String(v);
}

function cssVar(name, d) { return getComputedStyle(document.body).getPropertyValue(name).trim() || d; }

function equityChart(box, trades) {
  const LWC = LightweightCharts;
  const ch = LWC.createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: cssVar('--muted', '#888'), fontSize: 11, panes: { separatorColor: cssVar('--border', '#333') } },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--border', '#2a2e39') } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    crosshair: { mode: 0 }, handleScroll: true, handleScale: true,
  });
  const off = S.tzOffset || 0;
  const pts = new Map();
  for (const t of trades.slice().sort((a, b) => a.exit_ts - b.exit_ts)) pts.set(t.exit_ts + off, (pts.get(t.exit_ts + off) || 0) + t.net);
  let eq = 0, peak = 0;
  const first = trades.length ? Math.min(...trades.map(t => t.entry_ts)) + off : null;
  const E = [], D = [];
  if (first != null && !pts.has(first)) { E.push({ time: first, value: 0 }); D.push({ time: first, value: 0 }); }
  for (const [time, n] of [...pts.entries()].sort((a, b) => a[0] - b[0])) {
    eq += n; peak = Math.max(peak, eq);
    E.push({ time, value: eq }); D.push({ time, value: eq - peak });
  }
  const fmt = { type: 'price', precision: 2, minMove: 0.01 };
  const e = ch.addSeries(LWC.BaselineSeries, { baseValue: { type: 'price', price: 0 }, priceFormat: fmt, lineWidth: 2,
    topLineColor: '#089981', topFillColor1: 'rgba(8,153,129,.28)', topFillColor2: 'rgba(8,153,129,.04)',
    bottomLineColor: '#f23645', bottomFillColor1: 'rgba(242,54,69,.04)', bottomFillColor2: 'rgba(242,54,69,.28)', title: 'Equity' });
  e.setData(E);
  const d = ch.addSeries(LWC.HistogramSeries, { color: 'rgba(242,54,69,.5)', priceFormat: fmt, title: 'Drawdown', lastValueVisible: false, priceLineVisible: false }, 1);
  d.setData(D);
  try { ch.panes()[0].setStretchFactor(3); ch.panes()[1].setStretchFactor(1); } catch { /* older LWC */ }
  ch.timeScale().fitContent();
  return ch;
}

function csvOf(trades) {
  const q = (v) => (v == null ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const iso = (s) => (s == null ? '' : new Date(s * 1000).toISOString());
  const rows = [['symbol', 'side', 'entry_time_utc', 'entry_price', 'exit_time_utc', 'exit_price', 'exit', 'stop', 'take_profit', 'net', 'net_pct', 'bars']];
  for (const t of trades) rows.push([t.symbol || '', t.side > 0 ? 'long' : 'short', iso(t.entry_ts), t.entry_px, iso(t.exit_ts), t.exit_px, t.reason || '', t.stop, t.tp, t.net.toFixed(4), t.pct?.toFixed(4), t.bars ?? '']);
  return rows.map(r => r.map(q).join(',')).join('\n');
}

/**
 * r: {symbols: [{symbol, metrics, trades, skipped}], total, ms}; opts: {strategy, size, title, onSymbol}.
 * Returns {el, destroy}.
 */
function resultsView(r, { strategy, size = 1000, title = '', testid = 'st' } = {}) {
  const tfSec = meta?.tf_sec?.[strategy.tf] || TF_SECONDS[strategy.tf] || 3600;
  const ok = r.symbols.filter(s => !s.skipped);
  const all = ok.flatMap(s => (s.trades || []).map(t => ({ ...t, symbol: s.symbol, pct: t.net / size * 100 })));
  all.sort((a, b) => a.entry_ts - b.entry_ts);
  const capital = size * Math.max(1, ok.length);
  const t = r.total || {};
  const P = { all: perfStats(all, tfSec), long: perfStats(all.filter(x => x.side > 0), tfSec), short: perfStats(all.filter(x => x.side < 0), tfSec) };
  let chart = null;
  const root = el('div', { class: 'rep', 'data-testid': `${testid}-report` });
  const tabs = el('div', { class: 'rep-tabs' });
  const body = el('div', { class: 'rep-body' });
  const card = (label, v, c = '', sub = '') => el('div', { class: 'card' }, el('b', { class: c }, v), el('small', {}, label), sub ? el('small', { class: 'muted' }, sub) : null);
  const pages = {
    overview: () => {
      const eqBox = el('div', { class: 'eq-chart', 'data-testid': `${testid}-equity` });
      const node = el('div', {},
        el('div', { class: 'cards', 'data-testid': `${testid}-total` },
          card('Net profit', fmtMoney(P.all.net), cls(P.all.net), fmtPct(P.all.net / capital * 100)),
          card('Trades', P.all.trades), card('Win rate', P.all.win_pct != null ? P.all.win_pct.toFixed(1) + '%' : '—'),
          card('Profit factor', P.all.pf != null ? P.all.pf.toFixed(2) : '—'),
          card('Max drawdown', t.max_dd_pct != null ? t.max_dd_pct.toFixed(1) + '%' : fmtMoney(P.all.max_dd), t.max_dd_pct != null ? 'down' : cls(P.all.max_dd)),
          card('Avg trade', fmtMoney(P.all.avg), cls(P.all.avg)),
          card('Sharpe', t.sharpe != null ? t.sharpe.toFixed(2) : '—'), card('Exposure', t.exposure_pct != null ? t.exposure_pct.toFixed(1) + '%' : '—')),
        all.length ? eqBox : el('div', { class: 'bp-empty' }, 'No closed trade in this period.'));
      if (all.length) requestAnimationFrame(() => { chart?.remove(); chart = equityChart(eqBox, all); });
      return node;
    },
    performance: () => el('table', { class: 'sc-table perf', 'data-testid': `${testid}-perf` },
      el('thead', {}, el('tr', {}, ['', 'All', 'Long', 'Short'].map(h => el('th', {}, h)))),
      el('tbody', {}, PERF_ROWS.map(([k, label, kind]) => el('tr', {}, el('td', { class: 'l' }, label),
        ...['all', 'long', 'short'].map(s => el('td', { class: kind === 'm' ? cls(P[s][k]) : '' }, fmtStat(P[s][k], kind))))))),
    trades: () => {
      const many = ok.length > 1;
      let desc = true;
      const box = el('div');
      const render = () => {
        const list = desc ? all.slice().reverse() : all;
        let cum = 0;
        const cums = new Map(all.slice().sort((a, b) => a.exit_ts - b.exit_ts).map(x => [x, (cum += x.net)]));
        const tb = el('tbody');
        list.slice(0, 3000).forEach((x) => {
          const n = all.indexOf(x) + 1;
          tb.append(el('tr', { onclick: async () => { await showTrades(x.symbol, strategy.tf, all.filter(y => y.symbol === x.symbol)); focusTrade(x); } },
            el('td', {}, n), many ? el('td', {}, app.symbolName(x.symbol)) : null,
            el('td', { class: `l ${x.side > 0 ? 'up' : 'down'}` }, x.side > 0 ? 'Long' : 'Short'),
            el('td', {}, fmtDT(x.entry_ts)), el('td', {}, fmtVal(x.entry_px)), el('td', {}, fmtDT(x.exit_ts)), el('td', {}, fmtVal(x.exit_px)),
            el('td', {}, el('span', { class: `pill ${x.reason || ''}` }, exitTag(x))),
            el('td', {}, fmtVal(x.stop)), el('td', {}, fmtVal(x.tp)),
            el('td', { class: cls(x.net) }, fmtMoney(x.net)), el('td', { class: cls(x.pct) }, fmtPct(x.pct)),
            el('td', { class: cls(cums.get(x)) }, fmtMoney(cums.get(x))),
            el('td', {}, x.run_up != null ? fmtMoney(x.run_up) : '—'), el('td', {}, x.draw != null ? fmtMoney(-x.draw) : '—'),
            el('td', {}, x.bars ?? Math.round((x.exit_ts - x.entry_ts) / tfSec))));
        });
        const heads = ['#', ...(many ? ['Symbol'] : []), 'Side', 'Entry', 'Price', 'Exit', 'Price', 'Signal', 'Stop', 'TP', 'Net', 'Net %', 'Cum. net', 'Run-up', 'Drawdown', 'Bars'];
        box.replaceChildren(
          el('div', { class: 'sub-head' }, `${all.length} trades${all.length > 3000 ? ' (latest 3000 shown)' : ''} · click one to see it on the chart`, el('div', { class: 'spacer' }),
            el('button', { class: 'btn small ghost', onclick: () => { desc = !desc; render(); } }, desc ? 'Newest first' : 'Oldest first'),
            el('button', { class: 'btn small ghost', 'data-testid': `${testid}-csv`, onclick: () => {
              const a = el('a', { href: URL.createObjectURL(new Blob([csvOf(all)], { type: 'text/csv' })), download: `${(title || 'trades').replace(/[^\w.-]+/g, '_')}.csv` });
              a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            } }, 'Export CSV')),
          all.length ? el('table', { class: 'sc-table', 'data-testid': `${testid}-trades` }, el('thead', {}, el('tr', {}, heads.map(h => el('th', {}, h)))), tb)
            : el('div', { class: 'bp-empty' }, 'No closed trade.'));
      };
      render();
      return box;
    },
    symbols: () => {
      const tradesBox = el('div');
      const tb = el('tbody');
      for (const s of r.symbols) {
        const m = s.metrics || {};
        const tr = el('tr', { 'data-sym': s.symbol, onclick: async () => {
          for (const x of tb.children) x.classList.toggle('sel', x === tr);
          if (s.skipped) return;
          const tl = s.trades.map(x => ({ ...x, symbol: s.symbol }));
          await showTrades(s.symbol, strategy.tf, tl);
          tradesBox.replaceChildren(el('div', { class: 'sub-head' }, `${app.symbolName(s.symbol)} · ${s.trades.length} trades (click one to see it on the chart)`, el('div', { class: 'spacer' }),
            el('button', { class: 'btn small ghost', onclick: () => { clearTrades(); tradesBox.replaceChildren(); } }, 'Hide on chart')),
          tradesTable(tl.slice().reverse().map(x => ({ ...x, symbol: undefined })), { onPick: focusTrade }));
        } }, el('td', {}, app.symbolName(s.symbol)),
        ...(s.skipped ? [el('td', { colspan: 6, class: 'l muted' }, s.skipped)] : [
          el('td', {}, m.trades ?? 0), el('td', { class: cls(m.net) }, fmtMoney(m.net)), el('td', {}, m.win_pct != null ? m.win_pct.toFixed(1) + '%' : '—'),
          el('td', {}, m.profit_factor != null ? m.profit_factor.toFixed(2) : '—'), el('td', {}, m.max_dd_pct != null ? m.max_dd_pct.toFixed(1) + '%' : '—'),
          el('td', {}, m.sharpe != null ? m.sharpe.toFixed(2) : '—')]));
        tb.append(tr);
      }
      return el('div', {}, el('table', { class: 'sc-table', 'data-testid': `${testid}-table` }, el('thead', {}, el('tr', {}, ['Symbol', 'Trades', 'Net', 'Win %', 'PF', 'Max DD', 'Sharpe'].map(h => el('th', {}, h)))), tb), tradesBox);
    },
  };
  const names = [['overview', 'Overview'], ['performance', 'Performance'], ['trades', 'List of trades'], ['symbols', `Symbols (${r.symbols.length})`]];
  let curPage = ls.get('rep.page', 'overview');
  if (!pages[curPage]) curPage = 'overview';
  const show = (id) => {
    curPage = id; ls.set('rep.page', id);
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.page === id);
    if (id !== 'overview') { chart?.remove(); chart = null; }
    body.replaceChildren(pages[id]());
  };
  tabs.append(...names.map(([id, label]) => el('button', { class: 'rep-tab', 'data-page': id, 'data-testid': `rep-${id}`, onclick: () => show(id) }, label)));
  root.append(
    el('div', { class: 'help', style: { padding: '4px 8px', margin: 0 } }, `${title ? title + ' · ' : ''}${strategySummary(strategy)} · ${strategy.tf}${r.ms != null ? ` · ${(r.ms / 1000).toFixed(1)}s` : ''}`),
    tabs, body);
  show(curPage);
  return { el: root, destroy: () => { chart?.remove(); chart = null; } };
}

// ======================================================================= panel shell
let panelTab = null;
const TABS = [['screener', 'Screener'], ['tester', 'Strategy Tester'], ['paper', 'Paper Trading']];
const views = {};

export function initScreener(a) {
  app = a; S = a.S;
  const tg = $('#bp-toggles');
  for (const [id, label] of TABS) tg.append(el('button', { class: 'bb-btn', 'data-bp': id, 'data-testid': `bp-${id}`, onclick: () => openPanel(panelTab === id ? null : id) }, label));
  app.openBottomPanel = openPanel;
  // layouts saved before these were in them: take this browser's copy once (it used to be in localStorage)
  if (S.chartStrategy === undefined || S.activeScreen === undefined) {
    if (S.chartStrategy === undefined) S.chartStrategy = ls.get('chart.strategy', null);
    if (S.activeScreen === undefined) S.activeScreen = ls.get('sc.cur', null);
    try { localStorage.removeItem('chart.strategy'); localStorage.removeItem('sc.cur'); } catch { /* */ }
    app.saveLayout();
  }
  chartStrat = S.chartStrategy;
  app.legendExtra = strategyLegend;
  initScreenTab();
  // the strategy on the chart follows the chart: new symbol / timeframe / history, and new bars
  let rt = null;
  app.on('barsLoaded', () => { clearTimeout(rt); rt = setTimeout(() => runChartStrategy(), 400); });
  setInterval(() => { if (chartStrat && !document.hidden) runChartStrategy(); }, 30000);
  app.on('symbolChanged', () => { if (shown && shown.symbol !== S.symbol) shown = null; });
  app.on('barsLoaded', () => applyMarkers());
  const last = ls.get('bp.tab', null);
  if (last && !document.body.classList.contains('mobile')) openPanel(last);
}

function buildPanel() {
  const p = $('#bpanel');
  if (p.childElementCount) return p;
  const h = ls.get('bp.h', 320);
  p.style.setProperty('--bp-h', `${h}px`);
  const handle = el('div', { class: 'bp-resize', onpointerdown: (e) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = p.getBoundingClientRect().height;
    const move = (ev) => {
      const nh = Math.max(140, Math.min(window.innerHeight - 200, h0 + (y0 - ev.clientY)));
      p.style.setProperty('--bp-h', `${nh}px`);
      p.classList.remove('max');
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); ls.set('bp.h', parseInt(p.style.getPropertyValue('--bp-h'))); app.chart?.resize?.(0, 0, true); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  } });
  const head = el('div', { class: 'bp-head' },
    TABS.map(([id, label]) => el('button', { class: 'bp-tab', 'data-bp': id, onclick: () => openPanel(id) }, label)),
    el('div', { class: 'spacer' }),
    el('button', { class: 'lg-act', id: 'bp-max', title: 'Maximize', html: ICONS.maximize, onclick: () => p.classList.toggle('max') }),
    el('button', { class: 'lg-act', title: 'Close', 'data-testid': 'bp-close', html: ICONS.close, onclick: () => openPanel(null) }));
  p.append(handle, head, el('div', { class: 'bp-body', id: 'bp-body' }));
  return p;
}

async function openPanel(id) {
  const p = buildPanel();
  panelTab = id;
  ls.set('bp.tab', id);
  p.hidden = !id;
  for (const b of document.querySelectorAll('[data-bp]')) b.classList.toggle('active', b.dataset.bp === id);
  if (!id) return;
  if (!meta) {
    try { meta = await api.screenerMeta(); } catch (e) {
      $('#bp-body').replaceChildren(el('div', { class: 'bp-empty' }, `The backtester is not available: ${e.message}`));
      return;
    }
  }
  const body = $('#bp-body');
  for (const v of Object.values(views)) v.el.hidden = true;
  if (!views[id]) {
    views[id] = { screener: screenerView, tester: testerView, paper: paperView }[id]();
    body.append(views[id].el);
  }
  views[id].el.hidden = false;
  views[id].show?.();
}

// ======================================================================= screener tab
let lastResults = null;   // the screener's last result rows (for "symbols: screen results" in the tester)

function newSpec() {
  const tf = meta.timeframes.includes(S.tf) ? S.tf : '1h';
  return { source: meta.sources[0]?.prefix, tf, conds: [], columns: [], universe: { type: 'all' }, sort: { key: 'qvol24', dir: -1 } };
}

function screenerView() {
  const root = el('div', { class: 'bp-body', 'data-testid': 'screener' });
  let screens = [];
  let cur = getActiveScreen() || { id: null, name: '', spec: newSpec() };
  let saved = JSON.stringify(cur.spec);
  let res = null, running = false, timer = null, seq = 0;
  const status = el('span', { class: 'bp-status', 'data-testid': 'sc-status' });
  const nameBtn = el('button', { class: 'btn small', 'data-testid': 'sc-menu' });
  const tf = el('select', { 'data-testid': 'sc-tf', onchange: () => { cur.spec.tf = tf.value; changed(); } });
  const uni = el('select', { 'data-testid': 'sc-universe', onchange: () => {
    const v = uni.value;
    cur.spec.universe = v === 'all' ? { type: 'all' } : { type: 'watchlist', id: v.slice(3) };
    changed();
  } });
  let filters = condChips(cur.spec.conds, () => changed());
  const resetFilters = () => { const n = condChips(cur.spec.conds, () => changed()); filters.el.replaceWith(n.el); filters = n; };
  const colsBox = el('div', { class: 'chips' });
  const table = el('div', { class: 'bp-scroll' });

  const dirty = () => JSON.stringify(cur.spec) !== saved;
  const persist = () => { setActiveScreen(cur); screenTabHead?.(); };
  const renderHead = () => {
    nameBtn.replaceChildren(el('span', {}, (cur.name || 'Unsaved screen') + (dirty() ? ' *' : '')), el('span', { html: ICONS.caret, style: { display: 'inline-flex', marginLeft: '4px' } }));
    tf.replaceChildren(...meta.timeframes.map(t => el('option', { value: t, selected: t === cur.spec.tf }, t)));
    const u = cur.spec.universe || { type: 'all' };
    uni.replaceChildren(el('option', { value: 'all' }, 'All symbols'),
      ...(S.watchlists || []).map(w => el('option', { value: 'wl:' + w.id, selected: u.type === 'watchlist' && u.id === w.id }, `Watchlist: ${w.name}`)));
    colsBox.replaceChildren(...cur.spec.columns.map((o, i) => el('span', { class: 'chip col', 'data-testid': 'col-chip', onclick: async () => {
      const n = await columnDialog(o); if (n) { cur.spec.columns[i] = n; changed(); }
    } }, opLabel(o), el('button', { class: 'x', onclick: (e) => { e.stopPropagation(); cur.spec.columns.splice(i, 1); changed(); } }, '×'))),
    el('button', { class: 'btn small ghost', 'data-testid': 'col-add', onclick: async () => {
      if (cur.spec.columns.length >= meta.max_columns) return toast(`At most ${meta.max_columns} columns`, 'error');
      const n = await columnDialog(); if (n) { cur.spec.columns.push(n); changed(); }
    } }, '+ Column'));
  };
  const changed = () => { persist(); renderHead(); filters.render(); run(); };
  const load = (sc) => {
    cur = { id: sc.id, name: sc.name, spec: JSON.parse(JSON.stringify(sc.spec)) };
    if (!cur.spec.sort) cur.spec.sort = { key: 'qvol24', dir: -1 };
    saved = JSON.stringify(cur.spec);
    resetFilters();
    changed();
  };
  const save = async (asNew = false) => {
    let name = cur.name;
    if (asNew || !cur.id) {
      name = await promptDialog(asNew ? 'Save screen as' : 'Save screen', asNew ? `${cur.name} copy` : cur.name || 'My screen');
      if (!name) return;
    }
    try {
      const { screen } = await api.saveScreen({ id: asNew ? null : cur.id, name, spec: cur.spec });
      cur = { id: screen.id, name: screen.name, spec: cur.spec };
      saved = JSON.stringify(cur.spec);
      await loadScreens();
      persist(); renderHead();
      toast('Screen saved', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  };
  const loadScreens = async () => { try { screens = (await api.screens()).screens; } catch { screens = []; } };
  nameBtn.onclick = async () => {
    await loadScreens();
    showMenu(nameBtn, [
      ...(screens.length ? [{ title: 'Saved screens' }] : []),
      ...screens.map(sc => ({ label: sc.name, active: sc.id === cur.id, testid: 'sc-open', onClick: () => load(sc) })),
      { sep: true },
      { label: 'New screen', testid: 'sc-new', onClick: () => { cur = { id: null, name: '', spec: newSpec() }; saved = ''; resetFilters(); changed(); } },
      { label: cur.id ? 'Save' : 'Save…', testid: 'sc-save', onClick: () => save(false) },
      ...(cur.id ? [
        { label: 'Save as…', testid: 'sc-saveas', onClick: () => save(true) },
        { label: 'Rename…', testid: 'sc-rename', onClick: async () => {
          const n = await promptDialog('Rename screen', cur.name); if (!n) return;
          try { await api.saveScreen({ id: cur.id, name: n, spec: JSON.parse(saved) }); cur.name = n; persist(); renderHead(); await loadScreens(); } catch (e) { toast(e.message, 'error'); }
        } },
        { label: 'Delete', testid: 'sc-delete', onClick: async () => {
          if (!(await confirmDialog(`Delete the screen "${cur.name}"? Its screener alerts stop.`, { ok: 'Delete', danger: true }))) return;
          await api.deleteScreen(cur.id); cur = { ...cur, id: null, name: '' }; saved = ''; persist(); renderHead(); await loadScreens();
        } },
      ] : []),
    ]);
  };

  const sortKey = () => cur.spec.sort || { key: 'qvol24', dir: -1 };
  const renderTable = () => {
    if (!res) return;
    const ops = res.operands || [];
    const cols = [['symbol', 'Symbol'], ['last', 'Price'], ['chg24', 'Chg 24h'], ['qvol24', 'Vol 24h'], ['regime', 'Regime'],
      ...ops.map((o, i) => [`v${i}`, opLabel(engineToApp(o))])];
    const sk = sortKey();
    const val = (r, k) => (k === 'symbol' ? r.symbol : k === 'last' ? (r.last ?? r.close) : k.startsWith('v') && k !== 'vol' ? r.values[+k.slice(1)] : r[k]);
    const rows = res.rows.slice().sort((x, y) => {
      const a = val(x, sk.key), b = val(y, sk.key);
      if (a == null) return 1; if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sk.dir;
    });
    const tb = el('tbody');
    for (const r of rows) {
      tb.append(el('tr', { class: r.symbol === S.symbol ? 'sel' : '', 'data-sym': r.symbol, onclick: () => { app.setSymbol(r.symbol); if (document.body.classList.contains('mobile')) openPanel(null); } },
        el('td', {}, app.symbolName(r.symbol), r.entered ? el('span', { class: 'new-dot', title: 'New match on this bar' }) : null),
        el('td', {}, fmtVal(r.last ?? r.close)),
        el('td', { class: cls(r.chg24) }, fmtPct(r.chg24)),
        el('td', {}, fmtVal(r.qvol24)),
        el('td', {}, r.regime ? el('span', { class: `regime ${r.regime}` }, r.regime) : '—'),
        ...r.values.map(v => el('td', {}, fmtVal(v)))));
    }
    const th = cols.map(([k, l]) => el('th', { class: sk.key === k ? 'sorted' : '', onclick: () => {
      cur.spec.sort = { key: k, dir: sk.key === k ? -sk.dir : (k === 'symbol' ? 1 : -1) }; persist(); renderHead(); renderTable();
    } }, l, sk.key === k ? (sk.dir > 0 ? ' ▲' : ' ▼') : ''));
    table.replaceChildren(rows.length ? el('table', { class: 'sc-table', 'data-testid': 'sc-table' }, el('thead', {}, el('tr', {}, th)), tb)
      : el('div', { class: 'bp-empty' }, 'No symbol matches the filters on the last closed bar.'));
  };
  const run = async () => {
    const my = ++seq;
    running = true;
    status.textContent = 'Scanning…';
    try {
      const r = await api.screenerRun(cur.spec);
      if (my !== seq) return;
      res = r;
      lastResults = r.rows.map(x => x.symbol);
      publishScreen(cur, r);
      const bar = r.time ? fmtDT(r.time) : '—';
      status.textContent = `${r.rows.length} of ${r.scanned - r.skipped} match · bar ${bar} (${cur.spec.tf})`;
      status.title = r.skipped ? `${r.skipped} symbols without data on this bar were skipped` : '';
      renderTable();
    } catch (e) {
      if (my !== seq) return;
      status.textContent = '';
      table.replaceChildren(el('div', { class: 'bp-empty' }, e.message));
    } finally { if (my === seq) running = false; }
  };
  const alertBtn = el('button', { class: 'btn small ghost', 'data-testid': 'sc-alert', title: 'Alert when symbols newly match this saved screen', html: ICONS.bell + ' Alert', onclick: async () => {
    if (!cur.id || dirty()) {
      if (!(await confirmDialog('An alert follows a saved screen. Save the screen now?', { ok: 'Save' }))) return;
      await save(false);
      if (!cur.id) return;
    }
    screenerAlertDialog(cur);
  } });
  root.append(
    el('div', { class: 'bp-bar' }, nameBtn, tf, uni, el('button', { class: 'btn small ghost', title: 'Refresh', onclick: run }, '↻'), alertBtn, el('div', { class: 'spacer' }), status),
    el('div', { class: 'bp-bar' }, filters.el, el('span', { class: 'muted' }, 'Columns:'), colsBox),
    table);
  renderHead();
  app.on('symbolChanged', () => { for (const tr of table.querySelectorAll('tr[data-sym]')) tr.classList.toggle('sel', tr.dataset.sym === S.symbol); });
  return { el: root, current: () => cur, load, run, show: () => {
    renderHead();
    run();
    clearInterval(timer);
    timer = setInterval(() => { if (panelTab === 'screener' && !document.hidden && !running) run(); }, 60000);
  } };
}

function engineToApp(o) { // operands echoed by the backtester use engine names (1d, price indicator)
  const tf = { '1d': '1D', '1w': '1W' }[o.tf] || o.tf;
  if (o.ind === 'price') return { px: o.f, tf, sh: o.sh };
  return { ...o, tf };
}

async function screenerAlertDialog(cur) {
  let n = {};
  try { n = await api.notify(); } catch { /* defaults */ }
  const allowed = S.plan?.limits?.alert_channels || Object.keys(CHANNELS);
  const chans = Object.keys(CHANNELS).map(c => el('label', { style: { display: 'inline-flex', gap: '4px', marginRight: '10px' } },
    el('input', { type: 'checkbox', value: c, checked: c === 'app' || (n.default_channels || []).includes(c), disabled: c === 'app' || !allowed.includes(c) }), CHANNELS[c]));
  const freq = el('select', { 'data-testid': 'sa-freq' }, el('option', { value: 'once_per_bar' }, 'Every bar with new matches'), el('option', { value: 'once' }, 'Only once'));
  const msg = el('input', { placeholder: 'Optional message', style: { width: '100%' } });
  const m = modal({ title: `Alert: ${cur.name}`, width: '480px',
    body: el('div', { class: 'form-grid' },
      el('label', {}, 'Condition'), el('div', {}, `Symbols newly matching on a closed ${cur.spec.tf} bar`),
      el('label', {}, 'Trigger'), freq, el('label', {}, 'Notify'), el('div', {}, chans), el('label', {}, 'Message'), msg),
    footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', 'data-testid': 'sa-create', onclick: async () => {
        try {
          await api.saveAlert({ kind: 'screener', spec: { screen_id: cur.id }, frequency: freq.value, message: msg.value,
            channels: chans.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) });
          m.close();
          toast('Screener alert created (see the Alerts tab)', 'ok');
          app.loadAlerts?.();
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Create')] });
}

// ======================================================================= the screen in the right panel
// The Screener tab of the right panel lists the symbols matching the active screen (the one open in the screener),
// refreshed every minute while the tab is visible; a click opens the symbol.
let screenRes = null;            // {sig, res, at}
let screenTabHead = null, screenTabRender = null;
const screenSig = (spec) => JSON.stringify(spec ? { ...spec, sort: null, columns: null } : null);
function activeScreen() {
  return views.screener ? views.screener.current() : (getActiveScreen() || { id: null, name: '', spec: null });
}
function publishScreen(cur, res) {
  screenRes = { sig: screenSig(cur.spec), res, at: Date.now() };
  screenTabRender?.();
}

function initScreenTab() {
  const tab = $('#tab-screen');
  if (!tab) return;
  const nameBtn = el('button', { class: 'tb-btn', 'data-testid': 'rs-menu', style: { fontWeight: 600 } });
  const status = el('div', { class: 'rs-status', 'data-testid': 'rs-status' });
  const list = el('div', { class: 'wl-list', 'data-testid': 'rs-list' });
  let running = false;
  const visible = () => !tab.hidden && !document.hidden;
  const run = async () => {
    const cur = activeScreen();
    if (!cur.spec || running) return;
    running = true;
    status.textContent = 'Scanning…';
    try { publishScreen(cur, await api.screenerRun(cur.spec)); lastResults = screenRes.res.rows.map(x => x.symbol); } catch (e) { status.textContent = e.message; }
    finally { running = false; }
  };
  screenTabHead = () => nameBtn.replaceChildren(el('span', {}, activeScreen().name || 'Unsaved screen'), el('span', { html: ICONS.caret }));
  screenTabRender = () => {
    screenTabHead();
    const cur = activeScreen();
    if (!cur.spec) {
      status.textContent = '';
      list.replaceChildren(el('div', { class: 'wl-empty' }, 'No screen yet. ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); openPanel('screener'); } }, 'Open the screener')));
      return;
    }
    if (!screenRes || screenRes.sig !== screenSig(cur.spec)) { list.replaceChildren(); status.textContent = ''; return; }
    const r = screenRes.res;
    const sk = cur.spec.sort || { key: 'qvol24', dir: -1 };
    const val = (x) => (sk.key === 'symbol' ? x.symbol : sk.key === 'last' ? (x.last ?? x.close) : /^v\d+$/.test(sk.key) ? x.values[+sk.key.slice(1)] : x[sk.key]);
    const rows = r.rows.slice().sort((x, y) => {
      const a = val(x), b = val(y);
      if (a == null) return 1; if (b == null) return -1;
      return (typeof a === 'string' ? a.localeCompare(b) : a - b) * sk.dir;
    });
    status.textContent = `${r.rows.length} match · ${cur.spec.tf} · bar ${r.time ? fmtDT(r.time) : '—'}`;
    list.replaceChildren(...rows.map(x => el('div', { class: `wl-row rs-row ${x.symbol === S.symbol ? 'active' : ''}`, 'data-sym': x.symbol, title: x.symbol,
      onclick: () => app.setSymbol(x.symbol) },
    el('span', { class: 'wl-sym' }, app.symbolName(x.symbol), x.entered ? el('span', { class: 'new-dot', title: 'New match on this bar' }) : null),
    el('span', { class: 'wl-last' }, fmtVal(x.last ?? x.close)),
    el('span', { class: `wl-chgp ${cls(x.chg24)}` }, x.chg24 != null ? fmtPct(x.chg24) : ''))));
    if (!rows.length) list.append(el('div', { class: 'wl-empty' }, 'No symbol matches the filters on the last closed bar.'));
  };
  nameBtn.onclick = async () => {
    let screens = [];
    try { screens = (await api.screens()).screens; } catch { /* */ }
    const cur = activeScreen();
    showMenu(nameBtn, [
      ...(screens.length ? [{ title: 'Saved screens' }] : []),
      ...screens.map(sc => ({ label: sc.name, active: sc.id === cur.id, testid: 'rs-open', onClick: async () => {
        if (views.screener) views.screener.load(sc);
        else { setActiveScreen({ id: sc.id, name: sc.name, spec: sc.spec }); screenTabRender(); run(); }
      } })),
      { sep: true },
      { label: 'Edit in the screener', testid: 'rs-edit', onClick: () => openPanel('screener') },
    ]);
  };
  tab.append(el('div', { class: 'wl-head' }, nameBtn, el('div', { class: 'spacer' }),
    el('button', { class: 'tb-btn icon', title: 'Refresh', 'data-testid': 'rs-refresh', onclick: run }, '↻')),
  el('div', { class: 'wl-cols rs-cols' }, el('span', {}, 'Symbol'), el('span', {}, 'Last'), el('span', {}, 'Chg 24h')), list, status);
  const stale = () => !screenRes || screenRes.sig !== screenSig(activeScreen().spec) || Date.now() - screenRes.at > 60000;
  app.on('rpTab', (t) => { if (t === 'screen') { screenTabRender(); if (stale()) run(); } });
  app.on('symbolChanged', () => { for (const r of list.querySelectorAll('[data-sym]')) r.classList.toggle('active', r.dataset.sym === S.symbol); });
  setInterval(() => {
    // the open screener refreshes itself every minute; otherwise this tab does while it is visible
    if (visible() && !(panelTab === 'screener' && !$('#bpanel').hidden) && stale()) run();
  }, 15000);
  screenTabRender();
}

// ======================================================================= symbol picker
const fillSources = () => [['current', 'Current symbol'], ['screen', 'Screener results'], ...(S.watchlists || []).map(w => ['wl:' + w.id, `Watchlist: ${w.name}`])];
function resolveSymbols(v) {
  if (v === 'current') return [S.symbol];
  if (v === 'screen') return (lastResults || []).slice();
  if (v && v.startsWith('wl:')) return (S.watchlists.find(w => w.id === v.slice(3))?.symbols || []).slice();
  return [];
}

/**
 * Symbols of a backtest / paper-trading strategy. With modes: the current symbol, the screener's results, a
 * watchlist (all resolved when run) or a list picked in the symbol search (several at once).
 */
function symbolPicker(init, { modes = true, testid = 'st', onChange } = {}) {
  let list = (init?.list || []).slice();
  const box = el('div', { class: 'st-syms' });
  const sel = modes ? el('select', { 'data-testid': `${testid}-symbols` }) : null;
  const chips = el('div', { class: 'chips sym-chips', 'data-testid': `${testid}-sym-chips` });
  const count = el('span', { class: 'muted' });
  const changed = () => { renderChips(); onChange?.(); };
  const renderChips = () => {
    chips.replaceChildren(...list.map(s => el('span', { class: 'chip', 'data-testid': 'sym-chip', title: s }, app.symbolName(s),
      el('button', { class: 'x', title: 'Remove', onclick: () => { list = list.filter(x => x !== s); changed(); } }, '×'))));
    if (!list.length) chips.append(el('span', { class: 'muted' }, 'No symbol yet: add some from the symbol search.'));
    count.textContent = `${list.length} symbol${list.length === 1 ? '' : 's'}`;
  };
  const add = el('button', { class: 'btn small', 'data-testid': `${testid}-sym-add`, onclick: () => dialogs.symbolSearch(app, {
    title: 'Add symbols', multi: true, isChecked: (s) => list.includes(s),
    onPick: (s) => { list = list.includes(s) ? list.filter(x => x !== s) : [...list, s]; changed(); },
  }) }, '+ Add symbols');
  const fill = el('select', { title: 'Add the symbols of…', onchange: (e) => {
    const v = e.target.value; e.target.value = '';
    for (const s of resolveSymbols(v)) if (!list.includes(s)) list.push(s);
    changed();
  } });
  const renderFill = () => fill.replaceChildren(el('option', { value: '' }, 'Add from…'), ...fillSources().map(([v, l]) => el('option', { value: v }, l)));
  const clear = el('button', { class: 'btn small ghost', 'data-testid': `${testid}-sym-clear`, onclick: () => { list = []; changed(); } }, 'Clear');
  const listBox = el('div', { class: 'sym-list' }, el('div', { class: 'st-row' }, add, fill, clear, count), chips);
  const render = () => {
    renderFill();
    if (!sel) return;
    let v = sel.value || init?.mode || 'current';
    if (v === 'custom') v = 'list';
    sel.replaceChildren(...fillSources().map(([k, l]) => el('option', { value: k }, l)), el('option', { value: 'list' }, 'Selected symbols…'));
    sel.value = [...sel.options].some(o => o.value === v) ? v : 'current';
    listBox.hidden = sel.value !== 'list';
  };
  if (sel) sel.onchange = () => { listBox.hidden = sel.value !== 'list'; if (sel.value === 'list' && !list.length) add.click(); onChange?.(); };
  // a list typed in an older version ("custom")
  if (!list.length && init?.custom) {
    const prefix = app.symbolSource(S.symbol);
    list = init.custom.split(/[\s,;]+/).filter(Boolean).map(x => (x.includes(':') ? x : `${prefix}:${x}`).toUpperCase());
  }
  renderChips(); render();
  if (sel) box.append(el('div', { class: 'st-row' }, el('label', {}, 'Symbols'), sel));
  box.append(listBox);
  return { el: box, render,
    get: () => (!sel || sel.value === 'list' ? list.slice() : resolveSymbols(sel.value)),
    mode: () => ({ mode: sel ? sel.value : 'list', list: list.slice() }) };
}

// ======================================================================= strategy tester tab
const DEFAULT_STRATEGY = () => ({ tf: '1h', long: { entry: [], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } }, short: null });

function testerView() {
  const root = el('div', { class: 'bp-body', 'data-testid': 'tester' });
  // the form in progress: {id, name, spec: {strategy, symbols: {mode, list}, size, days}, from, to}
  let st = ls.get('st.cur', null);
  if (!st) {
    const old = ls.get('st.form', null);   // before saved strategies
    st = { id: null, name: '', spec: { strategy: old?.strategy || DEFAULT_STRATEGY(), symbols: old?.symbols || { mode: 'current', list: [] }, size: old?.size || 1000, days: 365 }, from: old?.from, to: old?.to };
  }
  let strategies = [], screens = [];
  let saved = null;      // JSON of the saved spec (unsaved changes show *)
  const left = el('div');
  const right = el('div', { 'data-testid': 'st-results' }, el('div', { class: 'bp-empty' }, 'Set up a strategy and run a backtest. Signals at a bar\'s close fill at the next open; one position per symbol; fees 0.05% and slippage 0.02% per side (stops 0.08% more).'));
  let report = null;
  let ed, syms;
  const from = el('input', { type: 'date', value: st.from || utcDate(Date.now() / 1000 - (st.spec.days || 365) * 86400), 'data-testid': 'st-from' });
  const to = el('input', { type: 'date', value: st.to || utcDate(Date.now() / 1000), 'data-testid': 'st-to' });
  const size = el('input', { class: 'st-num', type: 'number', min: 1, value: st.spec.size || 1000, 'data-testid': 'st-size' });
  const nameBtn = el('button', { class: 'btn small', 'data-testid': 'st-menu' });
  const runBtn = el('button', { class: 'btn primary small', 'data-testid': 'st-run' }, 'Run backtest');
  const days = () => Math.max(1, Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000) || 365);
  const collect = () => ({ strategy: ed.get(), symbols: syms.mode(), size: +size.value || 1000, days: days() });
  const dirty = () => saved == null || JSON.stringify(collect()) !== saved;
  const renderHead = () => nameBtn.replaceChildren(el('span', {}, (st.name || 'Unsaved strategy') + (st.id && !dirty() ? '' : st.id ? ' *' : '')),
    el('span', { html: ICONS.caret, style: { display: 'inline-flex', marginLeft: '4px' } }));
  const remember = () => { st = { ...st, spec: collect(), from: from.value, to: to.value }; ls.set('st.cur', st); renderHead(); };
  let rt = null;
  const touched = () => { clearTimeout(rt); rt = setTimeout(remember, 150); };
  const build = (spec) => {
    ed = strategyEditor(spec.strategy, { screens, onChange: touched });
    syms = symbolPicker(spec.symbols, { onChange: touched });
    left.replaceChildren(el('div', { class: 'st-form' },
      el('div', { class: 'st-row' }, nameBtn, el('div', { class: 'spacer' }),
        el('button', { class: 'btn small ghost', 'data-testid': 'st-to-chart', title: 'Show the strategy\'s entries, exits, stops and take profits on the chart', onclick: () => {
          addToChart({ id: st.id, name: st.name || 'Unsaved strategy', strategy: ed.get(), size: +size.value || 1000 });
        } }, 'Add to chart')),
      ed.el, syms.el,
      el('div', { class: 'st-row' }, el('label', {}, 'Period'), from, '–', to),
      el('div', { class: 'st-row' }, el('label', {}, 'Size'), size, el('span', { class: 'muted' }, 'per trade (quote currency)')),
      el('div', { class: 'st-row' }, runBtn, el('button', { class: 'btn small ghost', 'data-testid': 'st-to-paper', onclick: () => {
        paperDialog({ name: st.name || '', strategy: ed.get(), symbols: syms.get(), size: +size.value || 1000, channels: [], active: true });
      } }, 'Paper trade this…'))));
    renderHead();
  };
  left.addEventListener('input', touched);
  left.addEventListener('change', touched);
  const loadStrategies = async () => { try { strategies = (await api.strategies()).strategies; } catch { strategies = []; } };
  const open = (sc) => {
    st = { id: sc.id, name: sc.name, spec: JSON.parse(JSON.stringify(sc.spec)) };
    from.value = utcDate(Date.now() / 1000 - (sc.spec.days || 365) * 86400); to.value = utcDate(Date.now() / 1000);
    size.value = sc.spec.size || 1000;
    build(st.spec);
    saved = JSON.stringify(collect());
    remember();
  };
  const save = async (asNew = false) => {
    let name = st.name;
    if (asNew || !st.id) {
      name = await promptDialog(asNew ? 'Save strategy as' : 'Save strategy', asNew ? `${st.name} copy` : st.name || 'My strategy');
      if (!name) return false;
    }
    try {
      const spec = collect();
      const { strategy } = await api.saveStrategy({ id: asNew ? null : st.id, name, spec });
      st = { ...st, id: strategy.id, name: strategy.name, spec };
      saved = JSON.stringify(spec);
      if (chartStrat && chartStrat.id === strategy.id) {   // the chart follows the saved strategy
        chartStrat = { ...chartStrat, name: strategy.name, strategy: spec.strategy, size: spec.size };
        saveChartStrat(); runChartStrategy(true);
      }
      remember(); await loadStrategies();
      toast('Strategy saved', 'ok');
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  };
  nameBtn.onclick = async () => {
    await loadStrategies();
    showMenu(nameBtn, [
      ...(strategies.length ? [{ title: 'Saved strategies' }] : []),
      ...strategies.map(sc => ({ label: sc.name, active: sc.id === st.id, testid: 'st-open', onClick: () => open(sc) })),
      { sep: true },
      { label: 'New strategy', testid: 'st-new', onClick: () => {
        st = { id: null, name: '', spec: { strategy: DEFAULT_STRATEGY(), symbols: syms.mode(), size: +size.value || 1000, days: days() } };
        saved = null; build(st.spec); remember();
      } },
      { label: st.id ? 'Save' : 'Save…', testid: 'st-save', onClick: () => save(false) },
      ...(st.id ? [
        { label: 'Save as…', testid: 'st-saveas', onClick: () => save(true) },
        { label: 'Rename…', testid: 'st-rename', onClick: async () => {
          const n = await promptDialog('Rename strategy', st.name); if (!n) return;
          const cur = strategies.find(x => x.id === st.id);
          try {
            await api.saveStrategy({ id: st.id, name: n, spec: cur ? cur.spec : collect() });
            st.name = n; remember(); await loadStrategies();
            if (chartStrat?.id === st.id) { chartStrat.name = n; saveChartStrat(); app.renderLegend?.(); }
          } catch (e) { toast(e.message, 'error'); }
        } },
        { label: 'Delete', testid: 'st-delete', onClick: async () => {
          if (!(await confirmDialog(`Delete the strategy "${st.name}"?`, { ok: 'Delete', danger: true }))) return;
          await api.deleteStrategy(st.id);
          if (chartStrat?.id === st.id) { chartStrat.id = null; saveChartStrat(); }
          st = { ...st, id: null, name: '' }; saved = null; remember(); await loadStrategies();
        } },
      ] : []),
    ]);
  };
  const showResult = (r, strategy, opts = {}) => {
    report?.destroy();
    report = resultsView(r, { strategy, size: opts.size || +size.value || 1000, title: opts.title || st.name || '' });
    right.replaceChildren(report.el);
  };
  runBtn.onclick = async () => {
    remember();
    const strategy = ed.get();
    const symbols = syms.get();
    if (!symbols.length) return toast('No symbols to test (add symbols, run the screener first, or pick a watchlist)', 'error');
    const start = Date.parse(from.value + 'T00:00:00Z') / 1000, end = Date.parse(to.value + 'T23:59:59Z') / 1000;
    runBtn.disabled = true;
    report?.destroy(); report = null;
    right.replaceChildren(el('div', { class: 'bp-empty' }, `Running on ${symbols.length} symbol${symbols.length > 1 ? 's' : ''}…`));
    try {
      const r = await api.backtest({ source: app.symbolSource(symbols[0]) || meta.sources[0]?.prefix, strategy, symbols, start, end, size: +size.value || 1000 });
      showResult(r, strategy);
    } catch (e) { right.replaceChildren(el('div', { class: 'bp-empty' }, e.message)); }
    finally { runBtn.disabled = false; }
  };
  root.append(el('div', { class: 'bp-split' }, left, right));
  build(st.spec);
  loadStrategies().then(() => {
    const sc = st.id && strategies.find(x => x.id === st.id);
    if (sc) saved = JSON.stringify({ ...sc.spec });
    if (sc && JSON.stringify(collect()) !== saved) { // compare through the form (number formats, default parameters)
      const cur = JSON.stringify(collect());
      const keep = { from: from.value, to: to.value };
      build(sc.spec); size.value = sc.spec.size || 1000;
      saved = JSON.stringify(collect());
      build(JSON.parse(cur)); from.value = keep.from; to.value = keep.to; size.value = JSON.parse(cur).size;
    }
    renderHead();
  });
  return { el: root, showResult,
    edit: (s) => {   // from the chart legend: the strategy shown on the chart
      const sc = s.id && strategies.find(x => x.id === s.id);
      if (sc) open(sc);
      else { st = { id: null, name: s.name, spec: { strategy: s.strategy, symbols: { mode: 'current', list: [] }, size: s.size, days: days() } }; saved = null; build(st.spec); remember(); }
    },
    show: async () => {
      const spec = collect();
      try { screens = (await api.screens()).screens; } catch { screens = []; }
      build(spec);   // saved screens for "Load entry from a saved screen", current watchlists
    } };
}

// ======================================================================= paper trading tab
function paperDialog(p, onSaved) {
  const isNew = !p.id;
  const name = el('input', { value: p.name || '', placeholder: 'e.g. RSI bounce 15m', 'data-testid': 'pp-name', style: { width: '100%' } });
  const edBox = el('div');
  let ed = strategyEditor(p.strategy);
  edBox.append(ed.el);
  let strategies = [];
  const fromSaved = el('select', { 'data-testid': 'pp-from-strategy', onchange: (e) => {
    const sc = strategies.find(x => x.id === e.target.value); e.target.value = '';
    if (!sc) return;
    ed = strategyEditor(sc.spec.strategy); edBox.replaceChildren(ed.el);
    if (!name.value) name.value = sc.name;
    size.value = sc.spec.size || size.value;
  } }, el('option', { value: '' }, 'Load a saved strategy…'));
  Promise.all([api.screens().catch(() => ({ screens: [] })), api.strategies().catch(() => ({ strategies: [] }))]).then(([a, b]) => {
    strategies = b.strategies;
    fromSaved.append(...strategies.map(s => el('option', { value: s.id }, s.name)));
    const cur = ed.get(); ed = strategyEditor(cur, { screens: a.screens }); edBox.replaceChildren(ed.el);
  });
  const syms = symbolPicker({ mode: 'list', list: p.symbols || [] }, { modes: false, testid: 'pp' });
  const size = el('input', { class: 'st-num', type: 'number', min: 1, value: p.size || 1000 });
  const allowed = S.plan?.limits?.alert_channels || Object.keys(CHANNELS);
  const chans = Object.keys(CHANNELS).filter(c => c !== 'app').map(c => el('label', { style: { display: 'inline-flex', gap: '4px', marginRight: '10px' } },
    el('input', { type: 'checkbox', value: c, checked: (p.channels || []).includes(c), disabled: !allowed.includes(c) }), CHANNELS[c]));
  const active = el('input', { type: 'checkbox', checked: p.active !== false });
  const m = modal({ title: isNew ? 'New paper-trading strategy' : `Edit: ${p.name}`, width: '720px',
    body: el('div', { class: 'st-form' },
      el('div', { class: 'st-row' }, el('label', {}, 'Name'), name),
      el('div', { class: 'st-row' }, el('label', {}, 'Strategy'), fromSaved),
      edBox,
      el('div', { class: 'st-row' }, el('label', {}, 'Symbols')), syms.el,
      el('div', { class: 'st-row' }, el('label', {}, 'Size'), size, el('span', { class: 'muted' }, 'per trade (quote currency)')),
      el('div', { class: 'st-row' }, el('label', {}, 'Notify'), el('div', {}, chans, el('span', { class: 'muted' }, 'on entries and exits'))),
      el('div', { class: 'st-row' }, el('label', {}, 'Running'), active),
      isNew ? null : el('div', { class: 'help' }, 'Changing the strategy, the symbols or the size starts a new run; the trades of earlier runs are kept.'),
      el('div', { class: 'help' }, 'Trades start with the first bar that closes after saving. Bars come from ClickHouse (the recent 1m table) and the exchange; positions are simulated with the backtest rules.')),
    footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', 'data-testid': 'pp-save', onclick: async () => {
        const symbols = syms.get();
        const prefix = app.symbolSource(symbols[0] || S.symbol) || meta.sources[0]?.prefix;
        try {
          await api.savePaper({ id: p.id, name: name.value, source: prefix, strategy: ed.get(), symbols, size: +size.value || 1000,
            channels: chans.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value), active: active.checked });
          m.close();
          toast('Paper-trading strategy saved', 'ok');
          onSaved?.();
          if (!onSaved) openPanel('paper');
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Save')] });
}

function paperView() {
  const root = el('div', { class: 'bp-body', 'data-testid': 'paper' });
  let papers = [], sel = null, timer = null, paperReport = null, detailKey = null;
  const list = el('div', { class: 'bp-scroll', style: { flex: '0 1 auto', maxHeight: '50%' } });
  const detail = el('div', { class: 'bp-scroll' });
  const refresh = async () => {
    try { papers = (await api.papers()).papers; } catch (e) { list.replaceChildren(el('div', { class: 'bp-empty' }, e.message)); return; }
    renderList();
    if (sel) { const p = papers.find(x => x.id === sel); if (p) renderDetail(p); else { sel = null; detail.replaceChildren(); } }
  };
  const act = (title, html, fn, testid) => el('button', { title, html, 'data-testid': testid, onclick: (e) => { e.stopPropagation(); fn(); } });
  const renderList = () => {
    if (!papers.length) { list.replaceChildren(el('div', { class: 'bp-empty' }, 'No paper-trading strategies yet. Create one here or from the Strategy Tester ("Paper trade this…").')); return; }
    const tb = el('tbody');
    for (const p of papers) {
      const s = p.summary;
      tb.append(el('tr', { class: p.id === sel ? 'sel' : '', 'data-paper': p.id, onclick: () => { sel = p.id; renderList(); renderDetail(p); } },
        el('td', {}, p.name), el('td', {}, p.strategy.tf), el('td', {}, p.symbols.length),
        el('td', {}, el('span', { class: `pill ${p.active ? 'on' : ''}` }, p.active ? 'running' : 'paused')),
        el('td', {}, s.trades), el('td', { class: cls(s.net) }, fmtMoney(s.net)), el('td', {}, s.win_pct != null ? s.win_pct.toFixed(1) + '%' : '—'),
        el('td', {}, s.open), el('td', { class: cls(s.upnl) }, s.open ? fmtMoney(s.upnl) : '—'), el('td', {}, `#${p.run} · ${fmtDT(p.started_at)}`),
        el('td', {}, el('span', { class: 'row-acts' },
          act('Edit', ICONS.gear, () => paperDialog(p, refresh), 'pp-edit'),
          act(p.active ? 'Pause' : 'Resume (starts a new run)', p.active ? '❚❚' : '▶', async () => {
            try { await api.savePaper({ ...p, active: !p.active }); refresh(); } catch (e) { toast(e.message, 'error'); }
          }, 'pp-toggle'),
          act('Restart (new run)', ICONS.history, async () => {
            if (!(await confirmDialog(`Start a new run of "${p.name}"? Open positions are dropped; earlier trades are kept.`, { ok: 'Restart' }))) return;
            await api.resetPaper(p.id); refresh();
          }, 'pp-reset'),
          act('Delete', ICONS.close, async () => {
            if (!(await confirmDialog(`Delete "${p.name}" and its trades?`, { ok: 'Delete', danger: true }))) return;
            await api.deletePaper(p.id); if (sel === p.id) { sel = null; detail.replaceChildren(); clearTrades(); } refresh();
          }, 'pp-delete')))));
    }
    list.replaceChildren(el('table', { class: 'sc-table', 'data-testid': 'pp-table' },
      el('thead', {}, el('tr', {}, ['Name', 'TF', 'Symbols', 'Status', 'Trades', 'Net', 'Win %', 'Open', 'Unrealized', 'Run', ''].map(h => el('th', {}, h)))), tb));
  };
  const renderDetail = async (p) => {
    const opens = Object.entries(p.state).filter(([, v]) => v.open).map(([sym, v]) => ({ sym, ...v.open, last: v.last_close }));
    const otb = el('tbody');
    for (const o of opens) {
      otb.append(el('tr', { onclick: () => showTrades(o.sym, p.strategy.tf, [], o) },
        el('td', {}, app.symbolName(o.sym)), el('td', { class: 'l' }, o.side > 0 ? 'Long' : 'Short'), el('td', {}, fmtDT(o.entry_ts)), el('td', {}, fmtVal(o.entry_px)),
        el('td', {}, fmtVal(o.last)), el('td', {}, fmtVal(o.stop)), el('td', {}, fmtVal(o.tp)), el('td', { class: cls(o.upnl) }, fmtMoney(o.upnl))));
    }
    let trades = [];
    try { trades = (await api.paperTrades(p.id, p.run)).trades; } catch { /* */ }
    const bySym = new Map();
    for (const t of trades) {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
      bySym.get(t.symbol).push({ side: t.side, entry_ts: t.entry_time, exit_ts: t.exit_time, entry_px: t.entry_price, exit_px: t.exit_price, net: t.net,
        reason: t.reason || ((t.exit_price - t.entry_price) * t.side < 0 ? 'sl' : 'tp'), stop: t.stop ?? null, tp: t.tp ?? null });
    }
    const r = { symbols: [...bySym.entries()].map(([symbol, tl]) => {
      tl.sort((a, b) => a.entry_ts - b.entry_ts);
      const n = tl.reduce((x, t) => x + t.net, 0), w = tl.filter(t => t.net > 0).length;
      const gp = tl.filter(t => t.net > 0).reduce((x, t) => x + t.net, 0), gl = -tl.filter(t => t.net <= 0).reduce((x, t) => x + t.net, 0);
      return { symbol, trades: tl, metrics: { trades: tl.length, net: n, win_pct: w / tl.length * 100, profit_factor: gl > 0 ? gp / gl : null } };
    }), total: null };
    const waiting = Object.values(p.state).filter(v => v.status && v.status !== 'ok').length;
    const key = `${p.id}|${p.updated_ms}|${trades.length}`;
    if (key === detailKey && detail.childElementCount) return;   // the 30 s refresh: nothing new
    detailKey = key;
    paperReport?.destroy();
    paperReport = trades.length ? resultsView(r, { strategy: p.strategy, size: p.size, title: `${p.name} · run #${p.run}`, testid: 'pp' }) : null;
    detail.replaceChildren(
      el('div', { class: 'help', style: { padding: '6px 8px', margin: 0 } }, `${p.name}: ${strategySummary(p.strategy)} · ${p.strategy.tf} · size ${p.size}` + (waiting ? ` · ${waiting} symbols waiting for data` : '')),
      el('div', { class: 'sub-head' }, `Open positions (${opens.length})`),
      opens.length ? el('table', { class: 'sc-table', 'data-testid': 'pp-open' }, el('thead', {}, el('tr', {}, ['Symbol', 'Side', 'Entry', 'Price', 'Last', 'Stop', 'TP', 'Unrealized'].map(h => el('th', {}, h)))), otb)
        : el('div', { class: 'bp-empty', style: { padding: '8px' } }, 'No open position.'),
      el('div', { class: 'sub-head' }, `Closed trades of run #${p.run} (${trades.length})`),
      paperReport ? paperReport.el : el('div', { class: 'bp-empty', style: { padding: '8px' } }, 'No closed trade yet.'));
  };
  root.append(el('div', { class: 'bp-bar' }, el('button', { class: 'btn small primary', 'data-testid': 'pp-new', onclick: () => paperDialog({ strategy: null, symbols: [S.symbol], channels: [] }, refresh) }, '+ New strategy'),
    el('button', { class: 'btn small ghost', title: 'Refresh', onclick: refresh }, '↻'), el('div', { class: 'spacer' }),
    el('span', { class: 'bp-status' }, 'Runs on the server on every closed bar, also when the browser is closed.')), list, detail);
  return { el: root, show: () => {
    refresh();
    clearInterval(timer);
    timer = setInterval(() => { if (panelTab === 'paper' && !document.hidden) refresh(); }, 30000);
  } };
}
