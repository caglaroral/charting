// Main application: chart, data loading, indicators, legend, toolbars.
import { api, events } from './api.js';
import { el, $, toast, showMenu, fmtNum, decimalsOf, debounce, ic, ICONS } from './ui.js';
import { INDICATORS, defaultParams, defaultColors, label as indLabel } from './indicators.js';
import { DrawingManager, TOOLS, GROUPS } from './drawings.js';
import { ScriptSandbox } from './sandbox.js';
import { restKlines, klineStream, PROVIDERS, connectionCount } from './live.js';
import { initPanels } from './panels.js';
import * as dialogs from './dialogs.js';

const LWC = window.LightweightCharts;

export const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '12h': 43200, '1D': 86400, '1W': 604800, '1M': 2592000 };
export const TF_NAME = { '1m': '1 minute', '3m': '3 minutes', '5m': '5 minutes', '15m': '15 minutes', '30m': '30 minutes', '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '12h': '12 hours', '1D': '1 day', '1W': '1 week', '1M': '1 month' };
const TF_SHORT = { '1D': 'D', '1W': 'W', '1M': 'M' };
const INITIAL_BARS = 3000;
const MORE_BARS = 2000;        // first history chunk; later chunks grow with the loaded history
const MAX_MORE_BARS = 20000;   // = backend market.MAX_LIMIT

const CHART_TYPES = {
  bars: 'Bars', candles: 'Candles', hollow: 'Hollow candles', volcandles: 'Volume candles',
  line: 'Line', linemarkers: 'Line with markers', stepline: 'Step line',
  area: 'Area', hlcarea: 'HLC area', baseline: 'Baseline',
  columns: 'Columns', highlow: 'High-low',
  heikin: 'Heikin Ashi', renko: 'Renko', linebreak: 'Line break',
};
const CHART_TYPE_GROUPS = [['bars', 'candles', 'hollow', 'volcandles'], ['line', 'linemarkers', 'stepline'], ['area', 'hlcarea', 'baseline'], ['columns', 'highlow'], ['heikin', 'renko', 'linebreak']];
// Chart types whose bars are not time based: indicators and drawings work on the transformed bars.
const TRANSFORMED = new Set(['renko', 'linebreak']);

const TIMEZONES = [
  ['Pacific/Honolulu', 'Honolulu'], ['America/Anchorage', 'Anchorage'], ['America/Juneau', 'Juneau'], ['America/Los_Angeles', 'Los Angeles'],
  ['America/Vancouver', 'Vancouver'], ['America/Denver', 'Denver'], ['America/Phoenix', 'Phoenix'], ['America/Chicago', 'Chicago'],
  ['America/Mexico_City', 'Mexico City'], ['America/El_Salvador', 'San Salvador'], ['America/Bogota', 'Bogota'], ['America/Lima', 'Lima'],
  ['America/New_York', 'New York'], ['America/Toronto', 'Toronto'], ['America/Caracas', 'Caracas'], ['America/Halifax', 'Halifax'],
  ['America/Argentina/Buenos_Aires', 'Buenos Aires'], ['America/Santiago', 'Santiago'], ['America/Sao_Paulo', 'Sao Paulo'],
  ['Atlantic/Azores', 'Azores'], ['Africa/Casablanca', 'Casablanca'], ['Europe/Dublin', 'Dublin'], ['Europe/Lisbon', 'Lisbon'],
  ['Europe/London', 'London'], ['Atlantic/Reykjavik', 'Reykjavik'], ['Europe/Amsterdam', 'Amsterdam'], ['Europe/Belgrade', 'Belgrade'],
  ['Europe/Berlin', 'Berlin'], ['Europe/Bratislava', 'Bratislava'], ['Europe/Brussels', 'Brussels'], ['Europe/Budapest', 'Budapest'],
  ['Europe/Copenhagen', 'Copenhagen'], ['Africa/Lagos', 'Lagos'], ['Europe/Luxembourg', 'Luxembourg'], ['Europe/Madrid', 'Madrid'],
  ['Europe/Malta', 'Malta'], ['Europe/Oslo', 'Oslo'], ['Europe/Paris', 'Paris'], ['Europe/Prague', 'Prague'], ['Europe/Rome', 'Rome'],
  ['Europe/Stockholm', 'Stockholm'], ['Africa/Tunis', 'Tunis'], ['Europe/Vienna', 'Vienna'], ['Europe/Warsaw', 'Warsaw'], ['Europe/Zurich', 'Zurich'],
  ['Europe/Athens', 'Athens'], ['Africa/Cairo', 'Cairo'], ['Africa/Johannesburg', 'Johannesburg'], ['Europe/Helsinki', 'Helsinki'],
  ['Asia/Jerusalem', 'Jerusalem'], ['Europe/Riga', 'Riga'], ['Europe/Tallinn', 'Tallinn'], ['Europe/Vilnius', 'Vilnius'], ['Europe/Bucharest', 'Bucharest'],
  ['Asia/Bahrain', 'Bahrain'], ['Europe/Istanbul', 'Istanbul'], ['Asia/Kuwait', 'Kuwait'], ['Europe/Moscow', 'Moscow'], ['Africa/Nairobi', 'Nairobi'],
  ['Asia/Qatar', 'Qatar'], ['Asia/Riyadh', 'Riyadh'], ['Asia/Tehran', 'Tehran'], ['Asia/Dubai', 'Dubai'], ['Asia/Muscat', 'Muscat'],
  ['Asia/Ashgabat', 'Ashgabat'], ['Asia/Kabul', 'Kabul'], ['Asia/Karachi', 'Karachi'], ['Asia/Almaty', 'Almaty'], ['Asia/Colombo', 'Colombo'],
  ['Asia/Kolkata', 'Kolkata'], ['Asia/Kathmandu', 'Kathmandu'], ['Asia/Dhaka', 'Dhaka'], ['Asia/Yangon', 'Yangon'], ['Asia/Bangkok', 'Bangkok'],
  ['Asia/Ho_Chi_Minh', 'Ho Chi Minh'], ['Asia/Jakarta', 'Jakarta'], ['Asia/Chongqing', 'Chongqing'], ['Asia/Hong_Kong', 'Hong Kong'],
  ['Australia/Perth', 'Perth'], ['Asia/Manila', 'Manila'], ['Asia/Shanghai', 'Shanghai'], ['Asia/Singapore', 'Singapore'], ['Asia/Taipei', 'Taipei'],
  ['Asia/Seoul', 'Seoul'], ['Asia/Tokyo', 'Tokyo'], ['Australia/Adelaide', 'Adelaide'], ['Australia/Brisbane', 'Brisbane'], ['Australia/Sydney', 'Sydney'],
  ['Pacific/Norfolk', 'Norfolk Island'], ['Pacific/Auckland', 'New Zealand'], ['Pacific/Chatham', 'Chatham Islands'], ['Pacific/Fakaofo', 'Tokelau'],
];
// 'UTC' and 'exchange' (the exchange time = UTC for crypto) are listed first; 'local' = browser.

const RANGES = [
  ['1D', '1m', 86400], ['5D', '5m', 5 * 86400], ['1M', '30m', 30 * 86400], ['3M', '1h', 91 * 86400],
  ['6M', '2h', 182 * 86400], ['YTD', '1D', 'ytd'], ['1Y', '1D', 365 * 86400], ['5Y', '1W', 5 * 365 * 86400], ['All', '1W', 'all'],
];

function tzOffsetSec(tz) {
  if (tz === 'UTC' || tz === 'exchange') return 0;
  const now = new Date();
  if (tz === 'local') return -now.getTimezoneOffset() * 60;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now);
  const g = (t) => Number(parts.find(p => p.type === t).value);
  const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUTC - now.getTime()) / 60000) * 60;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

// display seconds (already tz shifted) -> label
export function fmtTime(t, withTime = true) {
  const d = new Date(t * 1000);
  const s = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
  return withTime ? `${s} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : s;
}

// Main series / canvas appearance (Chart settings dialog); stored per user in the layout
export const DEFAULT_STYLE = {
  upColor: '#089981', downColor: '#f23645', body: true,
  borderVisible: true, borderUpColor: '#089981', borderDownColor: '#f23645',
  wickVisible: true, wickUpColor: '#089981', wickDownColor: '#f23645',
  lineColor: '#2962ff', background: '#131722', gridVisible: true, gridColor: '#1e222d',
};

// ======================================================================= app object
export const app = {
  S: {
    user: null, symbols: [], symMap: new Map(), symbol: null, tf: '1h', chartType: 'candles',
    indicators: [], tz: 'Europe/Istanbul', tzOffset: 10800, magnet: false, keepDrawing: false,
    favTfs: ['1m', '5m', '15m', '1h', '4h', '1D'], watchlists: [], wlId: null, alerts: [], scripts: [],
    bars: [], view: [], exhausted: false, priceDecimals: 2, scaleMode: 0, autoScale: true, rightPanel: true,
    availableTfs: Object.keys(TF_SEC), style: { ...DEFAULT_STYLE },
  },
  chart: null, mainSeries: null, dm: null, sandbox: null,
  ind: { sig: null, items: [], token: 0 },
  htfCache: new Map(),
  hooks: { symbolChanged: [], barsLoaded: [], alertsChanged: [], tick: [] },
  on(evt, fn) { this.hooks[evt].push(fn); },
  emit(evt, ...a) { for (const f of this.hooks[evt]) { try { f(...a); } catch (e) { console.error(e); } } },
};
app.DEFAULT_STYLE = DEFAULT_STYLE;
window.__app = app; // handy for debugging and e2e tests
app.liveConnections = () => connectionCount();
window.__tools = TOOLS;

const S = app.S;

app.fmtPrice = (p) => (p == null || Number.isNaN(p) ? '—' : Number(p).toFixed(S.priceDecimals));
app.tfSec = () => TF_SEC[S.tf];
app.TF_SEC = TF_SEC; app.TF_NAME = TF_NAME;
app.symbolName = (key) => (key || '').split(':').pop();
app.symbolSource = (key) => ((key || '').includes(':') ? key.split(':')[0] : '');

// ======================================================================= auth / boot
async function boot() {
  events.addEventListener('auth-required', () => { if (S.user) location.reload(); });
  try {
    const { user, plan } = await api.me();
    S.user = user;
    S.plan = plan;
    await start();
  } catch (e) {
    if (e.status === 401) showLogin(); else showFatal(e);
  }
}

async function showLogin() {
  const cfg = await api.authConfig().catch(() => ({ mode: 'local', password_login: true }));
  $('#login').hidden = false;
  if (!cfg.password_login) {
    $('#login-note').textContent = 'This installation uses an external identity provider. Please sign in through it.';
    $('#login-submit').disabled = true;
  }
  $('#login-user').focus();
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const { user } = await api.login($('#login-user').value, $('#login-pass').value);
      S.user = user;
      S.plan = (await api.me()).plan;
      $('#login').hidden = true;
      await start();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  };
}

function showFatal(e) {
  document.body.append(el('div', { class: 'chart-msg', style: { position: 'fixed' } }, 'Error: ' + e.message));
}

async function start() {
  $('#app').hidden = false;
  const [syms, layoutRes, scripts, toolStyles] = await Promise.all([
    api.symbols(), api.getSetting('layout').catch(() => ({ value: null })), api.scripts().catch(() => ({ scripts: [] })),
    api.getSetting('drawingStyles').catch(() => ({ value: null })),
  ]);
  S.symbols = syms.symbols;
  S.sources = Object.fromEntries((syms.sources || []).map(x => [x.prefix, x]));
  S.symMap = new Map(S.symbols.map(s => [s.symbol, s]));
  S.scripts = scripts.scripts;
  S.toolStyles = toolStyles.value || {};
  api.notify().then(n => { S.notifyDefaults = n.default_channels; }).catch(() => {});
  const L = layoutRes.value || {};
  Object.assign(S, {
    symbol: L.symbol && S.symMap.has(L.symbol) ? L.symbol : (S.symMap.has('BINANCE:BTCUSDT') ? 'BINANCE:BTCUSDT' : S.symbols[0]?.symbol),
    tf: TF_SEC[L.tf] ? L.tf : '1h',
    chartType: CHART_TYPES[L.chartType] ? L.chartType : 'candles',
    indicators: Array.isArray(L.indicators) ? L.indicators : [{ id: 'vol', type: 'volume', params: defaultParams('volume'), colors: defaultColors('volume'), visible: true }],
    tz: L.tz || 'Europe/Istanbul',
    magnet: !!L.magnet, keepDrawing: !!L.keepDrawing,
    favTfs: Array.isArray(L.favTfs) && L.favTfs.length ? L.favTfs : S.favTfs,
    wlId: L.wlId || null,
    rightPanel: L.rightPanel !== false,
    scaleMode: L.scaleMode || 0,
    autoScale: L.autoScale !== false,
    mainPos: Number(L.mainPos) || 0,
    lastTool: L.lastTool || {},
    style: { ...DEFAULT_STYLE, ...(L.style && typeof L.style === 'object' ? L.style : {}) },
  });
  S.cursorMode = L.cursorMode || 'cross';
  S.tzOffset = tzOffsetSec(S.tz);
  $('#app').classList.toggle('no-panel', !S.rightPanel);

  app.sandbox = new ScriptSandbox();
  createChart();
  buildTopbar();
  buildLeftTools();
  buildBottombar();
  initPanels(app);
  bindKeys();
  if (!S.symbol) {
    showMsg(S.user.is_admin ? 'No data source yet. User menu → Data Sources' : 'No data source configured. Contact your administrator.');
    return;
  }
  await setSymbol(S.symbol, { initial: true });
  setInterval(pollLatest, 15000);
}

app.saveLayout = debounce(() => {
  api.setSetting('layout', {
    symbol: S.symbol, tf: S.tf, chartType: S.chartType, indicators: S.indicators.map(i => ({ id: i.id, type: i.type, script_id: i.script_id, params: i.params, colors: i.colors, visible: i.visible, scale: i.scale, collapsed: i.collapsed })),
    tz: S.tz, magnet: S.magnet, keepDrawing: S.keepDrawing, lastTool: S.lastTool, cursorMode: app.dm?.cursorMode, favTfs: S.favTfs, wlId: S.wlId, rightPanel: S.rightPanel, scaleMode: S.scaleMode, autoScale: S.autoScale, mainPos: S.mainPos || 0,
    style: S.style,
  }).catch(e => console.warn('layout save failed', e));
}, 800);

function showMsg(text) {
  const m = $('#chart-msg');
  m.hidden = !text;
  m.textContent = text || '';
}

// ======================================================================= chart
function createChart() {
  const container = $('#chart');
  app.chart = LWC.createChart(container, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#b2b5be', fontSize: 12, fontFamily: getComputedStyle(document.body).fontFamily, panes: { separatorColor: '#2a2e39', separatorHoverColor: '#2962ff55', enableResize: true }, attributionLogo: false },
    grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
    crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: '#9598a1', labelBackgroundColor: '#363a45' }, horzLine: { color: '#9598a1', labelBackgroundColor: '#363a45' } },
    rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 12, barSpacing: 7 },
    // no chart-wide priceFormatter: every price scale uses the format of its own series (symbol decimals
    // on the price pane, the indicator's precision on indicator panes)
    localization: { timeFormatter: (t) => fmtTime(t, TF_SEC[S.tf] < 86400) },
  });
  applyCanvasStyle();
  app.dm = new DrawingManager({
    chart: app.chart, container,
    getBars: () => S.view || S.bars, tfSec: () => TF_SEC[S.tf], tz: () => S.tzOffset, symbol: () => S.symbol,
    fmtPrice: (p) => app.fmtPrice(p), fmtTime: (t) => fmtTime(t, TF_SEC[S.tf] < 86400),
    magnet: () => S.magnet, keepDrawing: () => S.keepDrawing,
    onSelect: (d) => renderDrawbar(d), onToolChange: () => renderLeftActive(),
    onToolStyles: (map) => api.setSetting('drawingStyles', map).catch(e => toast('Failed to save the drawing style: ' + e.message, 'error')),
    editText: async (d) => {
      const t = await dialogs.promptText('Text', d.text || '');
      if (t != null) app.dm.updateSelected({ text: t });
    },
    toast,
    onZoom: (l0, l1) => { S.autoScale = true; applyScaleMode(); app.chart.timeScale().setVisibleLogicalRange({ from: l0, to: l1 }); },
  });
  app.dm.setToolStyles(S.toolStyles);
  makeMainSeries();
  if (S.cursorMode && S.cursorMode !== 'cross') app.dm.setTool(S.cursorMode);
  let lgFrame = 0;
  app.chart.subscribeCrosshairMove((p) => {
    lastCrosshair = p && p.logical != null ? Math.round(p.logical) : null;
    if (!lgFrame) lgFrame = requestAnimationFrame(() => { lgFrame = 0; updateLegendValues(lastCrosshair); });
  });
  app.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    lastScroll = performance.now();
    if (r && r.from < 30) loadMore();
  });
  new ResizeObserver(() => positionPaneLegends()).observe(container);
  const sb = el('div', { class: 'scale-btns', id: 'scale-btns' },
    el('button', { class: 'scale-btn', id: 'sb-auto', title: 'Auto (fits data to screen)', onclick: () => { S.autoScale = !S.autoScale; applyScaleMode(); app.saveLayout(); } }, 'A'),
    el('button', { class: 'scale-btn', id: 'sb-log', title: 'Logarithmic', onclick: () => { S.scaleMode = S.scaleMode === 1 ? 0 : 1; applyScaleMode(); app.saveLayout(); } }, 'L'));
  $('#chartwrap').append(sb);
  applyScaleMode();
  // TradingView's "Scroll to the most recent bar" button: shown while the newest bar is off screen
  const recent = el('button', { class: 'scroll-recent', id: 'btn-scroll-recent', hidden: true, 'data-testid': 'scroll-recent',
    title: 'Scroll to the most recent bar (Alt+Shift+→)', onclick: () => app.scrollToRecent(),
    html: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l6 6-6 6M12 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>' });
  $('#chartwrap').append(recent);
  app.chart.timeScale().subscribeVisibleLogicalRangeChange(updateScrollRecent); // buttons exist only now: show the restored A / L state
  // Dragging the price axis turns auto scale off in the library; mirror that state in the buttons.
  container.addEventListener('pointerup', () => setTimeout(() => {
    positionPaneLegends(); // pane separators may have been dragged
    const auto = app.chart.priceScale('right', mainIdx()).options().autoScale;
    if (auto !== S.autoScale) { S.autoScale = auto; applyScaleMode(); app.saveLayout(); }
    for (const it of app.ind.items) {
      if (!it.own) continue;
      const a = app.chart.priceScale('right', it.pane).options().autoScale;
      if (a !== paneScale(it.inst).auto) { it.inst.scale = { ...paneScale(it.inst), auto: a }; renderPaneScaleBtns(); app.saveLayout(); }
    }
  }, 0));
}

function applyCanvasStyle() {
  const st = S.style;
  const grid = st.gridVisible ? st.gridColor : 'rgba(0,0,0,0)';
  app.chart.applyOptions({ layout: { background: { type: 'solid', color: st.background } }, grid: { vertLines: { color: grid }, horzLines: { color: grid } } });
  $('#chart').style.background = st.background;
  const lg = $('#legend'); // OHLC values follow the candle colors, like TradingView
  if (lg) { lg.style.setProperty('--up', st.upColor); lg.style.setProperty('--down', st.downColor); }
}

/** Apply S.style to the chart (called live by the Chart settings dialog). */
app.applyStyle = () => {
  applyCanvasStyle();
  if (!app.mainSeries || !S.view.length) return;
  makeMainSeries(); setMainData(); app.ind.sig = null;
  refreshIndicators(true); app.dm.update();
};

/** Index of the price pane; indicator panes can be moved above it. */
const mainIdx = () => { try { return app.mainSeries ? app.mainSeries.getPane().paneIndex() : 0; } catch { return 0; } };
app.mainPaneIndex = mainIdx;

const alpha = (hex, a) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex + a : hex);

function makeMainSeries() {
  const c = app.chart;
  if (app.mainSeries && mainIdx() !== 0) app.mainSeries.getPane().moveTo(0); // new series is created in pane 0
  if (app.mainSeries) { c.removeSeries(app.mainSeries); app.mainSeries = null; }
  for (const x of app.extraMain || []) c.removeSeries(x);
  app.extraMain = [];
  const st = S.style, up = st.upColor, down = st.downColor, line = st.lineColor;
  const candle = {
    upColor: st.body ? up : 'rgba(0,0,0,0)', downColor: st.body ? down : 'rgba(0,0,0,0)',
    borderVisible: st.borderVisible, borderUpColor: st.borderUpColor, borderDownColor: st.borderDownColor,
    wickVisible: st.wickVisible, wickUpColor: st.wickUpColor, wickDownColor: st.wickDownColor,
  };
  const t = S.chartType;
  let s;
  if (t === 'volcandles') s = c.addSeries(LWC.CandlestickSeries, candle);
  else if (t === 'highlow') s = c.addSeries(LWC.CandlestickSeries, { upColor: '#2962ff', downColor: '#2962ff', borderVisible: false, wickVisible: false });
  else if (t === 'columns') s = c.addSeries(LWC.HistogramSeries, { color: alpha(up, '99'), base: 0 });
  else if (t === 'linemarkers') s = c.addSeries(LWC.LineSeries, { color: line, lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 2.5 });
  else if (t === 'stepline') s = c.addSeries(LWC.LineSeries, { color: line, lineWidth: 2, lineType: 1 });
  else if (t === 'hlcarea') {
    app.extraMain = [
      c.addSeries(LWC.AreaSeries, { lineColor: alpha(up, 'b3'), topColor: alpha(up, '40'), bottomColor: alpha(up, '00'), lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }),
      c.addSeries(LWC.AreaSeries, { lineColor: alpha(down, 'b3'), topColor: alpha(down, '00'), bottomColor: alpha(down, '40'), invertFilledArea: true, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }),
    ];
    s = c.addSeries(LWC.LineSeries, { color: '#d1d4dc', lineWidth: 2 });
  } else if (t === 'candles' || t === 'heikin' || t === 'renko' || t === 'linebreak') s = c.addSeries(LWC.CandlestickSeries, candle);
  else if (t === 'hollow') s = c.addSeries(LWC.CandlestickSeries, { ...candle, upColor: 'rgba(0,0,0,0)', borderVisible: true, borderUpColor: up, borderDownColor: down });
  else if (t === 'bars') s = c.addSeries(LWC.BarSeries, { upColor: up, downColor: down, thinBars: false });
  else if (t === 'line') s = c.addSeries(LWC.LineSeries, { color: line, lineWidth: 2 });
  else if (t === 'area') s = c.addSeries(LWC.AreaSeries, { lineColor: line, topColor: alpha(line, '59'), bottomColor: alpha(line, '00'), lineWidth: 2 });
  else s = c.addSeries(LWC.BaselineSeries, { baseValue: { type: 'price', price: 0 }, topLineColor: up, bottomLineColor: down, topFillColor1: alpha(up, '40'), topFillColor2: alpha(up, '0d'), bottomFillColor1: alpha(down, '0d'), bottomFillColor2: alpha(down, '40') });
  if ('crosshairMarkerVisible' in s.options()) s.applyOptions({ crosshairMarkerVisible: false }); // line/area types
  app.mainSeries = s;
  app.dm.attach(s);
  applyPriceFormat();
  applyScaleMode();
}

function mainData() {
  const b = S.view, t = S.chartType;
  if (['line', 'linemarkers', 'stepline', 'area', 'baseline', 'hlcarea'].includes(t)) return b.map(x => ({ time: x.time, value: x.close }));
  if (t === 'columns') return b.map((x, i) => ({ time: x.time, value: x.close, color: i && x.close < b[i - 1].close ? alpha(S.style.downColor, '99') : alpha(S.style.upColor, '99') }));
  if (t === 'highlow') return b.map(x => ({ time: x.time, open: x.high, high: x.high, low: x.low, close: x.low }));
  if (t === 'volcandles') {
    const avg = [];
    let sum = 0;
    b.forEach((x, i) => { sum += x.volume; if (i >= 20) sum -= b[i - 20].volume; avg.push(sum / Math.min(i + 1, 20)); });
    return b.map((x, i) => {
      const r = avg[i] ? x.volume / avg[i] : 1;
      const a = Math.max(0.25, Math.min(1, 0.25 + 0.5 * r));
      const c = x.close >= x.open ? `rgba(8,153,129,${a.toFixed(2)})` : `rgba(242,54,69,${a.toFixed(2)})`;
      return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close, color: c, wickColor: c, borderColor: c };
    });
  }
  if (t === 'heikin') {
    const out = [];
    let po = null, pc = null;
    for (const x of b) {
      const c = (x.open + x.high + x.low + x.close) / 4;
      const o = po == null ? (x.open + x.close) / 2 : (po + pc) / 2;
      out.push({ time: x.time, open: o, high: Math.max(x.high, o, c), low: Math.min(x.low, o, c), close: c });
      po = o; pc = c;
    }
    return out;
  }
  return b.map(x => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }));
}

// Extra series for chart types made of several series (HLC area)
function extraMainData() {
  if (S.chartType !== 'hlcarea') return;
  const [hi, lo] = app.extraMain;
  hi.setData(S.view.map(x => ({ time: x.time, value: x.high })));
  lo.setData(S.view.map(x => ({ time: x.time, value: x.low })));
}

function setMainData(full = true) {
  const md = mainData();
  if (full || TRANSFORMED.has(S.chartType) || S.chartType === 'heikin' || S.chartType === 'volcandles' || S.chartType === 'columns') {
    app.mainSeries.setData(md);
    extraMainData();
  } else if (md.length) {
    app.mainSeries.update(md[md.length - 1]);
    if (S.chartType === 'hlcarea') {
      const x = S.view[S.view.length - 1];
      app.extraMain[0].update({ time: x.time, value: x.high });
      app.extraMain[1].update({ time: x.time, value: x.low });
    }
  }
}

function applyPriceFormat() {
  const recent = (S.view || S.bars).slice(-300);
  let d = decimalsOf(recent.flatMap(b => [b.open, b.close, b.high, b.low]));
  const last = recent.length ? recent[recent.length - 1].close : 1;
  if (d < 2 && last < 1000) d = 2;
  S.priceDecimals = d;
  app.mainSeries?.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: Math.pow(10, -d) } });
  if (S.chartType === 'baseline' && S.bars.length) {
    app.mainSeries.applyOptions({ baseValue: { type: 'price', price: S.view[Math.max(0, S.view.length - 200)].close } });
  }
}

function applyScaleMode() {
  app.chart.priceScale('right', mainIdx()).applyOptions({ mode: S.scaleMode, autoScale: S.autoScale });
  resetPaneScales();
  $('#btn-log')?.classList.toggle('active', S.scaleMode === 1);
  $('#btn-pct')?.classList.toggle('active', S.scaleMode === 2);
  $('#btn-auto')?.classList.toggle('active', S.autoScale);
  $('#sb-auto')?.classList.toggle('active', S.autoScale);
  $('#sb-log')?.classList.toggle('active', S.scaleMode === 1);
  positionScaleBtns();
}

// Every indicator pane has its own A (auto) / L (log) state, stored with the indicator. New panes
// copy the main scale's options, so the state is always applied explicitly (default: normal, auto).
const paneScale = (inst) => ({ log: false, auto: true, ...(inst.scale || {}) });

function resetPaneScales() {
  for (const it of app.ind.items) {
    if (!it.own) continue;
    const sc = paneScale(it.inst);
    try { app.chart.priceScale('right', it.pane).applyOptions({ mode: sc.log ? 1 : 0, autoScale: sc.auto }); } catch { /* pane gone */ }
  }
  renderPaneScaleBtns();
}

function setPaneScale(it, patch) {
  it.inst.scale = { ...paneScale(it.inst), ...patch };
  resetPaneScales();
  app.saveLayout();
}

function renderPaneScaleBtns() {
  for (const d of document.querySelectorAll('.pane-scale-btns')) d.remove();
  for (const it of app.ind.items) {
    if (!it.own) continue;
    const sc = paneScale(it.inst);
    $('#chartwrap').append(el('div', { class: 'scale-btns pane-scale-btns', 'data-pane': it.pane, 'data-ind': it.inst.id },
      el('button', { class: `scale-btn ${sc.auto ? 'active' : ''}`, title: 'Auto (fits data to screen)', 'data-testid': 'pane-auto', onclick: () => setPaneScale(it, { auto: !sc.auto }) }, 'A'),
      el('button', { class: `scale-btn ${sc.log ? 'active' : ''}`, title: 'Logarithmic', 'data-testid': 'pane-log', onclick: () => setPaneScale(it, { log: !sc.log }) }, 'L')));
  }
  requestAnimationFrame(positionPaneLegends);
}

// With auto scale off the price range is whatever it was before: right after a reload or a symbol
// change that is no range for the new data (blank chart, worse in log mode). Fit the new data once,
// then return to the user's manual (auto off) mode, like TradingView.
function fitPriceScaleOnce() {
  if (S.autoScale) return;
  const ps = app.chart.priceScale('right', mainIdx());
  ps.applyOptions({ autoScale: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!S.autoScale) ps.applyOptions({ autoScale: false }); }));
}

// Jump (no animation: the animated scrollToRealTime could stop short when data updates meanwhile)
app.scrollToRecent = () => { const ts = app.chart.timeScale(); ts.scrollToPosition(ts.options().rightOffset, false); };

function updateScrollRecent() {
  const b = $('#btn-scroll-recent');
  if (!b) return;
  const r = app.chart.timeScale().getVisibleLogicalRange();
  const hide = !r || !S.view.length || r.to >= S.view.length - 1;
  if (hide === b.hidden) return;
  b.hidden = hide;
  if (!hide) positionScaleBtns(); // measures the layout: only when it appears
}

function positionScaleBtns() {
  const b = $('#scale-btns');
  if (!b || !app.chart) return;
  const w = app.chart.priceScale('right', mainIdx()).width();
  const panes = app.chart.panes();
  const main = panes[mainIdx()]?.getHTMLElement();
  const base = $('#chart').getBoundingClientRect();
  const bottom = main ? main.getBoundingClientRect().bottom - base.top : base.height - 30;
  b.style.left = `${base.width - w + Math.max(2, (w - 44) / 2)}px`;
  b.style.top = `${bottom - 24}px`;
  const rb = $('#btn-scroll-recent');
  if (rb) { // bottom-right of the chart, just above the time axis, left of the price scale
    const last = panes[panes.length - 1]?.getHTMLElement();
    const lb = last ? last.getBoundingClientRect().bottom - base.top : base.height - 30;
    rb.style.left = `${base.width - w - 36}px`;
    rb.style.top = `${lb - 34}px`;
  }
  for (const d of document.querySelectorAll('.pane-scale-btns')) {
    const e = panes[Number(d.dataset.pane)]?.getHTMLElement();
    const r = e && e.getBoundingClientRect();
    d.hidden = !r || r.height < 60;
    if (!r) continue;
    d.style.left = b.style.left;
    d.style.top = `${r.bottom - base.top - 24}px`;
  }
}

// S.bars = time-based source bars. S.view = bars shown on the chart (Renko/Line break transform them).
function refreshView() {
  S.view = S.chartType === 'renko' ? renkoBars(S.bars) : S.chartType === 'linebreak' ? lineBreakBars(S.bars, 3) : S.bars;
}
app.refreshView = refreshView;

function atrOf(bars, n = 14) {
  let atr = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    atr = atr == null ? tr : (atr * (n - 1) + tr) / n;
  }
  return atr || (bars[0] ? bars[0].close * 0.01 : 1);
}

// Each generated brick/line needs a unique, increasing time: bar time + k seconds.
function stamp(out, t) {
  const last = out.length ? out[out.length - 1].time : -Infinity;
  return t > last ? t : last + 1;
}

function renkoBars(bars) {
  if (!bars.length) return [];
  const box = S.renkoBox || atrOf(bars.slice(-500));
  const out = [];
  let base = Math.round(bars[0].close / box) * box, dir = 0;
  for (const b of bars) {
    const c = b.close;
    for (;;) {
      if ((dir >= 0 && c >= base + box) || (dir < 0 && c >= base + 2 * box)) {
        const o = dir < 0 ? base + box : base;
        out.push({ time: stamp(out, b.time), open: o, high: o + box, low: o, close: o + box, volume: b.volume });
        base = o + box; dir = 1;
      } else if ((dir <= 0 && c <= base - box) || (dir > 0 && c <= base - 2 * box)) {
        const o = dir > 0 ? base - box : base;
        out.push({ time: stamp(out, b.time), open: o, high: o, low: o - box, close: o - box, volume: b.volume });
        base = o - box; dir = -1;
      } else break;
    }
  }
  return out;
}

function lineBreakBars(bars, n = 3) {
  const out = [];
  for (const b of bars) {
    const c = b.close;
    if (!out.length) { out.push({ time: b.time, open: b.open, high: Math.max(b.open, c), low: Math.min(b.open, c), close: c, volume: b.volume }); continue; }
    const last = out[out.length - 1];
    const up = last.close >= last.open;
    const recent = out.slice(-n);
    const hi = Math.max(...recent.map(x => Math.max(x.open, x.close))), lo = Math.min(...recent.map(x => Math.min(x.open, x.close)));
    if ((up && c > last.close) || (!up && c > hi)) {
      const o = up ? last.close : last.open;
      out.push({ time: stamp(out, b.time), open: o, high: c, low: o, close: c, volume: b.volume });
    } else if ((!up && c < last.close) || (up && c < lo)) {
      const o = up ? last.open : last.close;
      out.push({ time: stamp(out, b.time), open: o, high: o, low: c, close: c, volume: b.volume });
    }
  }
  return out;
}

const toBar = (r) => ({ time: r[0] + S.tzOffset, open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] });

let loadToken = 0;
export async function setSymbol(symbol, { initial = false, tf = null, range = null, anchor = null } = {}) {
  if (!symbol) return;
  const token = ++loadToken;
  S.symbol = symbol;
  if (tf) S.tf = tf;
  const info = S.symMap.get(symbol);
  $('#symbol-label').textContent = app.symbolName(symbol);
  document.title = `${app.symbolName(symbol)} · ${TF_SHORT[S.tf] || S.tf} · Charting`;
  renderTfButtons();
  setStatus('busy');
  showMsg('Loading…');
  try {
    closeStream();
    const provider = liveProvider(symbol);
    const [rows, dr] = await Promise.all([
      provider ? restKlines(provider, app.symbolName(symbol), S.tf) : api.bars(symbol, S.tf, null, INITIAL_BARS).then(r => r.bars),
      api.drawings(symbol).catch(() => ({ drawings: [] })),
    ]);
    if (token !== loadToken) return;
    S.bars = rows.map(toBar);
    S.renkoBox = null;
    refreshView();
    S.dataSource = provider ? PROVIDERS[provider].name : 'ClickHouse';
    S.exhausted = !info?.history && !!provider;
    S.warned = false;
    if (provider) openStream(provider, symbol, S.tf, token);
    app.htfCache.clear();
    applyPriceFormat();
    setMainData();
    fitPriceScaleOnce();
    requestAnimationFrame(positionPaneLegends); // price scale width depends on the new prices
    app.dm.setDrawings(dr.drawings);
    showMsg(S.bars.length ? '' : 'No data for this symbol/timeframe');
    const n = S.view.length;
    if (range) applyRange(range);
    else if (anchor) await applyAnchor(anchor, token);
    else app.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 10 });
    if (token !== loadToken) return;
    await refreshIndicators(true);
    if (token !== loadToken) return;
    updateLegendValues(null);
    setStatus('ok');
  } catch (e) {
    if (token !== loadToken) return;
    setStatus('err', e.message);
    showMsg('Failed to load data: ' + e.message);
  }
  // Opening the app only restores the saved layout; saving it again could overwrite changes made in another tab
  if (!initial) app.saveLayout();
  app.emit('symbolChanged', symbol, info);
}
app.setSymbol = setSymbol;

export async function setTf(tf) {
  if (!TF_SEC[tf] || tf === S.tf) return;
  const anchor = viewAnchor();
  S.tf = tf;
  await setSymbol(S.symbol, { anchor });
}

// What the chart shows, independent of the timeframe: the date in the middle of the screen (null when
// the latest bar is on screen, then the chart stays at the latest bar), how many bars fit on the screen
// and the space right of the latest bar.
function viewAnchor() {
  const r = app.chart.timeScale().getVisibleLogicalRange(), n = S.view.length;
  if (!r || !n) return null;
  const width = r.to - r.from;
  if (r.to >= n - 1) return { time: null, width, offset: r.to - (n - 1) };
  const i = Math.max(0, Math.min(n - 1, Math.round((r.from + r.to) / 2)));
  return { time: S.view[i].time, width };
}

const MAX_ANCHOR_LOADS = 12; // ~180k bars at most (history chunks double up to 20000 bars)

// Load history until the chart time `time` (timezone-shifted, like S.view) is loaded. False when it
// could not be reached: no older data, or further back than MAX_ANCHOR_LOADS history loads.
async function ensureHistory(time, token = loadToken) {
  for (let k = 0; k < MAX_ANCHOR_LOADS && S.view.length && S.view[0].time > time && !S.exhausted; k++) {
    const first = S.bars[0]?.time;
    await loadMore({ refresh: false });
    if (token !== loadToken || S.bars[0]?.time === first) break;
  }
  return !!S.view.length && S.view[0].time <= time;
}

// Index of the bar that contains the chart time: the last bar starting at or before it (0 if none).
function barAt(time) {
  let lo = 0, hi = S.view.length - 1;
  if (hi < 0 || S.view[0].time > time) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S.view[m].time <= time) lo = m; else hi = m - 1; }
  return lo;
}

// After a timeframe change: show the same date in the middle, with the same number of bars on screen.
// Older dates first need their history loaded (the chart starts with the latest bars).
async function applyAnchor({ time, width, offset }, token) {
  const ts = app.chart.timeScale();
  if (time == null) {
    const n = S.view.length;
    ts.setVisibleLogicalRange({ from: n - 1 + offset - width, to: n - 1 + offset });
    return;
  }
  await ensureHistory(time - (width / 2) * TF_SEC[S.tf], token);
  if (token !== loadToken || !S.view.length) return;
  const i = barAt(time);
  ts.setVisibleLogicalRange({ from: i - width / 2, to: i + width / 2 });
}

// "Go to": a date (in the chart's timezone) in the middle of the screen, or a date range filling it.
// Times are chart times (UTC + timezone offset, like S.view). Returns an error text or null.
async function goTo(from, to = null) {
  if (!S.view.length) return 'No data';
  const token = loadToken, ts = app.chart.timeScale();
  const r = ts.getVisibleLogicalRange();
  const width = r ? r.to - r.from : 150;
  const start = to == null ? from - (width / 2) * TF_SEC[S.tf] : from;
  const before = S.bars.length;
  const ok = await ensureHistory(start, token);
  if (token !== loadToken) return null;
  if (S.bars.length !== before) refreshIndicators();
  if (!ok && S.view[0].time > (to ?? from)) {
    return S.exhausted
      ? `No ${TF_NAME[S.tf]} data before ${fmtTime(S.view[0].time)}.`
      : `${fmtTime(from)} is too far back for the ${TF_NAME[S.tf]} timeframe; choose a higher timeframe.`;
  }
  if (to == null) {
    const i = barAt(from);
    ts.setVisibleLogicalRange({ from: i - width / 2, to: i + width / 2 });
  } else {
    const i0 = barAt(from), i1 = Math.max(i0, barAt(to));
    ts.setVisibleLogicalRange({ from: i0 - 0.5, to: i1 + 0.5 });
  }
  return null;
}
app.goTo = goTo;

app.setTf = setTf;

let loadingMore = false;
// Recompute indicators after history loads only when scrolling has paused for a moment, so a
// fast scroll through several loads costs one recompute instead of one per load.
let lastScroll = 0, scrollRefresh = null;
function refreshAfterScroll() {
  if (scrollRefresh) return;
  const wait = () => {
    const idle = performance.now() - lastScroll;
    if (idle < 150 || loadingMore) { scrollRefresh = setTimeout(wait, Math.max(30, 150 - idle)); return; }
    scrollRefresh = null;
    refreshIndicators();
  };
  wait();
}
app.indicatorsPending = () => !!scrollRefresh;

// One history load at a time; a caller that comes while one runs waits for it.
let morePromise = null, moreToken = 0;
function loadMore(opts) {
  if (morePromise && moreToken !== loadToken) return morePromise.then(() => loadMore(opts)); // previous symbol / timeframe
  if (!morePromise) {
    moreToken = loadToken;
    morePromise = loadMoreNow(opts).finally(() => { morePromise = null; });
  }
  return morePromise;
}

async function loadMoreNow({ refresh = true } = {}) {
  if (S.exhausted || !S.bars.length) return;
  loadingMore = true;
  const token = loadToken;
  try {
    const first = S.bars[0].time - S.tzOffset;
    // Every load re-sends all series to the chart, so load as much as is already loaded (doubling):
    // the total work grows linearly with the history instead of quadratically.
    const want = Math.max(MORE_BARS, Math.min(MAX_MORE_BARS, S.bars.length));
    const res = await api.bars(S.symbol, S.tf, first, want);
    if (token !== loadToken) return;
    if (!res.bars.length) {
      S.exhausted = true;
      noHistoryWarning(first);
      return;
    }
    const older = res.bars.map(toBar).filter(b => b.time < S.bars[0].time);
    if (res.bars.length < want) S.exhausted = true;
    const gap = S.bars[0].time - older[older.length - 1].time;
    if (gap > TF_SEC[S.tf] * 1.5) {
      toast(`ClickHouse data ends at ${fmtTime(older[older.length - 1].time)}; there is a gap of ${Math.round(gap / TF_SEC[S.tf])} bars up to the live data.`, 'info', 'Data gap', 7000);
    }
    const ts = app.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const before = S.view.length;
    S.bars = older.concat(S.bars);
    refreshView();
    setMainData();
    const added = S.view.length - before;
    if (r) ts.setVisibleLogicalRange({ from: r.from + added, to: r.to + added });
    app.dm.update();
    if (refresh) refreshAfterScroll(); // indicators follow once the user stops scrolling (results stay aligned meanwhile)
  } catch (e) {
    toast('Failed to load history: ' + e.message, 'error');
  } finally {
    loadingMore = false;
  }
}

function noHistoryWarning(beforeUtc) {
  const key = `${S.symbol}|${S.tf}`;
  if (S.warned === key) return;
  S.warned = key;
  toast(`No ${app.symbolName(S.symbol)} ${TF_NAME[S.tf]} data on ClickHouse before ${fmtTime(beforeUtc + S.tzOffset)}.`, 'error', 'No data on ClickHouse', 6000);
}

function liveProvider(symbol) {
  const info = S.symMap.get(symbol);
  const src = S.sources?.[app.symbolSource(symbol)];
  return src && src.live && info && info.live !== false ? src.live : null;
}

// ---- realtime kline websocket
let stream = null;
let indTimer = null;
function closeStream() { if (stream) { stream.close(); stream = null; } }

function openStream(provider, symbol, tf, token) {
  stream = klineStream(provider, app.symbolName(symbol), tf, (row, closed) => {
    if (token !== loadToken || !S.bars.length) return;
    const b = toBar(row);
    const last = S.bars[S.bars.length - 1];
    if (b.time < last.time) return;
    const appended = b.time > last.time;
    if (appended) S.bars.push(b); else S.bars[S.bars.length - 1] = b;
    refreshView();
    setMainData(false);
    if (appended) app.dm.update();
    // Indicators: recompute at most once per second (custom scripts run in a worker)
    if (!indTimer) indTimer = setTimeout(() => {
      indTimer = null;
      // while the user scrolls, wait for the pause (one recompute for all history loads and ticks)
      if (performance.now() - lastScroll < 150 || scrollRefresh) { refreshAfterScroll(); return; }
      refreshIndicators().then(() => updateLegendValues(lastCrosshair));
    }, appended || closed ? 50 : 1000);
    updateLegendValues(lastCrosshair);
    app.emit('tick', symbol, b);
  }, (state) => setStatus(state === 'open' ? 'ok' : state === 'connecting' ? 'busy' : 'err', state === 'open' ? '' : `Websocket: ${state}`));
}

// Poll for new/updated bars when the source has no live feed (ClickHouse only).
async function pollLatest() {
  if (!S.bars.length || document.hidden || liveProvider(S.symbol)) return;
  const token = loadToken;
  try {
    const res = await api.bars(S.symbol, S.tf, null, 3);
    if (token !== loadToken || !res.bars.length) return;
    let appended = false, changed = false;
    for (const r of res.bars) {
      const b = toBar(r);
      const last = S.bars[S.bars.length - 1];
      if (b.time === last.time) {
        if (b.close !== last.close || b.high !== last.high || b.low !== last.low || b.volume !== last.volume) { S.bars[S.bars.length - 1] = b; changed = true; }
      } else if (b.time > last.time) { S.bars.push(b); appended = true; }
    }
    if (appended || changed) {
      refreshView();
      setMainData(appended);
      await refreshIndicators();
      updateLegendValues(null);
    }
    setStatus('ok');
  } catch (e) {
    setStatus('err', e.message);
  }
}

function setStatus(kind, msg) {
  const d = $('#status');
  d.className = 'status-dot ' + kind;
  if (kind === 'ok' && S.bars.length && liveProvider(S.symbol)) {
    d.title = `Live: ${S.dataSource} (websocket connected)`;
  } else if (kind === 'ok' && S.bars.length) {
    const last = S.bars[S.bars.length - 1];
    const ageH = (Date.now() / 1000 - (last.time - S.tzOffset)) / 3600;
    d.title = `Last bar: ${fmtTime(last.time)}` + (ageH > 2 ? ` (≈${ageH > 48 ? Math.round(ageH / 24) + ' days' : Math.round(ageH) + ' hours'} ago, data is stale)` : '');
    if (ageH > Math.max(2, 3 * TF_SEC[S.tf] / 3600)) d.className = 'status-dot busy';
  } else d.title = msg || '';
}

function applyRange([, , span]) {
  const n = S.view.length;
  if (!n) return;
  const last = S.view[n - 1].time;
  let from;
  if (span === 'all') from = S.view[0].time;
  else if (span === 'ytd') { const d = new Date(last * 1000); from = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000; }
  else from = last - span;
  let i = S.view.findIndex(b => b.time >= from);
  if (i < 0) i = 0;
  app.chart.timeScale().setVisibleLogicalRange({ from: i, to: n + 3 });
}

// ======================================================================= indicators
function makeHtfBars(rows) { return rows.map(toBar); }

async function computeIndicator(inst) {
  if (inst.type === 'custom') {
    const sc = S.scripts.find(s => s.id === inst.script_id);
    if (!sc) return { error: 'Script not found (deleted?)', name: inst.name || 'Custom' };
    let res;
    try {
      res = await runCustom(sc.code, inst.params || {});
    } catch (e) {
      return { error: e.message + (e.line ? ` (line ${e.line})` : ''), name: sc.name };
    }
    inst.inputs = res.inputs;
    inst.name = res.meta.name || sc.name;
    return {
      name: res.meta.name || sc.name, overlay: res.meta.overlay, precision: res.meta.precision, inputs: res.inputs,
      plots: res.plots.map(p => ({ ...p, color: inst.colors?.[p.k] || p.color })),
      hlines: res.hlines, shapes: res.shapes.map(s => ({ ...s, color: inst.colors?.[s.k] || s.color })),
      fills: res.fills || [],
    };
  }
  const def = INDICATORS[inst.type];
  if (!def) return { error: 'Unknown indicator', name: inst.type };
  const p = { ...defaultParams(inst.type), ...(inst.params || {}) };
  for (const x of def.params) if (typeof x.d === 'number') p[x.k] = Number(p[x.k]);
  const vals = def.calc(S.view, p);
  const col = { ...defaultColors(inst.type), ...(inst.colors || {}) };
  const plots = def.plots.map(pl => {
    const data = vals[pl.k];
    let colors = null;
    if (pl.kind === 'histogram') {
      const c1 = col[pl.k], c2 = col[pl.k + '_2'] || c1;
      colors = inst.type === 'volume' ? vals._up.map(u => (u ? c1 : c2)) : data.map(v => (v == null ? null : v >= 0 ? c1 : c2));
    }
    return { k: pl.k, title: pl.l, color: col[pl.k], colors, width: pl.w || 1, style: pl.kind === 'histogram' ? 'columns' : pl.dots ? 'circles' : 'line', data };
  });
  return { name: indLabel({ ...inst, params: p }), overlay: def.overlay, volume: !!def.volume, plots, hlines: (def.levels || []).map(v => ({ value: v, color: '#787b86' })), shapes: [] };
}

// Run user code in the sandbox on the chart bars; fetches security() timeframes on demand.
// Timeframes a script asked for via security(), remembered per code + chart timeframe, so the data is
// ready before the first run (otherwise every recompute ran the script twice).
const htfNeeds = new Map();
export async function runCustom(code, params = {}) {
  const env = { tf: S.tf, tfSec: TF_SEC[S.tf], tfSecs: TF_SEC, htf: {} };
  const key = S.tf + '|' + code;
  const known = htfNeeds.get(key) || [];
  for (const tf of known) env.htf[tf] = await getHtfBars(tf);
  for (let round = 0; round < 4; round++) {
    const res = await app.sandbox.run(code, S.view, params, env);
    if (!res.requests.length) return res;
    for (const tf of res.requests) {
      if (!TF_SEC[tf]) throw new Error(`security(): unknown timeframe "${tf}"`);
      env.htf[tf] = await getHtfBars(tf);
    }
    htfNeeds.set(key, Object.keys(env.htf));
    if (htfNeeds.size > 200) htfNeeds.delete(htfNeeds.keys().next().value);
  }
  throw new Error('security() data unavailable');
}
app.runCustom = runCustom;

// Higher-timeframe bars for security(), cached per symbol/timeframe and extended incrementally:
// older history comes from ClickHouse only, the exchange is asked only for newly closed HTF bars.
async function getHtfBars(tf) {
  const key = `${S.symbol}|${tf}`;
  const sec = TF_SEC[tf];
  const firstUtc = S.bars[0].time - S.tzOffset, lastUtc = S.bars[S.bars.length - 1].time - S.tzOffset;
  const provider = liveProvider(S.symbol);
  let e = app.htfCache.get(key);
  if (!e) {
    const need = Math.min(5000, Math.ceil((lastUtc - firstUtc) / sec) + 400);
    let rows = [];
    if (provider) rows = await restKlines(provider, app.symbolName(S.symbol), tf, { limit: Math.min(1500, need) });
    if (!rows.length || rows[0][0] > firstUtc - 300 * sec) {
      const older = await api.bars(S.symbol, tf, rows.length ? rows[0][0] : lastUtc + sec * 2, need).then(r => r.bars).catch(() => []);
      rows = older.filter(r => !rows.length || r[0] < rows[0][0]).concat(rows);
    }
    e = { rows, exhausted: false };
    app.htfCache.set(key, e);
  } else {
    let changed = false;
    // history scrolled back: prepend older HTF bars (warm-up of 300 bars for long MAs)
    if (!e.exhausted && e.rows.length && e.rows[0][0] > firstUtc - 300 * sec) {
      const need = Math.min(5000, Math.ceil((e.rows[0][0] - firstUtc) / sec) + 400);
      const older = await api.bars(S.symbol, tf, e.rows[0][0], need).then(r => r.bars).catch(() => []);
      const add = older.filter(r => r[0] < e.rows[0][0]);
      if (!add.length) e.exhausted = true;
      else { e.rows = add.concat(e.rows); changed = true; }
    }
    // a new HTF bar has opened since the last fetch: refresh the tail (one small request per HTF bar)
    const lastRow = e.rows[e.rows.length - 1];
    if (provider && lastRow && lastUtc >= lastRow[0] + sec) {
      const tail = await restKlines(provider, app.symbolName(S.symbol), tf, { limit: 3 }).catch(() => []);
      if (tail.length) { e.rows = e.rows.filter(r => r[0] < tail[0][0]).concat(tail); changed = true; }
    }
    if (!changed && e.bars) return e.bars;
  }
  e.bars = makeHtfBars(e.rows);
  return e.bars;
}

function sigOf(items) {
  return items.map(({ inst, res }) => [inst.id, inst.visible ? 1 : 0, res.error ? 'e' : `${res.overlay ? 1 : 0}${res.volume ? 'v' : ''}:${res.plots.map(p => p.k + p.style).join(',')}:${res.hlines.length}:${res.shapes.length}:${(res.fills || []).length}`].join('/')).join('|') + '#' + S.chartType;
}

export async function refreshIndicators(force = false) {
  const token = ++app.ind.token;
  const insts = S.indicators;
  const t0 = S.view[0]?.time;
  const results = await Promise.all(insts.map(async inst => {
    try { return await computeIndicator(inst); } catch (e) { console.error(e); return { error: e.message, name: inst.type }; }
  }));
  if (token !== app.ind.token) return;
  // Older history was prepended while computing: these arrays no longer line up with the bars.
  if (S.view[0]?.time !== t0) return refreshIndicators(force);
  for (const r of results) r.t0 = t0;
  const items = insts.map((inst, i) => ({ inst, res: results[i] }));
  const sig = sigOf(items);
  // re-creating the price series (chart type, style, symbol load) puts its pane back on top
  const rebuild = force || sig !== app.ind.sig || mainIdx() !== (app.ind.mainAt || 0);
  if (rebuild) rebuildIndicatorSeries(items);
  else updateIndicatorData(items);
  app.ind.sig = sig;
  // Rebuild the legend DOM only when its content changes: re-creating it on every live tick
  // dropped the hover state, so the legend buttons vanished under a resting mouse pointer.
  const lkey = legendKey();
  if (rebuild || lkey !== app.ind.legendKey) renderLegend();
  updateLegendValues(null);
}
app.refreshIndicators = refreshIndicators;

/**
 * Index offset between S.view and an indicator result: results are computed on the bars of that
 * moment; when older history is prepended afterwards, view index i maps to result index i - off.
 */
function resOff(res) {
  const t0 = res && res.t0, v = S.view;
  if (t0 == null || !v.length || v[0].time === t0) return 0;
  let lo = 0, hi = v.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (v[m].time < t0) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * How a plot is sent to the chart. 'const': a single value on every bar with one color (Pine level
 * lines such as plot(60)): two points span the whole history, an autoscale hint keeps the level in
 * the pane range. 'dots': circles/cross plots that are mostly empty: only bars with a value are sent.
 */
function plotMode(p) {
  if (p.style === 'circles' || p.style === 'cross' || p.style === 'dots') return 'dots';
  if ((p.style === 'line' || p.style === 'stepline') && !p.colors) {
    let v = null, first = -1, cnt = 0;
    for (let i = 0; i < p.data.length; i++) {
      const x = p.data[i];
      if (x == null) continue;
      if (v === null) { v = x; first = i; } else if (x !== v) return null;
      cnt++;
    }
    if (cnt >= 2 && first === p.data.findIndex(x => x != null)) { p.constValue = v; return 'const'; }
  }
  return null;
}

function point(plot, i) {
  const t = S.view[i].time, v = plot.data[i];
  if (v == null) return { time: t };
  const c = plot.colors && plot.colors[i];
  if (!c) return { time: t, value: v };
  if (plot.style === 'area') return { time: t, value: v, topLineColor: c, bottomLineColor: c, topFillColor1: c, topFillColor2: c, bottomFillColor1: c, bottomFillColor2: c };
  return { time: t, value: v, color: c };
}

// Push a plot to its series: only the changed last bar on live ticks (cheap), everything otherwise.
function syncSeries(s, prev, p) {
  const n = p.data.length;
  p.mode = plotMode(p);
  if (p.mode === 'const' || prev?.mode === 'const') {
    // two points only: cheap to re-send; keep the autoscale hint in line with the value
    if (p.mode !== prev?.mode || p.constValue !== prev?.constValue || n !== prev?.data.length) {
      s.applyOptions({ autoscaleInfoProvider: constScale(p) });
      s.setData(seriesData(p));
    }
    return;
  }
  if (!prev || prev.data.length !== n || prev.style !== p.style || n > S.view.length) { s.setData(seriesData(p)); return; }
  let k = n;
  for (let i = 0; i < n; i++) {
    if (prev.data[i] !== p.data[i] || (p.colors && (!prev.colors || prev.colors[i] !== p.colors[i]))) { k = i; break; }
  }
  if (k === n) return;
  if (k === n - 1) s.update(point(p, n - 1));
  else s.setData(seriesData(p));
}

const constScale = (p) => (p.mode === 'const' ? () => ({ priceRange: { minValue: p.constValue, maxValue: p.constValue } }) : undefined);

function seriesData(plot) {
  const n = Math.min(plot.data.length, S.view.length);
  const mode = plot.mode;
  if (mode === 'const') {
    let first = 0, last = n - 1;
    while (first < n && plot.data[first] == null) first++;
    while (last > first && plot.data[last] == null) last--;
    return first < last ? [point(plot, first), point(plot, last)] : [];
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (mode === 'dots' && plot.data[i] == null) continue; // no line to break: empty bars are not needed
    out.push(point(plot, i));
  }
  return out;
}

// plotshape() markers, drawn like Pine: every shape type, sizes, text, and locations
//   top / bottom          fixed at the pane edge (do not move with the data)
//   abovebar / belowbar   above the bar high / below the bar low (price pane) or above / below the
//                         indicator's first plot (own pane); several shapes on one bar stack
//   absolute              at the series value
const SHAPE_SIZE = { tiny: 6, small: 9, auto: 9, normal: 13, large: 19, huge: 27 };
const SHAPE_GAP = 4;

function drawShape(ctx, shape, x, y, s, color) {
  const h = s / 2;
  ctx.fillStyle = color; ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'diamond': ctx.moveTo(x, y - h * 1.15); ctx.lineTo(x + h, y); ctx.lineTo(x, y + h * 1.15); ctx.lineTo(x - h, y); break;
    case 'triangleup': ctx.moveTo(x, y - h); ctx.lineTo(x + h, y + h); ctx.lineTo(x - h, y + h); break;
    case 'triangledown': ctx.moveTo(x, y + h); ctx.lineTo(x + h, y - h); ctx.lineTo(x - h, y - h); break;
    case 'arrowup': case 'arrowdown': {
      const d = shape === 'arrowup' ? 1 : -1, w = h * 0.4;
      ctx.moveTo(x, y - d * h); ctx.lineTo(x + h, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + d * h);
      ctx.lineTo(x - w, y + d * h); ctx.lineTo(x - w, y); ctx.lineTo(x - h, y);
      break;
    }
    case 'square': ctx.rect(x - h, y - h, s, s); break;
    case 'cross': case 'xcross': {
      ctx.lineWidth = Math.max(1.5, s / 5);
      const r = shape === 'cross' ? h : h * 0.8;
      if (shape === 'cross') { ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); }
      else { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
      ctx.stroke();
      return;
    }
    case 'flag':
      ctx.rect(x - h, y - h, Math.max(1, s / 8), s);
      ctx.moveTo(x - h, y - h); ctx.lineTo(x + h, y - h * 0.5); ctx.lineTo(x - h, y);
      break;
    default: ctx.arc(x, y, h, 0, Math.PI * 2);
  }
  ctx.closePath();
  ctx.fill();
}

function shapePrimitive(it, series, overlay) {
  let req = null;
  const prim = {
    attached: ({ requestUpdate }) => { req = requestUpdate; },
    detached: () => { req = null; },
    paneViews: () => views,
    update: () => req && req(),
  };
  const views = [{
    zOrder: () => 'top',
    renderer: () => ({
      draw: (target) => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const shapes = it.res.shapes || [];
        if (!shapes.length || !it.inst.visible) return;
        const ts = app.chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const off = resOff(it.res);
        const i0 = Math.max(off, Math.floor(range.from) - 1), i1 = Math.min(S.view.length - 1, Math.ceil(range.to) + 1);
        const ref = !overlay && it.res.plots?.[0]?.data;
        const Y = (v) => (v == null ? null : series.priceToCoordinate(v));
        const fs = 11;
        ctx.font = `${fs}px -apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;
        ctx.textAlign = 'center';
        for (let i = i0; i <= i1; i++) {
          const j = i - off;
          const x = ts.logicalToCoordinate(i);
          if (x == null || x < -20 || x > mediaSize.width + 20) continue;
          const stack = { top: 0, bottom: 0, abovebar: 0, belowbar: 0 };
          for (const sh of shapes) {
            if (!sh.data[j]) continue;
            const sz = SHAPE_SIZE[sh.size] || SHAPE_SIZE.auto, loc = sh.location;
            const color = (sh.colors && sh.colors[j]) || sh.color;
            if (!color || color === 'rgba(0,0,0,0)') continue;
            let y, dir; // dir: +1 text goes below the shape, -1 above
            if (loc === 'top') { y = SHAPE_GAP + stack.top + sz / 2; stack.top += sz + 2; dir = 1; }
            else if (loc === 'bottom') { y = mediaSize.height - SHAPE_GAP - stack.bottom - sz / 2; stack.bottom += sz + 2; dir = -1; }
            else if (loc === 'absolute') { y = Y(sh.values?.[j]); dir = 1; }
            else {
              const below = loc === 'belowbar';
              const b = S.view[i];
              const base = overlay ? Y(below ? b.low : b.high) : Y(ref ? ref[j] : null);
              if (base == null) continue;
              const k = below ? 'belowbar' : 'abovebar';
              y = below ? base + SHAPE_GAP + stack[k] + sz / 2 : base - SHAPE_GAP - stack[k] - sz / 2;
              stack[k] += sz + 2;
              dir = below ? 1 : -1;
            }
            if (y == null) continue;
            const label = sh.shape === 'labelup' || sh.shape === 'labeldown';
            if (label) {
              // Pine labels: a box with a pointer towards the bar, text inside
              const t = String(sh.text || ''), w = Math.max(sz, ctx.measureText(t).width + 8), hh = Math.max(sz, fs + 6);
              const up = sh.shape === 'labelup', p = 4;
              const top = up ? y - hh / 2 + p : y - hh / 2 - p;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.rect(x - w / 2, top, w, hh);
              if (up) { ctx.moveTo(x - p, top); ctx.lineTo(x, top - p); ctx.lineTo(x + p, top); }
              else { ctx.moveTo(x - p, top + hh); ctx.lineTo(x, top + hh + p); ctx.lineTo(x + p, top + hh); }
              ctx.fill();
              if (t) { ctx.fillStyle = sh.textColor || '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, top + hh / 2); }
              continue;
            }
            drawShape(ctx, sh.shape, x, y, sz, color);
            if (sh.text) {
              ctx.fillStyle = sh.textColor || color;
              ctx.textBaseline = dir > 0 ? 'top' : 'bottom';
              ctx.fillText(sh.text, x, y + dir * (sz / 2 + 2));
            }
          }
        }
      }),
    }),
  }];
  series.attachPrimitive(prim);
  return prim;
}

// Draws ChartScript fill() areas between two series below the indicator lines.
// Columns are snapped to whole device pixels so neighbouring bars never overlap (no seams);
// runs of one solid color are drawn as a single polygon, gradient fills column by column.
// Pine's plot.style_histogram: a bar of `linewidth` pixels from 0 to the value, whatever the bar
// spacing (LWC's HistogramSeries fills the whole bar spacing, which is Pine's style_columns).
class PineHistogram {
  constructor() { this._data = null; this._opt = null; }
  renderer() { return this; }
  update(data, options) { this._data = data; this._opt = options; }
  priceValueBuilder(row) { return [0, row.value]; }
  isWhitespace(row) { return row.value == null; }
  defaultOptions() { return { color: '#2962ff', barWidth: 1 }; }
  destroy() {}
  draw(target, priceToCoordinate) {
    const d = this._data, o = this._opt;
    if (!d || !d.visibleRange) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      // at most the bar spacing minus a 1px gap, at least 1px
      const w = Math.max(1, Math.round(Math.min(o.barWidth, d.barSpacing - 1) * hr));
      const y0 = priceToCoordinate(0);
      if (y0 == null) return;
      const by0 = Math.round(y0 * vr);
      for (let i = d.visibleRange.from; i < d.visibleRange.to; i++) {
        const b = d.bars[i], v = b.originalData.value;
        if (v == null) continue;
        const y = priceToCoordinate(v);
        if (y == null) continue;
        const by = Math.round(y * vr), x = Math.round(b.x * hr) - Math.floor(w / 2);
        ctx.fillStyle = b.barColor || o.color; // LWC moves the item's `color` into barColor
        ctx.fillRect(x, Math.min(by, by0), w, Math.max(1, Math.abs(by - by0)));
      }
    });
  }
}

function fillPrimitive(it, series) {
  let req = null;
  const prim = {
    attached: ({ requestUpdate }) => { req = requestUpdate; },
    detached: () => { req = null; },
    paneViews: () => views,
    update: () => req && req(),
  };
  const NA = 'rgba(0,0,0,0)';
  const views = [{
    zOrder: () => 'bottom',
    renderer: () => ({
      draw: (target) => target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const fills = it.res.fills || [];
        if (!fills.length) return;
        const ts = app.chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        const off = resOff(it.res); // view index i -> result index i - off
        const i0 = Math.max(1 + off, Math.floor(range.from) - 1), i1 = Math.min(S.view.length - 1, Math.ceil(range.to) + 1);
        const X = (i) => { const x = ts.logicalToCoordinate(i); return x == null ? null : Math.round(x * hr); };
        const Y = (v) => { const y = series.priceToCoordinate(v); return y == null ? null : y * vr; };
        for (const f of fills) {
          let run = null; // solid fill: [{x, ya, yb}], color
          const flush = () => {
            if (run && run.pts.length > 1) {
              ctx.fillStyle = run.color;
              ctx.beginPath();
              run.pts.forEach((p, k) => (k ? ctx.lineTo(p.x, p.ya) : ctx.moveTo(p.x, p.ya)));
              for (let k = run.pts.length - 1; k >= 0; k--) ctx.lineTo(run.pts[k].x, run.pts[k].yb);
              ctx.closePath(); ctx.fill();
            }
            run = null;
          };
          for (let i = i0; i <= i1; i++) {
            const j = i - off;
            const a0 = f.a[j - 1], a1 = f.a[j], b0 = f.b[j - 1], b1 = f.b[j];
            const x0 = X(i - 1), x1 = X(i);
            const ok = a0 != null && a1 != null && b0 != null && b1 != null && x0 != null && x1 != null;
            const ya0 = ok && Y(a0), ya1 = ok && Y(a1), yb0 = ok && Y(b0), yb1 = ok && Y(b1);
            if (!ok || [ya0, ya1, yb0, yb1].some(v => v == null || v === false)) { flush(); continue; }
            if (f.gradient) {
              const tc = (f.topColors ? f.topColors[j] : f.topColor) || NA, bc = (f.bottomColors ? f.bottomColors[j] : f.bottomColor) || NA;
              if (tc === NA && bc === NA) continue;
              const yt = f.top[j] != null ? Y(f.top[j]) : null, yb = f.bottom[j] != null ? Y(f.bottom[j]) : null;
              if (yt == null || yb == null) continue;
              let g;
              if (Math.abs(yb - yt) < 0.5) g = tc;
              else { g = ctx.createLinearGradient(0, yt, 0, yb); g.addColorStop(0, tc); g.addColorStop(1, bc); }
              ctx.fillStyle = g;
              ctx.beginPath(); ctx.moveTo(x0, ya0); ctx.lineTo(x1, ya1); ctx.lineTo(x1, yb1); ctx.lineTo(x0, yb0); ctx.closePath(); ctx.fill();
              continue;
            }
            const c = (f.colors ? f.colors[j] : f.color) || NA;
            if (c === NA) { flush(); continue; }
            if (!run || run.color !== c) { flush(); run = { color: c, pts: [{ x: x0, ya: ya0, yb: yb0 }] }; }
            run.pts.push({ x: x1, ya: ya1, yb: yb1 });
          }
          flush();
        }
      }),
    }),
  }];
  series.attachPrimitive(prim);
  return prim;
}

function clearIndicatorSeries() {
  for (const it of app.ind.items) {
    if (it.shapePrim) { try { it.shapeTarget.detachPrimitive(it.shapePrim); } catch { /* */ } }
    if (it.fillPrim) { try { it.fillTarget.detachPrimitive(it.fillPrim); } catch { /* */ } }
    for (const s of it.series || []) { try { app.chart.removeSeries(s); } catch { /* */ } }
  }
  app.ind.items = [];
  if (app.mainSeries && mainIdx() !== 0) app.mainSeries.getPane().moveTo(0);
  while (app.chart.panes().length > 1) app.chart.removePane(app.chart.panes().length - 1);
}

// Axis format of an indicator pane: indicator(..., { precision }) if given, else 2 decimals for
// values of 1 and more (oscillators), more for small values (e.g. MACD of a low-priced coin).
function paneFormat(res) {
  let d = res.precision;
  if (d == null) {
    const vals = [];
    for (const p of res.plots) {
      for (let i = Math.max(0, p.data.length - 500); i < p.data.length; i++) {
        const v = p.data[i];
        if (v != null && v !== 0 && Number.isFinite(v)) vals.push(Math.abs(v));
      }
    }
    vals.sort((a, b) => a - b);
    const m = vals.length ? vals[vals.length >> 1] : 1;
    d = m >= 1 ? 2 : Math.min(8, Math.ceil(-Math.log10(m)) + 2);
  }
  d = Math.max(0, Math.min(10, Math.round(d)));
  return { type: 'price', precision: d, minMove: Math.pow(10, -d) };
}

function rebuildIndicatorSeries(items) {
  const c = app.chart;
  clearIndicatorSeries();
  let paneIdx = 0;
  for (const { inst, res } of items) {
    const it = { inst, res, series: [], pane: null, own: false };
    app.ind.items.push(it);
    if (!inst.visible || res.error) continue;
    const pane = res.overlay ? 0 : ++paneIdx;
    it.pane = pane;
    it.own = pane > 0;
    const scaleId = res.volume ? `vol_${inst.id}` : 'right';
    for (const p of res.plots) {
      const common = { priceScaleId: scaleId, lastValueVisible: !res.volume, priceLineVisible: false, title: '', crosshairMarkerVisible: false }; // no dots on the crosshair
      if (!res.volume && !res.overlay) common.priceFormat = paneFormat(res);
      if (res.overlay && !res.volume) common.priceFormat = { type: 'price', precision: S.priceDecimals, minMove: Math.pow(10, -S.priceDecimals) };
      if (res.volume) common.priceFormat = { type: 'volume' };
      let s;
      p.mode = plotMode(p);
      if (p.mode === 'const') common.autoscaleInfoProvider = constScale(p);
      if (p.style === 'histogram') s = c.addCustomSeries(new PineHistogram(), { ...common, color: p.color, barWidth: Math.max(1, p.width || 1) }, pane);
      else if (p.style === 'columns') s = c.addSeries(LWC.HistogramSeries, { ...common, color: p.color, base: 0 }, pane);
      // Pine area plots fill to zero with one flat color (histbase 0), not to the pane bottom
      else if (p.style === 'area') s = c.addSeries(LWC.BaselineSeries, { ...common, baseValue: { type: 'price', price: 0 }, topLineColor: p.color, bottomLineColor: p.color, topFillColor1: p.color, topFillColor2: p.color, bottomFillColor1: p.color, bottomFillColor2: p.color, lineWidth: p.width }, pane);
      else if (p.style === 'circles' || p.style === 'cross' || p.style === 'dots') s = c.addSeries(LWC.LineSeries, { ...common, color: p.color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: Math.max(1.5, p.width), lastValueVisible: false }, pane);
      else s = c.addSeries(LWC.LineSeries, { ...common, color: p.color, lineWidth: Math.min(4, p.width), lineType: p.style === 'stepline' ? 1 : 0 }, pane);
      s.setData(seriesData(p));
      it.series.push(s);
    }
    if (res.volume) c.priceScale(scaleId, 0).applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    // A pane with only shapes needs a carrier series
    if (!it.series.length && (res.shapes.length || res.hlines.length)) {
      const s = c.addSeries(LWC.LineSeries, { lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, pane);
      s.setData(S.view.map(b => ({ time: b.time, value: 0 })));
      it.series.push(s);
    }
    for (const h of res.hlines) {
      it.series[0]?.createPriceLine({ price: h.value, color: h.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    }
    if ((res.fills || []).length) {
      const target = it.series[0] || app.mainSeries;
      it.fillTarget = target;
      it.fillPrim = fillPrimitive(it, target);
    }
    if (res.shapes.length) {
      const target = res.overlay ? app.mainSeries : it.series[0];
      if (target) { it.shapeTarget = target; it.shapePrim = shapePrimitive(it, target, !!res.overlay); }
    }
  }
  // Price pane position among the panes (indicator panes moved above it).
  // S.mainPos itself is kept: an early run before data arrives may have fewer panes.
  app.ind.mainAt = Math.max(0, Math.min(S.mainPos || 0, paneIdx));
  if (!app.ind.items.some(x => x.inst.id === app.maxPane && x.own)) app.maxPane = null;
  placeMainPane();
}

// Panes created in this tick are not known to the chart model until it lays them out
// ("Invalid pane index"), so the move is retried on the next frames.
function placeMainPane(tries = 0) {
  const want = app.ind.mainAt || 0;
  if (app.mainSeries && mainIdx() !== want) {
    try { app.mainSeries.getPane().moveTo(want); } catch (e) {
      if (tries < 10) { requestAnimationFrame(() => placeMainPane(tries + 1)); return; }
      console.warn('pane move failed', e);
    }
  }
  for (const it of app.ind.items) {
    if (it.own && it.series[0]) it.pane = it.series[0].getPane().paneIndex();
    else if (!it.own && it.series.length) it.pane = mainIdx();
  }
  resetPaneScales();
  applyPaneStretch();
  if (tries) renderLegend(); // pane indices changed after the legend was drawn
}

function updateIndicatorData(items) {
  items.forEach(({ res }, i) => {
    const it = app.ind.items[i];
    if (!it) return;
    const prev = it.res;
    it.res = res;
    if (!it.inst.visible || res.error) return;
    res.plots.forEach((p, j) => { if (it.series[j]) syncSeries(it.series[j], prev?.plots?.[j], p); });
    it.fillPrim?.update();
    it.shapePrim?.update();
  });
}

export function addIndicator(type, extra = {}) {
  const lim = S.plan?.limits?.indicators_per_chart;
  if (lim != null && S.indicators.length >= lim) {
    toast(`Your ${S.plan.name} plan allows ${lim} indicators per chart.`, 'error', 'Plan limit');
    return null;
  }
  const inst = {
    id: Math.random().toString(36).slice(2, 10), type, visible: true,
    params: type === 'custom' ? {} : defaultParams(type), colors: type === 'custom' ? {} : defaultColors(type), ...extra,
  };
  S.indicators.push(inst);
  app.saveLayout();
  refreshIndicators();
  return inst;
}
app.addIndicator = addIndicator;

app.removeIndicator = (id) => {
  // a pane above the price pane disappears: the price pane moves up one slot
  const seq = paneOrder(), k = seq.findIndex(x => x !== 'main' && x.id === id);
  if (k >= 0 && k < seq.indexOf('main')) S.mainPos = Math.max(0, (S.mainPos || 0) - 1);
  S.indicators = S.indicators.filter(i => i.id !== id);
  app.saveLayout();
  refreshIndicators();
};

app.indicatorResult = (id) => app.ind.items.find(it => it.inst.id === id)?.res;

// ======================================================================= legend
let legendRefs = [];
let lastCrosshair = null;
function paramsText(inst, res) {
  if (inst.type === 'custom') {
    const ins = res.inputs || inst.inputs || [];
    return ins.map(i => { const v = (inst.params || {})[i.k] ?? i.d; return typeof v === 'boolean' ? '' : v; }).filter(v => v !== '').join(' ');
  }
  return '';
}

// Visual pane order: indicator panes in S.indicators order with the price pane ('main') at S.mainPos.
function paneOrder() {
  const own = S.indicators.filter(i => app.ind.items.find(it => it.inst === i)?.own);
  const seq = own.slice();
  seq.splice(Math.min(S.mainPos || 0, own.length), 0, 'main');
  return seq;
}

function canMovePane(inst, dir) {
  const seq = paneOrder(), k = seq.indexOf(inst);
  return k >= 0 && k + dir >= 0 && k + dir < seq.length;
}

function moveIndicatorPane(inst, dir) {
  const seq = paneOrder(), k = seq.indexOf(inst), j = k + dir;
  if (k < 0 || j < 0 || j >= seq.length) return;
  [seq[k], seq[j]] = [seq[j], seq[k]];
  S.mainPos = seq.indexOf('main');
  // keep the indicators' own order in S.indicators (overlays stay where they are)
  const own = seq.filter(x => x !== 'main');
  let n = 0;
  S.indicators = S.indicators.map(i => (own.includes(i) ? own[n++] : i));
  app.saveLayout();
  refreshIndicators(true);
}

function toggleCollapse(it) {
  it.inst.collapsed = !it.inst.collapsed;
  if (it.inst.collapsed && app.maxPane === it.inst.id) app.maxPane = null;
  app.saveLayout();
  applyPaneStretch();
  renderLegend();
}

function toggleMaximize(it) {
  app.maxPane = app.maxPane === it.inst.id ? null : it.inst.id;
  if (app.maxPane) it.inst.collapsed = false;
  applyPaneStretch();
  renderLegend();
}

function applyPaneStretch() {
  const panes = app.chart.panes();
  if (panes.length < 2) return;
  const maxIt = app.ind.items.find(x => x.inst.id === app.maxPane && x.own);
  const m = mainIdx();
  const collapsed = new Set(app.ind.items.filter(x => x.own && x.inst.collapsed).map(x => x.pane));
  const open = panes.length - collapsed.size;
  const total = panes.reduce((a, p) => a + p.getHeight(), 0) || $('#chart').clientHeight;
  const unit = total / Math.max(1, open + (open > 1 ? 1.2 : 0));
  for (let i = 0; i < panes.length; i++) {
    if (maxIt) panes[i].setStretchFactor(i === maxIt.pane ? 1 : 0.0001);
    else if (collapsed.has(i)) panes[i].setStretchFactor(28 / unit); // just the legend row stays visible
    else panes[i].setStretchFactor(i === m ? Math.max(2, 3.2 - 0.3 * (panes.length - 2)) : 1);
  }
  requestAnimationFrame(positionPaneLegends);
}

function legendKey() {
  return JSON.stringify([S.symbol, S.tf, S.dataSource, app.maxPane, S.mainPos, app.ind.items.map(({ inst, res, pane }) =>
    [inst.id, inst.visible, res.name, res.error, paramsText(inst, res), inst.script_id, inst.collapsed, pane])]);
}

function renderLegend() {
  app.ind.legendKey = legendKey();
  const main = $('#legend');
  main.innerHTML = '';
  $('#pane-legends').innerHTML = '';
  legendRefs = [];
  const info = S.symMap.get(S.symbol);
  main.append(el('div', { class: 'lg-title' },
    el('span', { class: 'lg-sym' }, app.symbolName(S.symbol)),
    el('span', { class: 'muted' }, `${TF_NAME[S.tf]} · ${S.dataSource || info?.source || ''}`),
    el('span', { class: 'lg-ohlc', id: 'lg-ohlc' })));
  for (const it of app.ind.items) {
    const { inst, res } = it;
    const row = el('div', { class: `lg-ind ${inst.visible ? '' : 'off'}`, 'data-ind': inst.id });
    const vals = el('span', { class: 'lg-vals' });
    const ptxt = paramsText(inst, res);
    row.append(el('span', { class: 'lg-name', title: res.error ? '' : res.name }, (res.name || inst.type) + (ptxt ? ' ' + ptxt : '')), vals);
    if (res.error) vals.append(el('span', { class: 'err', title: res.error }, '⚠ ' + res.error.slice(0, 80)));
    const isPane = it.own;
    const more = el('button', { class: 'lg-act', title: 'More', html: ICONS.dots.replace(/18/g, '14'), onclick: (e) => showMenu(e.currentTarget, [
      ...(!res.error && res.plots ? [{ label: 'Add alert…', testid: 'ind-alert', onClick: () => dialogs.alertDialog(app, { kind: 'indicator', inst }) }] : []),
      { label: 'Settings…', onClick: () => dialogs.indicatorSettings(app, inst) },
      ...(inst.type === 'custom' ? [{ label: 'Source code…', onClick: () => dialogs.scriptEditor(app, inst.script_id) }] : []),
      { label: 'Duplicate', onClick: () => app.addIndicator(inst.type, { script_id: inst.script_id, params: { ...(inst.params || {}) }, colors: { ...(inst.colors || {}) } }) },
      ...(isPane ? [{ sep: true },
        ...(canMovePane(inst, -1) ? [{ label: 'Move pane up', onClick: () => moveIndicatorPane(inst, -1) }] : []),
        ...(canMovePane(inst, 1) ? [{ label: 'Move pane down', onClick: () => moveIndicatorPane(inst, 1) }] : []),
        { label: inst.collapsed ? 'Expand pane' : 'Collapse pane', onClick: () => toggleCollapse(it) },
        { label: app.maxPane === inst.id ? 'Restore pane' : 'Maximize pane', onClick: () => toggleMaximize(it) }] : []),
      { sep: true },
      { label: inst.visible ? 'Hide' : 'Show', onClick: () => { inst.visible = !inst.visible; app.saveLayout(); refreshIndicators(); } },
      { label: 'Remove', onClick: () => app.removeIndicator(inst.id) },
    ]) });
    const act = el('span', { class: 'lg-actions' },
      el('button', { class: 'lg-act', title: inst.visible ? 'Hide' : 'Show', 'data-testid': 'ind-toggle', html: inst.visible ? ICONS.eye : ICONS.eyeOff, onclick: () => { inst.visible = !inst.visible; app.saveLayout(); refreshIndicators(); } }),
      el('button', { class: 'lg-act', title: 'Settings', 'data-testid': 'ind-settings', html: ICONS.gear, onclick: () => dialogs.indicatorSettings(app, inst) }),
      inst.type === 'custom' ? el('button', { class: 'lg-act', title: 'Source code', 'data-testid': 'ind-source', html: ICONS.braces, onclick: () => dialogs.scriptEditor(app, inst.script_id) }) : null,
      el('button', { class: 'lg-act', title: 'Remove', html: ICONS.trash.replace(/16/g, '14'), 'data-testid': 'ind-remove', onclick: () => app.removeIndicator(inst.id) }),
      more);
    row.append(act);
    legendRefs.push({ it, vals: res.error ? null : vals });
    if (isPane) {
      // TradingView pane buttons: move up / down (only when possible), delete, collapse, maximize
      const ctr = el('div', { class: 'pane-ctrls' },
        canMovePane(inst, -1) ? el('button', { class: 'lg-act', title: 'Move pane up', 'data-testid': 'pane-up', html: ICONS.up, onclick: () => moveIndicatorPane(inst, -1) }) : null,
        canMovePane(inst, 1) ? el('button', { class: 'lg-act', title: 'Move pane down', 'data-testid': 'pane-down', html: ICONS.down, onclick: () => moveIndicatorPane(inst, 1) }) : null,
        el('button', { class: 'lg-act', title: 'Delete pane', 'data-testid': 'pane-delete', html: ICONS.trash.replace(/16/g, '14'), onclick: () => app.removeIndicator(inst.id) }),
        el('button', { class: 'lg-act', title: inst.collapsed ? 'Expand pane' : 'Collapse pane', 'data-testid': 'pane-collapse', html: inst.collapsed ? ICONS.expand : ICONS.collapse, onclick: () => toggleCollapse(it) }),
        el('button', { class: 'lg-act', title: app.maxPane === inst.id ? 'Restore pane' : 'Maximize pane', 'data-testid': 'pane-maximize', html: app.maxPane === inst.id ? ICONS.restore : ICONS.maximize, onclick: () => toggleMaximize(it) }));
      $('#pane-legends').append(el('div', { class: 'pane-legend', 'data-pane': it.pane }, row), el('div', { class: 'pane-ctrl-wrap', 'data-pane': it.pane }, ctr));
    } else main.append(row);
  }
  positionPaneLegends();
}

function positionPaneLegends() {
  if (!app.chart) return;
  positionScaleBtns();
  const panes = app.chart.panes();
  const base = $('#chart').getBoundingClientRect();
  const scaleW = app.chart.priceScale('right', mainIdx()).width();
  // the price legend follows the price pane when indicator panes are moved above it
  const mainEl = panes[mainIdx()]?.getHTMLElement();
  if (mainEl) $('#legend').style.top = (mainEl.getBoundingClientRect().top - base.top + 6) + 'px';
  for (const d of document.querySelectorAll('.pane-legend, .pane-ctrl-wrap')) {
    const p = panes[Number(d.dataset.pane)];
    const e = p && p.getHTMLElement();
    if (!e) { d.hidden = true; continue; }
    const r = e.getBoundingClientRect();
    d.hidden = r.height < 24;
    d.style.top = (r.top - base.top + 4) + 'px';
    if (d.classList.contains('pane-ctrl-wrap')) d.style.right = (scaleW + 8) + 'px';
  }
  // stack multiple legends in the same pane
  const seen = {};
  for (const d of document.querySelectorAll('.pane-legend')) {
    const k = d.dataset.pane;
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > 1) d.style.top = (parseFloat(d.style.top) + 22 * (seen[k] - 1)) + 'px';
  }
}

function fmtVal(v, res) {
  if (v == null) return '∅';
  if (res.volume) return fmtNum(v);
  if (res.overlay) return app.fmtPrice(v);
  const a = Math.abs(v);
  return a >= 1e5 ? fmtNum(v) : v.toFixed(a < 1 ? 4 : 2);
}

// Called on every crosshair move and live tick: only text and colors of existing nodes change
// (rebuilding nodes and re-measuring the layout here was a main cost while scrolling).
let ohlcNodes = null;
function updateLegendValues(idx) {
  const n = S.view.length;
  if (!n) return;
  const i = idx == null || idx < 0 || idx >= n ? n - 1 : idx;
  const b = S.view[i], prev = S.view[i - 1];
  const o = $('#lg-ohlc');
  if (o && b) {
    if (!ohlcNodes || !o.contains(ohlcNodes.o)) {
      o.innerHTML = '';
      const v = () => el('span');
      ohlcNodes = { o: v(), h: v(), l: v(), c: v(), chg: el('span'), vol: el('span') };
      o.append(
        el('span', {}, el('b', {}, 'O '), ohlcNodes.o), el('span', {}, el('b', {}, 'H '), ohlcNodes.h),
        el('span', {}, el('b', {}, 'L '), ohlcNodes.l), el('span', {}, el('b', {}, 'C '), ohlcNodes.c),
        ohlcNodes.chg, el('span', {}, el('b', {}, 'Vol '), ohlcNodes.vol));
    }
    const chg = prev ? b.close - prev.close : 0, pct = prev ? chg / prev.close * 100 : 0;
    const cls = b.close >= b.open ? 'up' : 'down';
    for (const [k, v] of [['o', b.open], ['h', b.high], ['l', b.low], ['c', b.close]]) { ohlcNodes[k].textContent = app.fmtPrice(v); ohlcNodes[k].className = cls; }
    ohlcNodes.chg.textContent = `${chg >= 0 ? '+' : ''}${app.fmtPrice(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    ohlcNodes.chg.className = chg >= 0 ? 'up' : 'down';
    ohlcNodes.vol.textContent = fmtNum(b.volume);
  }
  for (const ref of legendRefs) {
    const { it, vals } = ref;
    if (!vals || !it.inst.visible || !it.res.plots) continue;
    const j = i - resOff(it.res);
    const plots = it.res.plots;
    if (!ref.spans || ref.spans.length !== plots.length || !vals.contains(ref.spans[0])) {
      vals.innerHTML = '';
      ref.spans = plots.map(() => el('span'));
      vals.append(...ref.spans);
    }
    plots.forEach((p, k) => {
      const v = j >= 0 ? p.data[j] : null, sp = ref.spans[k];
      sp.hidden = p.style === 'circles' && v == null;
      sp.textContent = fmtVal(v, it.res);
      sp.style.color = (p.colors && j >= 0 && p.colors[j]) || p.color;
    });
  }
}

// ======================================================================= top bar
function buildTopbar() {
  $('#symbol-btn').onclick = () => dialogs.symbolSearch(app);
  const more = $('#tf-more');
  more.append(el('button', { class: 'tb-btn icon', title: 'All timeframes', html: ICONS.caret, onclick: (e) => {
    showMenu(e.currentTarget, [
      { title: 'Timeframes (★ = favorites)' },
      ...Object.keys(TF_SEC).filter(tf => S.availableTfs.includes(tf)).map(tf => ({
        label: `${S.favTfs.includes(tf) ? '★' : '☆'} ${TF_NAME[tf]}`, active: tf === S.tf, testid: `tf-menu-${tf}`,
        onClick: () => setTf(tf),
      })),
      { sep: true },
      { label: 'Edit favorites…', onClick: () => dialogs.editFavTfs(app, renderTfButtons) },
    ]);
  } }));
  const ct = $('#charttype');
  const ctBtn = el('button', { class: 'tb-btn', title: 'Chart type', id: 'charttype-btn' });
  const renderCt = () => { ctBtn.innerHTML = ''; ctBtn.append(el('span', {}, CHART_TYPES[S.chartType]), ic('caret')); };
  renderCt();
  ctBtn.onclick = () => showMenu(ctBtn, CHART_TYPE_GROUPS.flatMap((g, gi) => [
    ...(gi ? [{ sep: true }] : []),
    ...g.map(k => ({
      label: CHART_TYPES[k], active: k === S.chartType, testid: `ct-${k}`,
      onClick: () => {
        const wasTransformed = TRANSFORMED.has(S.chartType);
        S.chartType = k; renderCt(); refreshView(); makeMainSeries(); setMainData(); app.ind.sig = null;
        refreshIndicators(true); app.dm.update(); app.saveLayout();
        if (wasTransformed || TRANSFORMED.has(k)) app.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, S.view.length - 150), to: S.view.length + 10 });
      },
    })),
  ]));
  ct.append(ctBtn);
  $('#btn-indicators').onclick = () => dialogs.indicatorPicker(app);
  $('#btn-editor').onclick = () => dialogs.scriptEditor(app);
  $('#btn-alert').onclick = () => dialogs.alertDialog(app, { kind: 'price' });
  $('#btn-undo').onclick = () => app.dm.undo();
  $('#btn-redo').onclick = () => app.dm.redo();
  $('#btn-screenshot').onclick = screenshot;
  $('#btn-chart-settings').onclick = () => dialogs.chartSettings(app);
  $('#btn-fullscreen').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  $('#btn-togglepanel').onclick = () => {
    S.rightPanel = !S.rightPanel;
    $('#app').classList.toggle('no-panel', !S.rightPanel);
    $('#app').classList.toggle('show-panel', S.rightPanel);
    app.saveLayout();
  };
  const um = $('#user-menu');
  const ub = el('button', { class: 'tb-btn', id: 'user-btn', title: 'User' },
    el('span', { style: { width: '24px', height: '24px', borderRadius: '50%', background: '#2962ff', display: 'grid', placeItems: 'center', fontWeight: 700, color: '#fff' } }, (S.user.display_name || '?')[0].toUpperCase()));
  ub.onclick = () => showMenu(ub, [
    { title: `${S.user.display_name} · ${S.plan?.name || ''} plan` },
    { label: 'Notifications…', testid: 'menu-notify', onClick: () => dialogs.notifySettings(app) },
    { sep: true },
    ...(S.user.is_admin ? [
      { label: 'Data Sources (ClickHouse)', testid: 'menu-datasources', onClick: () => dialogs.datasourceAdmin(app) },
      { label: 'Users', testid: 'menu-users', onClick: () => dialogs.usersAdmin(app) },
      { label: 'Plans', testid: 'menu-plans', onClick: () => dialogs.plansAdmin(app) },
      { label: 'Notification servers', testid: 'menu-notify-admin', onClick: () => dialogs.notifyAdmin(app) },
      { sep: true }] : []),
    ...(S.user.auth_provider === 'local' ? [{ label: 'Change password', onClick: () => dialogs.changePassword(app) }] : []),
    { label: 'Sign out', testid: 'menu-logout', onClick: async () => { await api.logout(); location.reload(); } },
  ], { align: 'right' });
  um.append(ub);
}

function renderTfButtons() {
  const g = $('#tf-group');
  g.innerHTML = '';
  const tfs = S.favTfs.filter(tf => TF_SEC[tf]);
  if (!tfs.includes(S.tf)) tfs.push(S.tf);
  tfs.sort((a, b) => TF_SEC[a] - TF_SEC[b]);
  for (const tf of tfs) {
    g.append(el('button', { class: `tf-btn ${tf === S.tf ? 'active' : ''}`, title: TF_NAME[tf], 'data-tf': tf, onclick: () => setTf(tf) }, TF_SHORT[tf] || tf));
  }
}
app.renderTfButtons = renderTfButtons;

function screenshot() {
  const canvas = app.chart.takeScreenshot(true, false);
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height + 28;
  const ctx = out.getContext('2d');
  ctx.fillStyle = S.style.background; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 28);
  ctx.fillStyle = '#d1d4dc'; ctx.font = '600 14px sans-serif';
  ctx.fillText(`${app.symbolName(S.symbol)} · ${TF_NAME[S.tf]} · ${new Date().toLocaleString('en-GB')}`, 10, 19);
  out.toBlob((blob) => {
    const a = el('a', { href: URL.createObjectURL(blob), download: `${app.symbolName(S.symbol)}_${S.tf}_${Date.now()}.png` });
    document.body.append(a); a.click(); a.remove();
  });
}

// ======================================================================= left toolbar
const TOOL_ICONS = {
  cursor: '<path d="M6 3l12 9-6 1 3 7-2 1-3-7-4 4z" fill="currentColor"/>',
  trend: '<path d="M4 20L20 4" stroke="currentColor" stroke-width="1.6"/><circle cx="4" cy="20" r="2" fill="currentColor"/><circle cx="20" cy="4" r="2" fill="currentColor"/>',
  ray: '<path d="M4 18L22 6" stroke="currentColor" stroke-width="1.6"/><circle cx="4" cy="18" r="2" fill="currentColor"/><circle cx="12" cy="12.7" r="2" fill="currentColor"/>',
  extended: '<path d="M1 20L23 4" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="15" r="2" fill="currentColor"/><circle cx="16" cy="9" r="2" fill="currentColor"/>',
  arrow: '<path d="M4 20L19 5M19 5h-7M19 5v7" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  hline: '<path d="M2 12h20" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  hray: '<path d="M6 12h17" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="12" r="2" fill="currentColor"/>',
  vline: '<path d="M12 2v20" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  channel: '<path d="M3 15L15 4M9 21L21 10" stroke="currentColor" stroke-width="1.6"/>',
  rect: '<rect x="4" y="6" width="16" height="12" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  fib: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18" stroke="currentColor" stroke-width="1.4"/>',
  measure: '<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  longpos: '<rect x="4" y="4" width="16" height="8" fill="#08998155" stroke="#089981"/><rect x="4" y="12" width="16" height="6" fill="#f2364555" stroke="#f23645"/>',
  shortpos: '<rect x="4" y="6" width="16" height="6" fill="#f2364555" stroke="#f23645"/><rect x="4" y="12" width="16" height="8" fill="#08998155" stroke="#089981"/>',
  text: '<path d="M5 5h14M12 5v15" stroke="currentColor" stroke-width="2"/>',
  brush: '<path d="M3 20c3 0 4-2 5-4s3-3 5-2M13 14l7-9 1 1-7 9z" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  keep: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M16 18h5M18.5 15.5v5" stroke="currentColor" stroke-width="1.5"/>',
  hide: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
};
const svg = (inner) => `<svg viewBox="0 0 24 24" width="22" height="22">${inner}</svg>`;

// Default icon per group (the button shows the last used tool of that group)
const GROUP_ICONS = {
  cursors: '<path d="M12 3v7M12 14v7M3 12h7M14 12h7" stroke="currentColor" stroke-width="1.6"/>',
  lines: TOOL_ICONS.trend,
  fib: TOOL_ICONS.fib,
  patterns: '<path d="M2 18l5-10 4 7 4-11 5 14" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="7" cy="8" r="1.6" fill="currentColor"/><circle cx="15" cy="4" r="1.6" fill="currentColor"/>',
  forecast: TOOL_ICONS.longpos,
  shapes: TOOL_ICONS.brush,
  annotation: TOOL_ICONS.text,
};
const TOOL_ICON_FOR = (id) => TOOL_ICONS[id] || GROUP_ICONS[TOOLS[id]?.group] || TOOL_ICONS.trend;

function buildLeftTools() {
  const nav = $('#lefttools');
  S.lastTool = S.lastTool || {};
  const add = (id, title, inner, onclick, extra = {}) => {
    const b = el('button', { class: 'lt-btn', 'data-tool': id, title, html: svg(inner), onclick, ...extra });
    nav.append(b);
    return b;
  };
  for (const g of GROUPS) {
    const tools = Object.values(TOOLS).filter(t => t.group === g.id && !t.hidden);
    const current = () => S.lastTool[g.id] || (g.id === 'cursors' ? app.dm.cursorMode : tools[0].id);
    const btn = add(`group-${g.id}`, g.name, GROUP_ICONS[g.id], () => {
      const t = current();
      if (g.id === 'cursors') app.dm.setTool(t);
      else app.dm.setTool(app.dm.tool === t ? 'cursor' : t);
    }, { 'data-group': g.id });
    const caret = el('span', { class: 'lt-caret', title: g.name, onclick: (e) => {
      e.stopPropagation();
      const items = [{ title: g.name }];
      for (const t of tools) {
        items.push({
          label: t.name + (t.key ? `  ${t.key}` : ''), active: current() === t.id, testid: `tool-${t.id}`,
          icon: el('span', { html: svg(TOOL_ICON_FOR(t.id)).replace(/22/g, '18'), style: { display: 'inline-flex', width: '18px' } }),
          onClick: () => { S.lastTool[g.id] = t.id; app.dm.setTool(t.id); renderLeftActive(); app.saveLayout(); },
        });
      }
      const m = showMenu(btn, items);
      const r = btn.getBoundingClientRect();
      m.style.left = (r.right + 4) + 'px';
      m.style.top = Math.max(4, Math.min(r.top, window.innerHeight - m.offsetHeight - 4)) + 'px';
    } }, '');
    btn.append(caret);
    if (g.id === 'cursors') nav.append(el('div', { class: 'lt-sep' }));
  }
  nav.append(el('div', { class: 'lt-sep' }));
  add('ruler', 'Measure (Shift+click on chart also works)', TOOL_ICONS.measure, () => app.dm.setTool(app.dm.tool === 'ruler' ? 'cursor' : 'ruler'));
  add('zoom', 'Zoom in (drag a range)', '<circle cx="10" cy="10" r="6" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M15 15l6 6M7 10h6M10 7v6" stroke="currentColor" stroke-width="1.6"/>', () => app.dm.setTool(app.dm.tool === 'zoom' ? 'cursor' : 'zoom'));
  nav.append(el('div', { class: 'lt-sep' }));
  add('magnet', 'Magnet mode (snap to OHLC)', TOOL_ICONS.magnet, () => { S.magnet = !S.magnet; renderLeftActive(); app.saveLayout(); });
  add('keep', 'Stay in drawing mode', TOOL_ICONS.keep, () => { S.keepDrawing = !S.keepDrawing; renderLeftActive(); app.saveLayout(); });
  add('lock', 'Lock all drawings', ICONS.lock.replace(/width="16" height="16"/, ''), () => { app.dm.locked = !app.dm.locked; renderLeftActive(); });
  add('hide', 'Hide/show drawings', TOOL_ICONS.hide, () => { app.dm.hidden = !app.dm.hidden; app.dm.select(null); renderLeftActive(); });
  nav.append(el('div', { class: 'lt-sep' }));
  add('clear', 'Remove all drawings', ICONS.trash.replace(/width="16" height="16"/, ''), async () => {
    if (!app.dm.drawings.length) return;
    if (await dialogs.confirm(`Remove all ${app.dm.drawings.length} drawings on ${app.symbolName(S.symbol)}?`, { ok: 'Remove', danger: true })) app.dm.removeAll();
  });
  renderLeftActive();
}

function renderLeftActive() {
  for (const b of document.querySelectorAll('.lt-btn')) {
    const t = b.dataset.tool;
    let on = t === app.dm.tool;
    if (b.dataset.group) {
      const g = b.dataset.group;
      const cur = S.lastTool?.[g] || (g === 'cursors' ? app.dm.cursorMode : null);
      if (g === 'cursors') on = app.dm.tool === 'cursor';
      else on = TOOLS[app.dm.tool]?.group === g;
      const icon = g === 'cursors' ? GROUP_ICONS.cursors : cur ? TOOL_ICON_FOR(cur) : GROUP_ICONS[g];
      const caret = b.querySelector('.lt-caret');
      b.innerHTML = svg(icon);
      b.append(caret);
      b.title = (cur ? TOOLS[cur].name : '') || b.title;
    }
    if (t === 'magnet') on = S.magnet;
    if (t === 'keep') on = S.keepDrawing;
    if (t === 'lock') on = app.dm.locked;
    if (t === 'hide') on = app.dm.hidden;
    b.classList.toggle('active', on);
  }
}

// ======================================================================= drawing floating toolbar
const SWATCHES = ['#2962ff', '#089981', '#f23645', '#ff9800', '#ffeb3b', '#9c27b0', '#00bcd4', '#e91e63', '#4caf50', '#787b86', '#d1d4dc', '#ffffff', '#f7a600', '#673ab7', '#795548', '#000000'];

function renderDrawbar(d) {
  const bar = $('#drawbar');
  bar.innerHTML = '';
  bar.hidden = !d;
  if (!d) return;
  const st = d.style || {};
  const btn = (attrs, ...kids) => el('button', { class: 'db-btn', ...attrs }, ...kids);
  bar.append(el('span', { class: 'db-name' }, TOOLS[d.tool]?.name || d.tool));
  bar.append(btn({ title: 'Color', 'data-testid': 'db-color', onclick: (e) => {
    const sw = el('div', { class: 'swatches' }, SWATCHES.map(c => el('div', { class: 'swatch', style: { background: c }, onclick: () => { app.dm.updateSelected(null, { color: c }); renderDrawbar(app.dm.selected()); } })));
    const custom = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#2962ff', oninput: (ev) => app.dm.updateSelected(null, { color: ev.target.value }) });
    showMenu(e.currentTarget, [{ el: sw }, { el: el('div', { class: 'dd-item' }, 'Custom color', custom) }]);
  } }, el('span', { class: 'swatch', style: { background: st.color || '#2962ff' } })));
  if (!TOOLS[d.tool]?.textEdit) {
    bar.append(btn({ title: 'Width', 'data-testid': 'db-width', onclick: (e) => showMenu(e.currentTarget, [1, 2, 3, 4].map(w => ({ label: `${w}px`, active: (st.width || 1) === w, onClick: () => { app.dm.updateSelected(null, { width: w }); renderDrawbar(app.dm.selected()); } }))) }, `${st.width || 1}px`));
    bar.append(btn({ title: 'Line style', onclick: (e) => showMenu(e.currentTarget, [['Solid', 0], ['Dashed', 1], ['Dotted', 2]].map(([l, v]) => ({ label: l, active: (st.dash || 0) === v, onClick: () => { app.dm.updateSelected(null, { dash: v }); renderDrawbar(app.dm.selected()); } }))) }, ['━', '┅', '┈'][st.dash || 0]));
  } else {
    bar.append(btn({ title: 'Edit text', html: ICONS.text, onclick: async () => { const t = await dialogs.promptText('Text', d.text || ''); if (t != null) app.dm.updateSelected({ text: t }); } }));
    bar.append(btn({ title: 'Font size', onclick: (e) => showMenu(e.currentTarget, [10, 12, 14, 16, 20, 24, 32].map(s => ({ label: `${s}px`, active: (st.fontSize || 14) === s, onClick: () => { app.dm.updateSelected(null, { fontSize: s }); renderDrawbar(app.dm.selected()); } }))) }, `${st.fontSize || 14}`));
  }
  if (TOOLS[d.tool]?.fill || d.tool === 'polyline') bar.append(btn({ title: 'Fill', class: `db-btn ${st.fill !== false ? 'active' : ''}`, onclick: () => { app.dm.updateSelected(null, { fill: st.fill === false }); renderDrawbar(app.dm.selected()); } }, '▨'));
  if (TOOLS[d.tool]?.extendLeft) bar.append(btn({ title: 'Extend left', 'data-testid': 'db-ext-left', class: `db-btn ${st.extendLeft ? 'active' : ''}`, onclick: () => { app.dm.updateSelected(null, { extendLeft: !st.extendLeft }); renderDrawbar(app.dm.selected()); } }, '←'));
  if (TOOLS[d.tool]?.extend) bar.append(btn({ title: 'Extend right', 'data-testid': 'db-ext-right', class: `db-btn ${st.extend ? 'active' : ''}`, onclick: () => { app.dm.updateSelected(null, { extend: !st.extend }); renderDrawbar(app.dm.selected()); } }, '→'));
  bar.append(el('div', { class: 'db-sep' }));
  if (TOOLS[d.tool]?.alert) bar.append(btn({ title: 'Add alert on this drawing', 'data-testid': 'db-alert', html: ICONS.bell.replace(/14/g, '16'), onclick: () => dialogs.alertDialog(app, { kind: 'drawing', drawing: d }) }));
  bar.append(btn({ title: d.locked ? 'Unlock' : 'Lock', html: d.locked ? ICONS.lock : ICONS.unlock, onclick: () => { app.dm.updateSelected({ locked: !d.locked }); renderDrawbar(app.dm.selected()); } }));
  bar.append(btn({ title: 'Clone', html: ICONS.copy, onclick: () => app.dm.cloneSelected() }));
  bar.append(btn({ title: 'Delete (Del)', 'data-testid': 'db-delete', html: ICONS.trash, onclick: () => app.dm.removeSelected() }));
}

// ======================================================================= bottom bar
function buildBottombar() {
  const r = $('#ranges');
  for (const rg of RANGES) {
    r.append(el('button', { class: 'bb-btn', title: `${rg[0]} (${TF_NAME[rg[1]]})`, onclick: async () => {
      if (S.tf !== rg[1]) await setSymbol(S.symbol, { tf: rg[1], range: rg });
      else applyRange(rg);
    } }, rg[0]));
  }
  r.append(el('button', { class: 'bb-btn', title: 'Go to latest bar', onclick: () => app.scrollToRecent() }, '⇥'));
  r.append(el('button', { class: 'bb-btn', title: 'Go to… (Alt+G)', 'data-testid': 'goto-btn', 'aria-label': 'Go to',
    html: '<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="3.5" width="13" height="12" rx="1.5"/><path d="M2.5 7h13M6 2v3M12 2v3M8 11h5M11 9l2 2-2 2"/></svg>',
    onclick: () => dialogs.goToDialog(app) }));
  const tzWrap = $('#tz-select');
  const tzBtn = el('button', { class: 'bb-btn', id: 'tz-btn' });
  const renderTz = () => {
    const sec = S.tzOffset, h = Math.trunc(sec / 3600), m = Math.abs(sec % 3600) / 60;
    tzBtn.textContent = sec ? `UTC${sec > 0 ? '+' : '-'}${Math.abs(h)}${m ? ':' + pad(m) : ''}` : 'UTC';
    tzBtn.title = 'Timezone: ' + (S.tz === 'local' ? 'Browser' : S.tz === 'exchange' ? 'Exchange' : S.tz);
  };
  renderTz();
  const fmtOff = (sec) => {
    if (!sec) return 'UTC';
    const h = Math.trunc(sec / 3600), m = Math.abs(sec % 3600) / 60;
    return `UTC${sec > 0 ? '+' : '-'}${Math.abs(h)}${m ? ':' + pad(m) : ''}`;
  };
  const pick = async (id) => { S.tz = id; S.tzOffset = tzOffsetSec(id); renderTz(); app.saveLayout(); await setSymbol(S.symbol); };
  tzBtn.onclick = () => {
    const zones = TIMEZONES.map(([id, name]) => ({ id, name, off: tzOffsetSec(id) })).sort((a, b) => a.off - b.off);
    showMenu(tzBtn, [
      { label: 'UTC', active: S.tz === 'UTC', onClick: () => pick('UTC') },
      { label: 'Exchange', active: S.tz === 'exchange', onClick: () => pick('exchange') },
      { label: `Browser (${fmtOff(tzOffsetSec('local'))})`, active: S.tz === 'local', onClick: () => pick('local') },
      { sep: true },
      ...zones.map(z => ({ label: `(${fmtOff(z.off)}) ${z.name}`, active: z.id === S.tz, testid: `tz-${z.name}`, onClick: () => pick(z.id) })),
    ], { align: 'right' });
  };
  tzWrap.append(tzBtn);
  const tick = () => {
    const d = new Date(Date.now() + S.tzOffset * 1000);
    $('#clock').textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
  $('#btn-log').onclick = () => { S.scaleMode = S.scaleMode === 1 ? 0 : 1; applyScaleMode(); app.saveLayout(); };
  $('#btn-pct').onclick = () => { S.scaleMode = S.scaleMode === 2 ? 0 : 2; applyScaleMode(); app.saveLayout(); };
  $('#btn-auto').onclick = () => { S.autoScale = !S.autoScale; applyScaleMode(); app.saveLayout(); };
}

// ======================================================================= keyboard
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable || document.querySelector('.modal-backdrop');
    if (typing) return;
    if (e.altKey && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); app.scrollToRecent(); return; }
    if (app.dm.onKey(e)) { e.preventDefault(); return; }
    if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); dialogs.alertDialog(app, { kind: 'price' }); return; }
    if (e.altKey && e.key.toLowerCase() === 'g') { e.preventDefault(); dialogs.goToDialog(app); return; }
    if (e.key === '/' ) { e.preventDefault(); dialogs.indicatorPicker(app); return; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-z0-9]$/i.test(e.key)) {
      e.preventDefault();
      dialogs.symbolSearch(app, { initial: e.key.toUpperCase() });
    }
  });
}

boot();
