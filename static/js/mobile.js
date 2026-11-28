// Phone layout: a bottom tab bar (Chart, Watchlist, Alerts, Draw), a ☰ menu for everything else and
// bottom sheets instead of toolbars. The desktop toolbars stay in the page and are hidden by CSS, so
// both layouts drive the same state.
import { el, $, closeMenus } from './ui.js';

// Phones in portrait, and phones in landscape (short and touch); tablets keep the desktop layout.
export const PHONE_QUERY = '(max-width: 600px), (max-height: 500px) and (pointer: coarse)';

let app, S, d;
const isPhone = () => document.body.classList.contains('mobile');

const ICON = {
  chart: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6" stroke="currentColor" stroke-width="1.7" fill="none"/>',
  watchlist: '<path d="M5 6h14M5 12h14M5 18h9" stroke="currentColor" stroke-width="1.7"/>',
  alerts: '<path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  draw: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8"/>',
  undo: '<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  redo: '<path d="M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h3" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8"/>',
};
const icon = (k, size = 22) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}">${ICON[k]}</svg>`;

/**
 * deps: { GROUPS, TOOLS, toolIcon(id), svg(inner), renderLeftActive(), applyScaleMode(), screenshot(),
 *         userMenuItems(), dialogs }
 */
export function initMobile(a, deps) {
  app = a; S = a.S; d = deps;
  buildTabbar();
  buildDrawToolbar();
  $('#btn-menu').onclick = () => openMenuSheet();
  const mq = window.matchMedia(PHONE_QUERY);
  const apply = () => {
    document.body.classList.toggle('mobile', mq.matches);
    if (!mq.matches) { closeSheet(); setPanel(null); }
    renderDrawToolbar();
  };
  mq.addEventListener('change', apply);
  apply();
  // picking a symbol in the watchlist goes back to the chart
  app.on('symbolChanged', () => { if (isPhone() && panel === 'watchlist') setPanel(null); });
}

// ---------------------------------------------------------------- tab bar
let panel = null; // 'watchlist' | 'alerts' | null (chart)
function buildTabbar() {
  const bar = $('#tabbar');
  const tab = (id, label, onclick) => el('button', { class: 'tab-btn', 'data-tab': id, 'data-testid': `tab-${id}`, onclick, html: icon(id === 'draw' ? 'draw' : id) }, el('span', {}, label));
  bar.append(
    tab('chart', 'Chart', () => { closeSheet(); setPanel(null); app.openBottomPanel?.(null); }),
    tab('watchlist', 'Watchlist', () => { closeSheet(); setPanel(panel === 'watchlist' ? null : 'watchlist'); }),
    tab('alerts', 'Alerts', () => { closeSheet(); setPanel(panel === 'alerts' ? null : 'alerts'); }),
    tab('draw', 'Draw', () => { setPanel(null); sheet === 'draw' ? closeSheet() : openDrawSheet(); }),
  );
  // the alert badge of the right panel, mirrored on the tab
  const src = $('#alert-badge');
  const badge = el('span', { class: 'badge tab-badge', hidden: true });
  bar.querySelector('[data-tab=alerts]').append(badge);
  new MutationObserver(() => { badge.hidden = src.hidden; badge.textContent = src.textContent; }).observe(src, { attributes: true, childList: true, characterData: true, subtree: true });
  renderTabs();
}

function setPanel(p) {
  panel = p;
  $('#app').classList.toggle('m-panel', !!p);
  if (p) document.querySelector(`.rp-tab[data-tab=${p}]`)?.click();
  renderTabs();
}

function renderTabs() {
  const active = sheet === 'draw' ? 'draw' : panel || 'chart';
  for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === active);
}

// ---------------------------------------------------------------- bottom sheets
let sheet = null, sheetEl = null;
function openSheet(id, title, body) {
  closeSheet();
  closeMenus();
  sheet = id;
  sheetEl = el('div', { class: 'm-sheet-backdrop', 'data-testid': `sheet-${id}`, onclick: (e) => { if (e.target === sheetEl) closeSheet(); } },
    el('div', { class: 'm-sheet' },
      el('div', { class: 'm-sheet-head' }, el('span', {}, title),
        el('button', { class: 'm-sheet-x', title: 'Close', html: icon('close', 20), onclick: closeSheet })),
      el('div', { class: 'm-sheet-body' }, body)));
  document.body.append(sheetEl);
  renderTabs();
}
function closeSheet() {
  sheetEl?.remove();
  sheetEl = null; sheet = null;
  renderTabs();
}

// A menu (showMenu item format) as a full-width list.
function listItems(items, done = closeSheet) {
  return items.map(it => {
    if (it.sep) return el('div', { class: 'm-sep' });
    if (it.title) return el('div', { class: 'm-title' }, it.title);
    return el('button', { class: `m-item ${it.active ? 'active' : ''}`, 'data-testid': it.testid ? `m-${it.testid}` : null,
      onclick: (e) => { if (it.keepOpen) it.onClick?.(e); else { done(); it.onClick?.(e); } } },
      el('span', {}, it.label), it.value != null ? el('span', { class: 'm-val' }, it.value) : null);
  });
}

function openMenuSheet() {
  const check = (on) => (on ? '✓' : '');
  const body = el('div', {});
  const render = () => {
    body.innerHTML = '';
    body.append(...listItems([
      { title: 'Chart' },
      { label: 'Screener', testid: 'screener', onClick: () => app.openBottomPanel('screener') },
      { label: 'Screen results', testid: 'screen-results', onClick: () => { closeSheet(); setPanel('screen'); } },
      { label: 'Strategy tester', testid: 'tester', onClick: () => app.openBottomPanel('tester') },
      { label: 'Paper trading', testid: 'paper', onClick: () => app.openBottomPanel('paper') },
      { label: 'Custom indicator editor', testid: 'editor', onClick: () => d.dialogs.scriptEditor(app) },
      { label: 'Add price alert', testid: 'alert', onClick: () => d.dialogs.alertDialog(app, { kind: 'price' }) },
      { label: 'Go to date…', testid: 'goto', onClick: () => d.dialogs.goToDialog(app) },
      { label: 'Scroll to the latest bar', onClick: () => app.scrollToRecent() },
      { label: 'Chart settings', testid: 'chart-settings', onClick: () => d.dialogs.chartSettings(app) },
      { label: 'Screenshot', onClick: () => d.screenshot() },
      { label: document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen', onClick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) },
      { title: 'Scale' },
      { label: 'Logarithmic', value: check(S.scaleMode === 1), testid: 'log', keepOpen: true, onClick: () => { S.scaleMode = S.scaleMode === 1 ? 0 : 1; d.applyScaleMode(); app.saveLayout(); render(); } },
      { label: 'Percent', value: check(S.scaleMode === 2), keepOpen: true, onClick: () => { S.scaleMode = S.scaleMode === 2 ? 0 : 2; d.applyScaleMode(); app.saveLayout(); render(); } },
      { label: 'Auto scale', value: check(S.autoScale), keepOpen: true, onClick: () => { S.autoScale = !S.autoScale; d.applyScaleMode(); app.saveLayout(); render(); } },
      { label: 'Time zone', value: app.tzLabel(), testid: 'tz', keepOpen: true, onClick: (e) => app.openTzMenu(e.currentTarget) },
      ...d.userMenuItems(),
    ]));
  };
  render();
  openSheet('menu', 'Menu', body);
}

// ---------------------------------------------------------------- drawing tools
function openDrawSheet() {
  const body = el('div', {});
  const tool = (t, groupId) => el('button', {
    class: `m-tool ${app.dm.tool === t.id ? 'active' : ''}`, 'data-testid': `m-tool-${t.id}`,
    onclick: () => {
      if (groupId) { S.lastTool[groupId] = t.id; app.saveLayout(); }
      app.dm.setTool(t.id);
      d.renderLeftActive();
      closeSheet();
    },
  }, el('span', { class: 'm-tool-ic', html: d.svg(d.toolIcon(t.id)) }), el('span', {}, t.name));
  for (const g of d.GROUPS) {
    const tools = Object.values(d.TOOLS).filter(t => t.group === g.id && !t.hidden);
    if (!tools.length) continue;
    body.append(el('div', { class: 'm-title' }, g.name), el('div', { class: 'm-tools' }, tools.map(t => tool(t, g.id))));
  }
  body.append(el('div', { class: 'm-title' }, 'Measure'), el('div', { class: 'm-tools' },
    tool({ id: 'ruler', name: 'Measure' }), tool({ id: 'zoom', name: 'Zoom in' })));
  const opts = el('div', { class: 'm-tools' });
  const toggle = (id, name, on, fn) => el('button', { class: `m-tool ${on ? 'active' : ''}`, 'data-testid': `m-opt-${id}`, onclick: () => { fn(); d.renderLeftActive(); renderDrawToolbar(); openDrawSheet(); } },
    el('span', { class: 'm-tool-ic', html: d.svg(d.toolIcon(id)) }), el('span', {}, name));
  opts.append(
    toggle('magnet', 'Magnet', S.magnet, () => { S.magnet = !S.magnet; app.saveLayout(); }),
    toggle('keep', 'Stay in drawing mode', S.keepDrawing, () => { S.keepDrawing = !S.keepDrawing; app.saveLayout(); }),
    toggle('lock', 'Lock drawings', app.dm.locked, () => { app.dm.locked = !app.dm.locked; }),
    toggle('hide', 'Hide drawings', app.dm.hidden, () => { app.dm.hidden = !app.dm.hidden; app.dm.select(null); }),
    el('button', { class: 'm-tool danger', onclick: async () => {
      closeSheet();
      if (!app.dm.drawings.length) return;
      if (await d.dialogs.confirm(`Remove all ${app.dm.drawings.length} drawings on ${app.symbolName(S.symbol)}?`, { ok: 'Remove', danger: true })) app.dm.removeAll();
    } }, el('span', { class: 'm-tool-ic', html: d.svg(d.toolIcon('clear')) }), el('span', {}, 'Remove all')));
  body.append(el('div', { class: 'm-title' }, 'Options'), opts);
  openSheet('draw', 'Drawing tools', body);
}

// While a tool is active: a small bar on the chart with the tool, magnet, undo / redo and cancel.
function buildDrawToolbar() {
  $('#chartwrap').append(el('div', { class: 'm-drawtb', id: 'm-drawtb', 'data-testid': 'm-drawtb', hidden: true }));
}

export function renderDrawToolbar() {
  const bar = $('#m-drawtb');
  if (!bar || !app?.dm) return;
  const t = app.dm.tool;
  bar.hidden = !isPhone() || !t || t === 'cursor';
  if (bar.hidden) return;
  const name = d.TOOLS[t]?.name || (t === 'ruler' ? 'Measure' : t === 'zoom' ? 'Zoom in' : t);
  const b = (attrs, html) => el('button', { class: 'm-dt-btn', ...attrs, html });
  bar.innerHTML = '';
  bar.append(
    el('span', { class: 'm-dt-name', html: d.svg(d.toolIcon(t)).replace(/22/g, '18') }, el('span', {}, name)),
    b({ title: 'Magnet', class: `m-dt-btn ${S.magnet ? 'active' : ''}`, onclick: () => { S.magnet = !S.magnet; app.saveLayout(); d.renderLeftActive(); renderDrawToolbar(); } }, d.svg(d.toolIcon('magnet')).replace(/22/g, '18')),
    b({ title: 'Undo', onclick: () => app.dm.undo() }, icon('undo', 18)),
    b({ title: 'Redo', onclick: () => app.dm.redo() }, icon('redo', 18)),
    b({ title: 'Cancel', 'data-testid': 'm-drawtb-cancel', onclick: () => app.dm.setTool('cursor') }, icon('close', 18)),
  );
}
