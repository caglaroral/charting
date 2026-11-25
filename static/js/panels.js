// Right panel: watchlists (+ live quotes), symbol info, alerts list and alert notifications.
import { api } from './api.js';
import { el, $, toast, showMenu, fmtNum, ICONS } from './ui.js';
import { miniTickerStream } from './live.js';
import * as dialogs from './dialogs.js';

let app, S;
const COND_TR = {
  crossing: 'crossing', crossing_up: 'crossing up', crossing_down: 'crossing down', greater: 'greater than',
  less: 'less than', entering: 'entering channel', exiting: 'exiting channel', signal: 'signal',
};
export const condText = (c) => COND_TR[c] || c;

export function initPanels(a) {
  app = a; S = a.S;
  S.quotes = {};
  for (const b of document.querySelectorAll('.rp-tab')) {
    b.onclick = () => {
      for (const x of document.querySelectorAll('.rp-tab')) x.classList.toggle('active', x === b);
      $('#tab-watchlist').hidden = b.dataset.tab !== 'watchlist';
      $('#tab-alerts').hidden = b.dataset.tab !== 'alerts';
      if (b.dataset.tab === 'alerts') { unseen = 0; renderBadge(); }
    };
  }
  $('#wl-add').onclick = () => addSymbolsDialog();
  $('#al-new').onclick = () => dialogs.alertDialog(app, { kind: 'price' });
  $('#al-settings').onclick = () => dialogs.notifySettings(app);
  $('#al-log-all').onclick = () => dialogs.alertLog(app);
  $('#al-notify').onclick = async () => {
    if (!('Notification' in window)) return toast('Browser notifications are not supported', 'error');
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'Notifications enabled' : 'Notification permission denied', p === 'granted' ? 'ok' : 'error');
  };
  app.on('symbolChanged', () => { renderWatchlist(); loadSymbolInfo(); syncAlertLines(); });
  app.on('tick', (sym, bar) => {
    const name = app.symbolName(sym);
    const q = S.quotes[sym];
    if (q) { q.last = bar.close; q.chg = q.open != null ? bar.close - q.open : q.chg; if (q.open) q.chgp = (bar.close / q.open - 1) * 100; }
    scheduleQuotes();
    void name;
  });
  app.loadAlerts = loadAlerts;
  app.syncAlertLines = syncAlertLines;
  app.loadWatchlists = loadWatchlists;
  loadWatchlists();
  loadAlerts();
  startQuotes();
  initEvents();
}

// ======================================================================= watchlists
async function loadWatchlists() {
  try {
    S.watchlists = (await api.watchlists()).watchlists;
  } catch (e) { toast('Failed to load watchlists: ' + e.message, 'error'); S.watchlists = []; }
  if (!S.watchlists.find(w => w.id === S.wlId)) S.wlId = S.watchlists[0]?.id || null;
  renderWlHeader();
  renderWatchlist();
  refreshQuotes();
}

const activeWl = () => S.watchlists.find(w => w.id === S.wlId);

async function saveWl(wl) {
  try {
    const { watchlist } = await api.saveWatchlist(wl);
    Object.assign(wl, watchlist);
  } catch (e) { toast('Failed to save watchlist: ' + e.message, 'error'); }
}

function renderWlHeader() {
  const box = $('#wl-select');
  box.innerHTML = '';
  const wl = activeWl();
  const b = el('button', { class: 'tb-btn', id: 'wl-name', style: { fontWeight: 600 } }, wl ? wl.name : 'Watchlist', el('span', { html: ICONS.caret }));
  b.onclick = () => showMenu(b, [
    { title: 'Lists' },
    ...S.watchlists.map(w => ({ label: `${w.name} (${w.symbols.length})`, active: w.id === S.wlId, onClick: () => { S.wlId = w.id; app.saveLayout(); renderWlHeader(); renderWatchlist(); refreshQuotes(); } })),
  ]);
  box.append(b);
  const mb = $('#wl-menu');
  mb.innerHTML = '';
  const m = el('button', { class: 'tb-btn icon', title: 'List actions', 'data-testid': 'wl-menu', html: ICONS.dots });
  m.onclick = () => showMenu(m, [
    { label: 'New list…', testid: 'wl-new', onClick: async () => {
      const name = await dialogs.promptText('New list name', 'List ' + (S.watchlists.length + 1));
      if (!name) return;
      const wl = { name, symbols: [], sort: S.watchlists.length };
      await saveWl(wl);
      S.watchlists.push(wl); S.wlId = wl.id; app.saveLayout(); renderWlHeader(); renderWatchlist();
    } },
    { label: 'Rename…', onClick: async () => {
      const wl = activeWl(); if (!wl) return;
      const name = await dialogs.promptText('List name', wl.name);
      if (!name) return;
      wl.name = name; await saveWl(wl); renderWlHeader();
    } },
    { label: 'Add current symbol', onClick: () => addToWatchlist(S.symbol) },
    { label: 'Sort A→Z', onClick: async () => { const wl = activeWl(); if (!wl) return; wl.symbols.sort(); await saveWl(wl); renderWatchlist(); } },
    { sep: true },
    { label: 'Delete list', testid: 'wl-delete', onClick: async () => {
      const wl = activeWl(); if (!wl) return;
      if (!(await dialogs.confirm(`Delete list "${wl.name}"?`, { ok: 'Delete', danger: true }))) return;
      await api.deleteWatchlist(wl.id);
      S.watchlists = S.watchlists.filter(w => w !== wl);
      S.wlId = S.watchlists[0]?.id || null;
      if (!S.wlId) await loadWatchlists(); else { renderWlHeader(); renderWatchlist(); }
      app.saveLayout();
    } },
  ], { align: 'right' });
  mb.append(m);
}

export async function addToWatchlist(sym) {
  const wl = activeWl();
  if (!wl || !sym || wl.symbols.includes(sym)) return;
  wl.symbols.push(sym);
  renderWatchlist();
  await saveWl(wl);
  refreshQuotes();
}

async function removeFromWatchlist(sym) {
  const wl = activeWl();
  if (!wl) return;
  wl.symbols = wl.symbols.filter(s => s !== sym);
  renderWatchlist();
  await saveWl(wl);
}

function addSymbolsDialog() {
  const wl = activeWl();
  if (!wl) return;
  dialogs.symbolSearch(app, {
    title: `Add to "${wl.name}"`, multi: true,
    isChecked: (s) => wl.symbols.includes(s),
    onPick: async (s) => { if (wl.symbols.includes(s)) await removeFromWatchlist(s); else await addToWatchlist(s); },
  });
}

let dragSym = null;
function renderWatchlist() {
  const list = $('#wl-list');
  list.innerHTML = '';
  const wl = activeWl();
  if (!wl || !wl.symbols.length) {
    list.append(el('div', { class: 'wl-empty' }, 'The list is empty. ', el('a', { href: '#', onclick: (e) => { e.preventDefault(); addSymbolsDialog(); } }, 'Add symbols')));
    return;
  }
  const multiSrc = Object.keys(S.sources || {}).length > 1;
  for (const sym of wl.symbols) {
    const q = S.quotes[sym] || {};
    const cls = q.chg > 0 ? 'up' : q.chg < 0 ? 'down' : '';
    const row = el('div', {
      class: `wl-row ${sym === S.symbol ? 'active' : ''}`, draggable: 'true', 'data-sym': sym, title: sym,
      onclick: () => app.setSymbol(sym),
      ondragstart: (e) => { dragSym = sym; e.dataTransfer.effectAllowed = 'move'; },
      ondragover: (e) => { e.preventDefault(); row.classList.add('drag-over'); },
      ondragleave: () => row.classList.remove('drag-over'),
      ondrop: async (e) => {
        e.preventDefault(); row.classList.remove('drag-over');
        if (!dragSym || dragSym === sym) return;
        const arr = wl.symbols.filter(s => s !== dragSym);
        arr.splice(arr.indexOf(sym), 0, dragSym);
        wl.symbols = arr; dragSym = null;
        renderWatchlist(); await saveWl(wl);
      },
    },
    el('span', { class: 'wl-sym' }, app.symbolName(sym), multiSrc ? el('span', { class: 'wl-src' }, app.symbolSource(sym)) : null),
    el('span', { class: 'wl-last' }, q.last != null ? fmtQuote(q.last) : '—'),
    el('span', { class: `wl-chg ${cls}` }, q.chg != null ? fmtQuote(q.chg, q.last) : ''),
    el('span', { class: `wl-chgp ${cls}` }, q.chgp != null ? `${q.chgp >= 0 ? '+' : ''}${q.chgp.toFixed(2)}%` : ''),
    el('button', { class: 'wl-del', title: 'Remove from list', 'data-testid': 'wl-remove', onclick: (e) => { e.stopPropagation(); removeFromWatchlist(sym); } }, '×'));
    list.append(row);
  }
}

function fmtQuote(v, ref = v) {
  const a = Math.abs(ref || v);
  const d = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 7;
  return Number(v).toFixed(d);
}

// Update only the numeric cells (keeps hover/drag state)
function updateQuoteCells() {
  for (const row of document.querySelectorAll('.wl-row')) {
    const q = S.quotes[row.dataset.sym];
    if (!q) continue;
    const cls = q.chg > 0 ? 'up' : q.chg < 0 ? 'down' : '';
    row.querySelector('.wl-last').textContent = q.last != null ? fmtQuote(q.last) : '—';
    const c = row.querySelector('.wl-chg'), p = row.querySelector('.wl-chgp');
    c.textContent = q.chg != null ? fmtQuote(q.chg, q.last) : '';
    p.textContent = q.chgp != null ? `${q.chgp >= 0 ? '+' : ''}${q.chgp.toFixed(2)}%` : '';
    c.className = `wl-chg ${cls}`; p.className = `wl-chgp ${cls}`;
  }
  renderSymbolPrice();
}

let quoteTimer = null;
function scheduleQuotes() {
  if (quoteTimer) return;
  quoteTimer = setTimeout(() => { quoteTimer = null; updateQuoteCells(); }, 500);
}

// Live sources: one all-market mini ticker websocket per provider. Others: poll ClickHouse.
const tickerStreams = {};
function startQuotes() {
  for (const src of Object.values(S.sources || {})) {
    if (!src.live || tickerStreams[src.live]) continue;
    const prefixes = Object.values(S.sources).filter(x => x.live === src.live).map(x => x.prefix);
    tickerStreams[src.live] = miniTickerStream(src.live, (tickers) => {
      for (const [name, q] of Object.entries(tickers)) {
        for (const p of prefixes) {
          const key = `${p}:${name}`;
          if (S.symMap.has(key)) S.quotes[key] = q;
        }
      }
      scheduleQuotes();
    });
  }
  setInterval(refreshQuotes, 30000);
}

async function refreshQuotes() {
  const wl = activeWl();
  const syms = new Set(wl ? wl.symbols : []);
  if (S.symbol) syms.add(S.symbol);
  const need = [...syms].filter(s => !S.sources?.[app.symbolSource(s)]?.live);
  if (!need.length) return;
  try {
    const { quotes } = await api.quotes(need);
    Object.assign(S.quotes, quotes);
    scheduleQuotes();
  } catch (e) { console.warn('quotes', e); }
}

// ======================================================================= symbol info
let infoToken = 0;
async function loadSymbolInfo() {
  const box = $('#symbol-info');
  const sym = S.symbol;
  const t = ++infoToken;
  box.innerHTML = '';
  box.append(el('div', { class: 'si-name' }, app.symbolName(sym)),
    el('div', { class: 'si-src' }, `${S.symMap.get(sym)?.source || ''} · ${S.sources?.[app.symbolSource(sym)]?.name || ''}`),
    el('div', { class: 'si-price', id: 'si-price' }, '—'), el('div', { class: 'si-chg', id: 'si-chg' }));
  renderSymbolPrice();
  let info = {};
  try { info = await api.symbolInfo(sym); } catch { /* no history */ }
  if (t !== infoToken) return;
  const grid = el('div', { class: 'si-grid' },
    el('div', {}, el('b', {}, 'Volume (24h)'), info.vol24 != null ? fmtNum(info.vol24) : '—'),
    el('div', {}, el('b', {}, 'Avg volume (30D)'), info.avg_vol30 != null ? fmtNum(info.avg_vol30) : '—'),
    el('div', {}, el('b', {}, '52W high'), info.high52 != null ? fmtQuote(info.high52) : '—'),
    el('div', {}, el('b', {}, '52W low'), info.low52 != null ? fmtQuote(info.low52) : '—'),
    el('div', {}, el('b', {}, 'ClickHouse history'), info.first ? new Date(info.first * 1000).toLocaleDateString('en-GB') : 'none'),
    el('div', {}, el('b', {}, 'Timeframes'), (info.timeframes || []).length ? `${info.timeframes.length}` : '—'));
  box.append(grid);
  if (info.perf) {
    const pg = el('div', { class: 'perf-grid' });
    for (const k of ['1W', '1M', '3M', '6M', 'YTD', '1Y']) {
      const v = info.perf[k];
      pg.append(el('div', { class: `perf-cell ${v == null ? '' : v >= 0 ? 'up' : 'down'}` }, v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`, el('small', {}, k)));
    }
    box.append(el('div', { class: 'help', style: { marginTop: '12px', marginBottom: 0 } }, 'Performance (ClickHouse daily closes)'), pg);
  }
  if (!S.quotes[sym] && info.last != null) S.quotes[sym] = { last: info.last, chg: info.chg, chgp: info.chgp };
  renderSymbolPrice();
}

function renderSymbolPrice() {
  const q = S.quotes[S.symbol];
  const p = $('#si-price'), c = $('#si-chg');
  if (!p || !q) return;
  p.textContent = q.last != null ? fmtQuote(q.last) : '—';
  p.className = 'si-price ' + (q.chg >= 0 ? 'up' : 'down');
  c.textContent = q.chg != null ? `${q.chg >= 0 ? '+' : ''}${fmtQuote(q.chg, q.last)}  ${q.chgp >= 0 ? '+' : ''}${(q.chgp || 0).toFixed(2)}% (24h)` : '';
  c.className = 'si-chg ' + (q.chg >= 0 ? 'up' : 'down');
}

// ======================================================================= alerts
async function loadAlerts() {
  try { S.alerts = (await api.alerts()).alerts; } catch (e) { toast('Failed to load alerts: ' + e.message, 'error'); S.alerts = []; }
  renderAlerts();
  syncAlertLines();
}

export function alertSummary(a) {
  const sp = a.spec || {};
  if (a.kind === 'price') return `Price ${condText(a.cond)} ${sp.price}`;
  if (a.kind === 'drawing') return `Drawing (${sp.tool || '?'}) ${condText(a.cond)}`;
  const tgt = sp.target || {};
  const rhs = a.cond === 'signal' ? '' : tgt.type === 'plot' ? tgt.plot : tgt.value;
  return `${sp.name || sp.type} · ${sp.plot} ${condText(a.cond)} ${rhs ?? ''} (${a.tf})`;
}

function renderAlerts() {
  const list = $('#al-list');
  list.innerHTML = '';
  if (!S.alerts.length) { list.append(el('div', { class: 'wl-empty' }, 'No alerts. Select a drawing and press 🔔, use … → Add alert on an indicator, or "+ Price alert".')); return; }
  for (const a of S.alerts) {
    const sw = el('button', { class: `switch ${a.active ? 'on' : ''}`, title: a.active ? 'Pause' : 'Activate', 'data-testid': 'al-toggle', onclick: async () => {
      try { await api.saveAlert({ ...a, active: a.active ? 0 : 1 }); await loadAlerts(); loadLog(); } catch (e) { toast(e.message, 'error'); }
    } });
    list.append(el('div', { class: `al-item ${a.active ? '' : 'paused'}`, 'data-alert': a.id },
      sw,
      el('div', { class: 'al-main', onclick: () => { if (a.symbol !== S.symbol) app.setSymbol(a.symbol); } },
        el('div', { class: 'al-title' }, `${app.symbolName(a.symbol)} `, el('span', { class: 'muted', style: { fontWeight: 400 } }, a.active ? '' : (a.fired_count ? '· triggered' : '· paused'))),
        el('div', { class: 'al-desc' }, alertSummary(a)),
        a.message ? el('div', { class: 'al-desc' }, `“${a.message}”`) : null,
        el('div', { class: 'al-desc' }, `${a.frequency === 'once' ? 'Once' : 'Once per bar'} · triggered ${a.fired_count}×`)),
      el('button', { class: 'lg-act', title: 'History', 'data-testid': 'al-history', html: ICONS.history, onclick: () => dialogs.alertLog(app, { alertId: a.id }) }),
      el('button', { class: 'lg-act', title: 'Edit', html: ICONS.gear, onclick: () => dialogs.alertDialog(app, { alert: a }) }),
      el('button', { class: 'lg-act', title: 'Delete', 'data-testid': 'al-delete', html: ICONS.close, onclick: async () => {
        if (!(await dialogs.confirm('Delete this alert?', { ok: 'Delete', danger: true }))) return;
        await api.deleteAlert(a.id); await loadAlerts(); loadLog();
      } })));
  }
}

function syncAlertLines() {
  if (!app.dm) return;
  const mine = (S.alerts || []).filter(a => a.symbol === S.symbol && a.active);
  app.dm.alertLines = mine.filter(a => a.kind === 'price').map(a => ({ price: a.spec.price, color: '#ff9800' }));
  app.dm.alertDrawingIds = new Set(mine.filter(a => a.kind === 'drawing').map(a => a.spec.drawing_id));
  app.dm.update();
}

// ---- fired alert notifications
let since = 0;
let unseen = 0;
function renderBadge() {
  const b = $('#alert-badge');
  b.hidden = !unseen;
  b.textContent = unseen;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
    o.stop(ctx.currentTime + 0.3);
  } catch { /* autoplay blocked */ }
}

// ---- alert history (latest entries in the Alerts tab; the full history is a dialog)
async function loadLog() {
  const box = $('#al-log');
  try {
    const { log } = await api.alertLog({ limit: 40 });
    box.innerHTML = '';
    if (!log.length) { box.append(el('div', { class: 'wl-empty' }, 'No alert activity yet.')); return; }
    for (const e of log) box.append(dialogs.logRow(app, e, { compact: true }));
  } catch { /* offline */ }
}
async function initEvents() {
  app.loadAlertLog = loadLog; // `app` exists only once initPanels() has run
  try {
    const { events } = await api.alertEvents(0);
    since = events.length ? Math.max(...events.map(e => e.created_ms)) : Date.now();
  } catch { since = Date.now(); }
  loadLog();
  setInterval(pollEvents, 10000);
  setInterval(() => { if (!$('#tab-alerts').hidden && !document.hidden) loadLog(); }, 30000); // delivery results arrive later
}

async function pollEvents() {
  try {
    const { events } = await api.alertEvents(since);
    if (!events.length) return;
    since = Math.max(since, ...events.map(e => e.created_ms));
    for (const ev of events.slice().reverse()) {
      toast(ev.message, 'alert', `🔔 ${app.symbolName(ev.symbol)} @ ${fmtQuote(ev.price)}`, 10000);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(`🔔 ${app.symbolName(ev.symbol)}`, { body: ev.message }); } catch { /* */ }
      }
    }
    if ($('#tab-alerts').hidden) { unseen += events.length; renderBadge(); }
    beep();
    loadAlerts();
    loadLog();
    setTimeout(loadLog, 5000); // e-mail / Telegram / webhook results are logged a moment later
  } catch { /* offline */ }
}
