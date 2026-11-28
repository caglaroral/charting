// Bottom panel: Screener (saved screens + screener alerts), Strategy Tester (backtests) and Paper Trading.
// Everything is computed by the backtester service through the backend (/api/screener, /api/backtest,
// /api/papers). Conditions use the backtest engine's format:
//   operand  {ind, p, f, tf, sh} | {px, tf, sh} | {const}      (tf '' = the screen's / strategy's timeframe)
//   cond     {a, op: '<' | '>' | 'xup' | 'xdn', b}
//   strategy {tf, long: {entry: [cond], stop, tp} | null, short: ...}, exit = {k: 'pct', v} | {k: 'atr', m, p} | null
import { api } from './api.js';
import { el, $, toast, showMenu, modal, confirmDialog, promptDialog, ICONS } from './ui.js';

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
const cls = (v) => (v == null ? '' : v >= 0 ? 'up' : 'down');
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

function strategyEditor(st, { screens = [] } = {}) {
  const s = JSON.parse(JSON.stringify(st || { tf: '1h', long: { entry: [], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } }, short: null }));
  const box = el('div', { class: 'st-form' });
  const tf = el('select', { 'data-testid': 'st-tf' }, meta.timeframes.map(t => el('option', { value: t, selected: t === s.tf }, t)));
  const sides = {};
  const sideBox = (side) => {
    const on = !!s[side];
    const sd = s[side] || { entry: [], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } };
    const chips = condChips(sd.entry, () => {}, { addLabel: '+ Entry condition', testid: `${side}-entry` });
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

// ======================================================================= trade markers on the chart
let shown = null;      // {symbol, tf, trades, open}
let markerApi = null, markerSeries = null;
function applyMarkers() {
  if (!app.mainSeries) return;
  const want = shown && shown.symbol === S.symbol && shown.tf === S.tf;
  const off = S.tzOffset || 0;
  const list = [];
  if (want) {
    for (const t of shown.trades) {
      const long = t.side > 0;
      list.push({ time: t.entry_ts + off, position: long ? 'belowBar' : 'aboveBar', color: long ? '#089981' : '#f23645', shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'Long' : 'Short' });
      if (t.exit_ts != null) list.push({ time: t.exit_ts + off, position: long ? 'aboveBar' : 'belowBar', color: t.net >= 0 ? '#26a69a' : '#ef5350', shape: 'circle', text: fmtMoney(t.net) });
    }
    if (shown.open) {
      const long = shown.open.side > 0;
      list.push({ time: shown.open.entry_ts + off, position: long ? 'belowBar' : 'aboveBar', color: '#2962ff', shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'Long' : 'Short'} (open)` });
    }
    list.sort((a, b) => a.time - b.time);
  }
  if (markerSeries !== app.mainSeries) { markerApi = null; markerSeries = app.mainSeries; }
  if (!markerApi) {
    if (!list.length) return;
    markerApi = LightweightCharts.createSeriesMarkers(app.mainSeries, list);
  } else markerApi.setMarkers(list);
}
async function showTrades(symbol, tf, trades, open = null) {
  shown = { symbol, tf, trades, open };
  if (S.symbol !== symbol || S.tf !== tf) await app.setSymbol(symbol, { tf });
  applyMarkers();
}
function clearTrades() { shown = null; applyMarkers(); }
async function focusTrade(t) {
  if (!shown) return;
  const off = S.tzOffset || 0;
  const err = await app.goTo(t.entry_ts + off, t.exit_ts != null ? t.exit_ts + off : null);
  if (err) toast(err, 'error');
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

// ======================================================================= panel shell
let panelTab = null;
const TABS = [['screener', 'Screener'], ['tester', 'Strategy Tester'], ['paper', 'Paper Trading']];
const views = {};

export function initScreener(a) {
  app = a; S = a.S;
  const tg = $('#bp-toggles');
  for (const [id, label] of TABS) tg.append(el('button', { class: 'bb-btn', 'data-bp': id, 'data-testid': `bp-${id}`, onclick: () => openPanel(panelTab === id ? null : id) }, label));
  app.openBottomPanel = openPanel;
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
  let cur = ls.get('sc.cur', null) || { id: null, name: '', spec: newSpec() };
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
  const persist = () => ls.set('sc.cur', cur);
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
  return { el: root, show: () => {
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

// ======================================================================= strategy tester tab
function symbolsPicker(initial) {
  const box = el('div', { class: 'st-row' });
  const sel = el('select', { 'data-testid': 'st-symbols' });
  const custom = el('input', { placeholder: 'BTCUSDT, ETHUSDT …', style: { flex: 1, minWidth: '160px' }, value: initial?.custom || '', 'data-testid': 'st-symbols-custom' });
  const render = () => {
    const v = sel.value || initial?.mode || 'current';
    sel.replaceChildren(el('option', { value: 'current' }, 'Current symbol'), el('option', { value: 'screen' }, 'Screener results'),
      ...(S.watchlists || []).map(w => el('option', { value: 'wl:' + w.id }, `Watchlist: ${w.name}`)), el('option', { value: 'custom' }, 'Symbols…'));
    sel.value = v;
    custom.hidden = sel.value !== 'custom';
  };
  sel.onchange = () => { custom.hidden = sel.value !== 'custom'; };
  render();
  box.append(el('label', {}, 'Symbols'), sel, custom);
  return { el: box, render, get: () => {
    const v = sel.value;
    if (v === 'current') return [S.symbol];
    if (v === 'screen') return lastResults || [];
    if (v.startsWith('wl:')) return (S.watchlists.find(w => w.id === v.slice(3))?.symbols || []).slice();
    const prefix = app.symbolSource(S.symbol) || meta.sources[0]?.prefix;
    return custom.value.split(/[\s,;]+/).filter(Boolean).map(x => (x.includes(':') ? x : `${prefix}:${x}`).toUpperCase());
  }, mode: () => ({ mode: sel.value, custom: custom.value }) };
}

function testerView() {
  const root = el('div', { class: 'bp-body', 'data-testid': 'tester' });
  const state = ls.get('st.form', null);
  let screens = [];
  const left = el('div');
  const right = el('div', { 'data-testid': 'st-results' }, el('div', { class: 'bp-empty' }, 'Set up a strategy and run a backtest. Signals at a bar\'s close fill at the next open; one position per symbol; fees 0.05% and slippage 0.02% per side (stops 0.08% more).'));
  let ed, syms;
  const from = el('input', { type: 'date', value: state?.from || utcDate(Date.now() / 1000 - 365 * 86400), 'data-testid': 'st-from' });
  const to = el('input', { type: 'date', value: state?.to || utcDate(Date.now() / 1000), 'data-testid': 'st-to' });
  const size = el('input', { class: 'st-num', type: 'number', min: 1, value: state?.size || 1000 });
  const runBtn = el('button', { class: 'btn primary small', 'data-testid': 'st-run' }, 'Run backtest');
  const build = (st, sm) => {
    ed = strategyEditor(st, { screens });
    syms = symbolsPicker(sm);
    left.replaceChildren(el('div', { class: 'st-form' }, ed.el, syms.el,
      el('div', { class: 'st-row' }, el('label', {}, 'Period'), from, '–', to),
      el('div', { class: 'st-row' }, el('label', {}, 'Size'), size, el('span', { class: 'muted' }, 'per trade (quote currency)')),
      el('div', { class: 'st-row' }, runBtn, el('button', { class: 'btn small ghost', 'data-testid': 'st-to-paper', onclick: () => {
        paperDialog({ name: '', strategy: ed.get(), symbols: syms.get(), size: +size.value || 1000, channels: [], active: true });
      } }, 'Paper trade this…'))));
  };
  const remember = () => ls.set('st.form', { strategy: ed.get(), symbols: syms.mode(), from: from.value, to: to.value, size: +size.value || 1000 });
  runBtn.onclick = async () => {
    remember();
    const strategy = ed.get();
    const symbols = syms.get();
    if (!symbols.length) return toast('No symbols to test (run the screener first, or pick a watchlist)', 'error');
    const start = Date.parse(from.value + 'T00:00:00Z') / 1000, end = Date.parse(to.value + 'T23:59:59Z') / 1000;
    runBtn.disabled = true;
    right.replaceChildren(el('div', { class: 'bp-empty' }, `Running on ${symbols.length} symbol${symbols.length > 1 ? 's' : ''}…`));
    try {
      const r = await api.backtest({ source: app.symbolSource(symbols[0]) || meta.sources[0]?.prefix, strategy, symbols, start, end, size: +size.value || 1000 });
      renderResults(r, strategy);
    } catch (e) { right.replaceChildren(el('div', { class: 'bp-empty' }, e.message)); }
    finally { runBtn.disabled = false; }
  };
  const renderResults = (r, strategy) => {
    const t = r.total || {};
    const card = (label, v, c = '') => el('div', { class: 'card' }, el('b', { class: c }, v), el('small', {}, label));
    const tradesBox = el('div');
    const tb = el('tbody');
    for (const s of r.symbols) {
      const m = s.metrics || {};
      tb.append(el('tr', { 'data-sym': s.symbol, onclick: async () => {
        for (const x of tb.children) x.classList.toggle('sel', x === tbRow);
        if (s.skipped) return;
        await showTrades(s.symbol, strategy.tf, s.trades);
        tradesBox.replaceChildren(el('div', { class: 'sub-head' }, `${app.symbolName(s.symbol)} · ${s.trades.length} trades (click one to see it on the chart)`, el('div', { class: 'spacer' }),
          el('button', { class: 'btn small ghost', onclick: () => { clearTrades(); tradesBox.replaceChildren(); } }, 'Hide on chart')),
        tradesTable(s.trades.slice().reverse(), { onPick: focusTrade }));
      } }, el('td', {}, app.symbolName(s.symbol)),
      ...(s.skipped ? [el('td', { colspan: 6, class: 'l muted' }, s.skipped)] : [
        el('td', {}, m.trades ?? 0), el('td', { class: cls(m.net) }, fmtMoney(m.net)), el('td', {}, m.win_pct != null ? m.win_pct.toFixed(1) + '%' : '—'),
        el('td', {}, m.profit_factor != null ? m.profit_factor.toFixed(2) : '—'), el('td', {}, m.max_dd_pct != null ? m.max_dd_pct.toFixed(1) + '%' : '—'),
        el('td', {}, m.sharpe != null ? m.sharpe.toFixed(2) : '—')])));
      const tbRow = tb.lastChild;
    }
    right.replaceChildren(
      el('div', { class: 'cards', 'data-testid': 'st-total' },
        card('Net', fmtMoney(t.net ?? 0), cls(t.net)), card('Trades', t.trades ?? 0), card('Win rate', t.win_pct != null ? t.win_pct.toFixed(1) + '%' : '—'),
        card('Profit factor', t.profit_factor != null ? t.profit_factor.toFixed(2) : '—'), card('Max drawdown', t.max_dd_pct != null ? t.max_dd_pct.toFixed(1) + '%' : '—'),
        card('Sharpe', t.sharpe != null ? t.sharpe.toFixed(2) : '—'), card('Exposure', t.exposure_pct != null ? t.exposure_pct.toFixed(1) + '%' : '—')),
      el('div', { class: 'help', style: { padding: '0 8px' } }, `${strategySummary(strategy)} · ${strategy.tf} · ${(r.ms / 1000).toFixed(1)}s`),
      el('table', { class: 'sc-table', 'data-testid': 'st-table' }, el('thead', {}, el('tr', {}, ['Symbol', 'Trades', 'Net', 'Win %', 'PF', 'Max DD', 'Sharpe'].map(h => el('th', {}, h)))), tb),
      tradesBox);
  };
  root.append(el('div', { class: 'bp-split' }, left, right));
  build(state?.strategy, state?.symbols);
  return { el: root, show: async () => {
    const st = ed.get(), sm = syms.mode();
    try { screens = (await api.screens()).screens; } catch { screens = []; }
    build(st, sm);   // saved screens for "Load entry from a saved screen", current watchlists
  } };
}

// ======================================================================= paper trading tab
function paperDialog(p, onSaved) {
  const isNew = !p.id;
  let screens = [];
  const name = el('input', { value: p.name || '', placeholder: 'e.g. RSI bounce 15m', 'data-testid': 'pp-name', style: { width: '100%' } });
  const edBox = el('div');
  let ed = strategyEditor(p.strategy);
  edBox.append(ed.el);
  api.screens().then(r => { screens = r.screens; const cur = ed.get(); ed = strategyEditor(cur, { screens }); edBox.replaceChildren(ed.el); }).catch(() => {});
  const symsIn = el('textarea', { rows: 2, style: { width: '100%' }, 'data-testid': 'pp-symbols' });
  symsIn.value = (p.symbols || []).map(s => app.symbolName(s)).join(', ');   // a textarea's value is not an attribute
  const fill = el('select', { onchange: (e) => {
    const v = e.target.value; e.target.value = '';
    const list = v === 'current' ? [S.symbol] : v === 'screen' ? (lastResults || []) : v.startsWith('wl:') ? (S.watchlists.find(w => w.id === v.slice(3))?.symbols || []) : [];
    symsIn.value = list.map(s => app.symbolName(s)).join(', ');
  } }, el('option', { value: '' }, 'Fill from…'), el('option', { value: 'current' }, 'Current symbol'), el('option', { value: 'screen' }, 'Screener results'),
  ...(S.watchlists || []).map(w => el('option', { value: 'wl:' + w.id }, `Watchlist: ${w.name}`)));
  const size = el('input', { class: 'st-num', type: 'number', min: 1, value: p.size || 1000 });
  const allowed = S.plan?.limits?.alert_channels || Object.keys(CHANNELS);
  const chans = Object.keys(CHANNELS).filter(c => c !== 'app').map(c => el('label', { style: { display: 'inline-flex', gap: '4px', marginRight: '10px' } },
    el('input', { type: 'checkbox', value: c, checked: (p.channels || []).includes(c), disabled: !allowed.includes(c) }), CHANNELS[c]));
  const active = el('input', { type: 'checkbox', checked: p.active !== false });
  const m = modal({ title: isNew ? 'New paper-trading strategy' : `Edit: ${p.name}`, width: '720px',
    body: el('div', { class: 'st-form' },
      el('div', { class: 'st-row' }, el('label', {}, 'Name'), name),
      edBox,
      el('div', { class: 'st-row' }, el('label', {}, 'Symbols'), fill), symsIn,
      el('div', { class: 'st-row' }, el('label', {}, 'Size'), size, el('span', { class: 'muted' }, 'per trade (quote currency)')),
      el('div', { class: 'st-row' }, el('label', {}, 'Notify'), el('div', {}, chans, el('span', { class: 'muted' }, 'on entries and exits'))),
      el('div', { class: 'st-row' }, el('label', {}, 'Running'), active),
      isNew ? null : el('div', { class: 'help' }, 'Changing the strategy, the symbols or the size starts a new run; the trades of earlier runs are kept.'),
      el('div', { class: 'help' }, 'Trades start with the first bar that closes after saving. Bars come from ClickHouse (the recent 1m table) and the exchange; positions are simulated with the backtest rules.')),
    footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', 'data-testid': 'pp-save', onclick: async () => {
        const prefix = app.symbolSource(S.symbol) || meta.sources[0]?.prefix;
        const symbols = symsIn.value.split(/[\s,;]+/).filter(Boolean).map(x => (x.includes(':') ? x : `${prefix}:${x}`).toUpperCase());
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
  let papers = [], sel = null, timer = null;
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
    const mapped = trades.map(t => ({ symbol: t.symbol, side: t.side, entry_ts: t.entry_time, exit_ts: t.exit_time, entry_px: t.entry_price, exit_px: t.exit_price, net: t.net }));
    const waiting = Object.values(p.state).filter(v => v.status && v.status !== 'ok').length;
    detail.replaceChildren(
      el('div', { class: 'help', style: { padding: '6px 8px', margin: 0 } }, `${p.name}: ${strategySummary(p.strategy)} · ${p.strategy.tf} · size ${p.size}` + (waiting ? ` · ${waiting} symbols waiting for data` : '')),
      el('div', { class: 'sub-head' }, `Open positions (${opens.length})`),
      opens.length ? el('table', { class: 'sc-table', 'data-testid': 'pp-open' }, el('thead', {}, el('tr', {}, ['Symbol', 'Side', 'Entry', 'Price', 'Last', 'Stop', 'TP', 'Unrealized'].map(h => el('th', {}, h)))), otb)
        : el('div', { class: 'bp-empty', style: { padding: '8px' } }, 'No open position.'),
      el('div', { class: 'sub-head' }, `Closed trades of run #${p.run} (${mapped.length})`),
      mapped.length ? tradesTable(mapped, { onPick: async (t) => {
        const same = mapped.filter(x => x.symbol === t.symbol);
        await showTrades(t.symbol, p.strategy.tf, same);
        focusTrade(t);
      } }) : el('div', { class: 'bp-empty', style: { padding: '8px' } }, 'No closed trade yet.'));
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
