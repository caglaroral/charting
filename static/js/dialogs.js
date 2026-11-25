// Modal dialogs: symbol search, indicators, script editor, alerts, admin (data sources, users).
import { api } from './api.js';
import { el, $, modal, toast, confirmDialog, promptDialog, ICONS } from './ui.js';
import { INDICATORS, defaultParams, defaultColors } from './indicators.js';
import { TEMPLATE } from './script.js';
import { TOOLS } from './drawings.js';

export const confirm = confirmDialog;
export const promptText = (title, value) => promptDialog(title, value, { multiline: title === 'Text' });

const TF_LIST = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1D', '1W', '1M'];

// ======================================================================= symbol search
export function symbolSearch(app, { initial = '', title = 'Symbol search', multi = false, isChecked, onPick } = {}) {
  const S = app.S;
  const input = el('input', { class: 'search-input', placeholder: 'Symbol, e.g. BTCUSDT', value: initial, 'aria-label': 'Symbol search', 'data-testid': 'symbol-search' });
  const list = el('div', { class: 'search-list', role: 'listbox' });
  let sel = 0, items = [];
  const render = () => {
    const q = input.value.trim().toUpperCase();
    const all = S.symbols;
    items = !q ? all.slice(0, 100)
      : all.filter(s => s.symbol.includes(q)).sort((a, b) => {
        const an = a.name.startsWith(q) ? 0 : 1, bn = b.name.startsWith(q) ? 0 : 1;
        return an - bn || a.name.length - b.name.length || a.name.localeCompare(b.name);
      }).slice(0, 100);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.innerHTML = '';
    items.forEach((s, i) => list.append(el('div', {
      class: `search-item ${i === sel ? 'sel' : ''}`, role: 'option', 'data-symbol': s.symbol,
      onclick: () => pick(s.symbol),
    },
    multi ? el('span', { class: 's-check' }, isChecked?.(s.symbol) ? '✓' : ' ') : null,
    el('span', { class: 's-sym' }, s.name),
    el('span', { class: 'muted', style: { fontSize: '11px' } }, [s.live ? 'live' : null, s.history ? 'history' : null].filter(Boolean).join(' + ')),
    el('span', { class: 's-src' }, s.source))));
    if (!items.length) list.append(el('div', { class: 'wl-empty' }, 'No results'));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const pick = async (sym) => {
    if (onPick) { await onPick(sym); if (multi) { render(); input.focus(); return; } }
    else app.setSymbol(sym);
    m.close();
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel].symbol); }
  });
  const m = modal({ title, width: '560px', body: el('div', {}, input, list) });
  render();
  // focus right away: keys typed before a deferred focus went to the page and were lost ("ETH" -> "EH")
  const caretEnd = () => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); };
  caretEnd();
  setTimeout(() => { if (document.activeElement !== input) caretEnd(); }, 0);
}

export function editFavTfs(app, done) {
  const S = app.S;
  const boxes = TF_LIST.map(tf => el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } },
    el('input', { type: 'checkbox', checked: S.favTfs.includes(tf), 'data-tf': tf }), tf));
  const m = modal({
    title: 'Favorite timeframes', width: '320px', body: el('div', {}, boxes),
    footer: [el('button', { class: 'btn primary', onclick: () => {
      S.favTfs = boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.dataset.tf);
      if (!S.favTfs.length) S.favTfs = ['1h'];
      app.saveLayout(); done(); m.close();
    } }, 'Save')],
  });
}

// ======================================================================= indicators
export function indicatorPicker(app) {
  const S = app.S;
  const input = el('input', { class: 'search-input', placeholder: 'Search indicators…', 'data-testid': 'ind-search' });
  const list = el('div', { class: 'ind-list' });
  const render = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = '';
    const scripts = S.scripts.filter(s => !q || s.name.toLowerCase().includes(q));
    list.append(el('div', { class: 'ind-group' }, 'My custom indicators'));
    for (const s of scripts) {
      list.append(el('div', { class: 'ind-item', 'data-script': s.id, onclick: () => { app.addIndicator('custom', { script_id: s.id, name: s.name }); m.close(); } },
        el('span', { html: ICONS.code }), s.name, el('span', { class: 'tag' }, 'ChartScript')));
    }
    list.append(el('div', { class: 'ind-item', onclick: () => { m.close(); scriptEditor(app); } }, el('span', {}, '＋'), 'Write a new custom indicator…', el('span', { class: 'tag' }, 'Editor')));
    list.append(el('div', { class: 'ind-group' }, 'Built-in'));
    for (const [k, d] of Object.entries(INDICATORS)) {
      if (q && !d.name.toLowerCase().includes(q) && !d.short.toLowerCase().includes(q)) continue;
      list.append(el('div', { class: 'ind-item', 'data-ind-type': k, onclick: () => { app.addIndicator(k); m.close(); } },
        d.name, el('span', { class: 'tag' }, d.overlay ? 'overlay' : 'separate pane')));
    }
  };
  input.addEventListener('input', render);
  const m = modal({ title: 'Indicators', width: '520px', body: el('div', {}, input, list) });
  render();
  setTimeout(() => input.focus(), 0);
}

export function indicatorSettings(app, inst) {
  const res = app.indicatorResult(inst.id) || {};
  const rows = [];
  const fields = {};
  const colorFields = {};
  let defs;
  if (inst.type === 'custom') {
    defs = (inst.inputs || res.inputs || []).map(i => ({ k: i.k, l: i.l, d: i.d, opts: i.opts }));
  } else {
    defs = INDICATORS[inst.type].params;
  }
  const params = { ...(inst.type === 'custom' ? {} : defaultParams(inst.type)), ...(inst.params || {}) };
  for (const p of defs) {
    const v = params[p.k] !== undefined ? params[p.k] : p.d;
    let input;
    if (p.opts) input = el('select', {}, p.opts.map(o => el('option', { value: o, selected: String(o) === String(v) }, o)));
    else if (typeof p.d === 'boolean') input = el('input', { type: 'checkbox', checked: v === true || v === 'true' });
    else if (typeof p.d === 'number') input = el('input', { type: 'number', step: 'any', value: v });
    else input = el('input', { value: v });
    fields[p.k] = { input, def: p };
    rows.push(el('label', {}, p.l), input);
  }
  const plots = (res.plots || []).concat(res.shapes || []);
  const colors = { ...(inst.type === 'custom' ? {} : defaultColors(inst.type)), ...(inst.colors || {}) };
  for (const p of plots) {
    const cur = colors[p.k] || p.color;
    const inp = el('input', { type: 'color', value: /^#[0-9a-f]{6}/i.test(cur) ? cur.slice(0, 7) : '#2962ff' });
    colorFields[p.k] = inp;
    rows.push(el('label', {}, `Color: ${p.title}`), inp);
  }
  if (!rows.length) rows.push(el('div', { class: 'muted' }, 'No settings'));
  const m = modal({
    title: `${res.name || inst.type} settings`, width: '460px',
    body: el('div', { class: 'form-grid' }, rows),
    footer: [
      el('button', { class: 'btn ghost', onclick: () => { inst.params = inst.type === 'custom' ? {} : defaultParams(inst.type); inst.colors = inst.type === 'custom' ? {} : defaultColors(inst.type); app.saveLayout(); app.refreshIndicators(true); m.close(); } }, 'Defaults'),
      el('button', { class: 'btn primary', 'data-testid': 'ind-save', onclick: () => {
        const np = {};
        for (const [k, { input, def }] of Object.entries(fields)) {
          np[k] = input.type === 'checkbox' ? input.checked : typeof def.d === 'number' ? Number(input.value) : input.value;
        }
        inst.params = np;
        const nc = { ...(inst.colors || {}) };
        for (const [k, inp] of Object.entries(colorFields)) {
          const orig = plots.find(p => p.k === k);
          if (inp.value !== (orig.color || '').slice(0, 7)) nc[k] = inp.value;
        }
        inst.colors = nc;
        app.saveLayout();
        app.refreshIndicators(true);
        m.close();
      } }, 'Apply'),
    ],
  });
}

// ======================================================================= script editor
export async function scriptEditor(app, scriptId = null) {
  const S = app.S;
  let current = null;
  let cm = null;
  let dirty = false;
  const side = el('div', { class: 'editor-side' });
  const nameInput = el('input', { placeholder: 'Indicator name', 'data-testid': 'script-name' });
  const out = el('div', { class: 'editor-out' }, el('span', { class: 'muted' }, 'Use Run to test the code on the current chart. Ctrl+S saves, Ctrl+Enter runs.'));
  const cmBox = el('div', { class: 'editor-cm' });
  const main = el('div', { class: 'editor-main' }, el('div', { class: 'ed-name' }, nameInput), cmBox, out);
  const body = el('div', { class: 'editor-layout' }, side, main);

  const renderSide = () => {
    side.innerHTML = '';
    side.append(el('button', { class: 'btn small primary', style: { width: '100%', marginBottom: '8px' }, 'data-testid': 'script-new', onclick: () => openScript(null) }, '+ New'));
    for (const s of S.scripts) {
      side.append(el('div', { class: `es-item ${current && current.id === s.id ? 'active' : ''}`, title: s.name, onclick: () => openScript(s) }, s.name));
    }
  };
  let errMark = null;
  const showErr = (msg, line) => {
    out.innerHTML = '';
    out.append(el('div', { class: 'err-box' }, msg + (line ? ` (line ${line})` : '')));
    if (errMark != null) cm.removeLineClass(errMark, 'background', 'cm-error-line');
    errMark = null;
    if (line && line > 0) { errMark = line - 1; cm.addLineClass(errMark, 'background', 'cm-error-line'); cm.scrollIntoView({ line: errMark, ch: 0 }, 80); }
  };
  const clearErr = () => { if (errMark != null) cm.removeLineClass(errMark, 'background', 'cm-error-line'); errMark = null; };

  const openScript = async (s) => {
    if (dirty && !(await confirm('Unsaved changes will be lost. Continue?'))) return;
    current = s ? { ...s } : null;
    nameInput.value = s ? s.name : 'New Indicator';
    cm.setValue(s ? s.code : TEMPLATE);
    cm.clearHistory();
    dirty = false;
    clearErr();
    renderSide();
  };

  const save = async () => {
    const code = cm.getValue();
    const name = nameInput.value.trim() || 'Custom';
    try {
      const { script } = await api.saveScript({ id: current?.id, name, code });
      current = script;
      const i = S.scripts.findIndex(x => x.id === script.id);
      if (i >= 0) S.scripts[i] = script; else S.scripts.push(script);
      S.scripts.sort((a, b) => a.name.localeCompare(b.name));
      dirty = false;
      renderSide();
      toast('Saved', 'ok');
      if (S.indicators.some(x => x.type === 'custom' && x.script_id === script.id)) app.refreshIndicators(true);
      return script;
    } catch (e) { toast('Save failed: ' + e.message, 'error'); return null; }
  };

  const run = async () => {
    out.innerHTML = '';
    out.append(el('span', { class: 'muted' }, 'Running…'));
    const t0 = performance.now();
    try {
      const r = await app.runCustom(cm.getValue(), {});
      clearErr();
      const ms = Math.round(performance.now() - t0);
      const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
      out.innerHTML = '';
      out.append(el('div', { class: 'ok-box' },
        `✓ "${r.meta.name}" · ${r.meta.overlay ? 'overlay' : 'separate pane'} · ${r.plots.length} plot, ${r.shapes.length} shape, ${r.inputs.length} input · ${ms} ms`,
        el('br'), r.plots.map(p => `${p.title}=${(v => (v == null ? '∅' : +v.toFixed(6)))(last(p.data))}`).join('  ·  '),
        r.shapes.length ? el('div', {}, r.shapes.map(s => `${s.title}: ${s.data.filter(Boolean).length} signals`).join('  ·  ')) : null));
    } catch (e) { showErr(e.message, e.line); }
  };

  const m = modal({
    title: 'Custom Indicator Editor', cls: 'editor-modal', body,
    footer: [
      el('button', { class: 'btn danger', 'data-testid': 'script-delete', onclick: async () => {
        if (!current?.id) return;
        if (!(await confirm(`Delete "${current.name}"? Its instances on the chart are removed too.`, { ok: 'Delete', danger: true }))) return;
        await api.deleteScript(current.id);
        S.scripts = S.scripts.filter(s => s.id !== current.id);
        const had = S.indicators.some(i => i.script_id === current.id);
        S.indicators = S.indicators.filter(i => i.script_id !== current.id);
        if (had) { app.saveLayout(); app.refreshIndicators(true); }
        dirty = false;
        await openScript(S.scripts[0] || null);
      } }, 'Delete'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', 'data-testid': 'script-run', onclick: run }, '▶ Run'),
      el('button', { class: 'btn', 'data-testid': 'script-save', onclick: save }, 'Save'),
      el('button', { class: 'btn primary', 'data-testid': 'script-add', onclick: async () => {
        const sc = await save();
        if (!sc) return;
        if (!S.indicators.some(x => x.script_id === sc.id)) app.addIndicator('custom', { script_id: sc.id, name: sc.name });
        m.close();
      } }, 'Save & add to chart'),
    ],
  });
  // Reference opens in its own tab so the editor keeps its full width
  m.box.querySelector('.modal-head .x').before(el('a', {
    class: 'head-link', href: '/docs/chartscript.html', target: '_blank', rel: 'noopener', title: 'ChartScript reference (new tab)', 'data-testid': 'script-docs',
    html: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 4h10l4 4v12H5z M14 4v5h5 M8 13h8 M8 16h6" stroke="currentColor" stroke-width="1.6" fill="none"/></svg><span>Docs</span>',
  }));
  cm = window.CodeMirror(cmBox, {
    value: '', mode: 'javascript', theme: 'chartscript', lineNumbers: true, matchBrackets: true, autoCloseBrackets: true,
    indentUnit: 2, tabSize: 2, extraKeys: { 'Ctrl-S': () => save(), 'Cmd-S': () => save(), 'Ctrl-Enter': () => run(), 'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment' },
  });
  cm.on('change', () => { dirty = true; });
  window.__cm = cm; // e2e tests
  const s = scriptId ? S.scripts.find(x => x.id === scriptId) : S.scripts[0];
  await openScript(s || null);
  setTimeout(() => cm.refresh(), 0);
  return m;
}

// ======================================================================= alerts
const CONDS = {
  line: ['crossing', 'crossing_up', 'crossing_down', 'greater', 'less'],
  zone: ['entering', 'exiting', 'crossing', 'crossing_up', 'crossing_down'],
};
const COND_NAMES = { crossing: 'Crossing', crossing_up: 'Crossing up', crossing_down: 'Crossing down', greater: 'Greater than', less: 'Less than', entering: 'Entering channel', exiting: 'Exiting channel', signal: 'Signal (shape appears)' };

export function alertDialog(app, { kind, inst, drawing, alert } = {}) {
  const S = app.S;
  const editing = !!alert;
  kind = alert ? alert.kind : kind;
  const spec0 = alert ? alert.spec : {};
  const symbol = alert ? alert.symbol : S.symbol;
  const rows = [];
  const add = (label, input) => { rows.push(el('label', {}, label), input); return input; };
  rows.push(el('label', {}, 'Symbol'), el('div', {}, app.symbolName(symbol)));

  let priceIn, plotSel, targetType, targetVal, targetPlot, conds, res;
  const lastClose = S.bars.length ? S.bars[S.bars.length - 1].close : 0;

  if (kind === 'price') {
    priceIn = add('Price', el('input', { type: 'number', step: 'any', value: spec0.price ?? app.fmtPrice(lastClose), 'data-testid': 'alert-price' }));
    conds = CONDS.line;
  } else if (kind === 'drawing') {
    const d = drawing || app.dm.drawings.find(x => x.id === spec0.drawing_id);
    const tool = d ? d.tool : spec0.tool;
    rows.push(el('label', {}, 'Drawing'), el('div', {}, TOOLS[tool]?.name || tool || '(deleted)'));
    drawing = d || { id: spec0.drawing_id, tool };
    conds = ['rect', 'channel'].includes(tool) ? CONDS.zone : CONDS.line;
  } else {
    if (!inst && alert) inst = S.indicators.find(i => (spec0.type === 'custom' ? i.script_id === spec0.script_id : i.type === spec0.type));
    res = inst ? app.indicatorResult(inst.id) : null;
    const plots = res ? res.plots.map(p => ({ k: p.k, t: p.title, shape: false })).concat(res.shapes.map(s => ({ k: s.k, t: `◆ ${s.title}`, shape: true }))) : [{ k: spec0.plot, t: spec0.plot }];
    rows.push(el('label', {}, 'Indicator'), el('div', {}, res?.name || spec0.name || spec0.type));
    plotSel = add('Series', el('select', { 'data-testid': 'alert-plot' }, plots.map(p => el('option', { value: p.k, selected: p.k === spec0.plot, 'data-shape': p.shape ? '1' : '' }, p.t))));
    conds = CONDS.line;
    targetType = el('select', {}, el('option', { value: 'value' }, 'Value'), el('option', { value: 'plot' }, 'Another series'));
    targetVal = el('input', { type: 'number', step: 'any', value: spec0.target?.value ?? (res?.hlines?.[0]?.value ?? 0), 'data-testid': 'alert-value' });
    targetPlot = el('select', {}, (res?.plots || []).map(p => el('option', { value: p.k, selected: spec0.target?.plot === p.k }, p.title)));
    if (spec0.target?.type === 'plot') targetType.value = 'plot';
    rows.push(el('label', { class: 'tgt-row' }, 'Target'), el('div', { class: 'tgt-row', style: { display: 'flex', gap: '8px' } }, targetType, targetVal, targetPlot));
  }
  const condSel = add('Condition', el('select', { 'data-testid': 'alert-cond' }));
  const freqSel = add('Frequency', el('select', {}, el('option', { value: 'once', selected: alert?.frequency !== 'once_per_bar' }, 'Once'), el('option', { value: 'once_per_bar', selected: alert?.frequency === 'once_per_bar' }, 'Once per bar')));
  const msgIn = add('Message', el('input', { placeholder: 'Optional', value: alert?.message || '', 'data-testid': 'alert-message' }));
  const allowedCh = S.plan?.limits?.alert_channels || ['app', 'telegram', 'email', 'webhook'];
  const chosen = new Set(alert?.channels || S.notifyDefaults || ['app']);
  const chBoxes = {};
  const chRow = el('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } }, ['app', 'telegram', 'email', 'webhook'].map(c => {
    const ok = allowedCh.includes(c);
    chBoxes[c] = el('input', { type: 'checkbox', checked: c === 'app' || (ok && chosen.has(c)), disabled: c === 'app' || !ok, 'data-testid': `alert-ch-${c}` });
    return el('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', opacity: ok ? 1 : 0.5 }, title: ok ? '' : `Not available on the ${S.plan?.name} plan` },
      chBoxes[c], { app: 'In-app', telegram: 'Telegram', email: 'E-mail', webhook: 'Webhook' }[c]);
  }));
  add('Notify via', chRow);
  // Channels that are allowed but not set up yet: say so and link to the settings
  const chHint = el('div', { class: 'ch-warn', hidden: true, 'data-testid': 'alert-ch-hint' });
  add('', chHint);
  api.notify().then((cfg) => {
    const missing = [];
    if (!cfg.email) missing.push('e-mail address');
    if (!cfg.telegram_chat_id) missing.push('Telegram chat id');
    if (!cfg.webhook_url) missing.push('webhook URL');
    if (!cfg.server?.smtp) missing.push('SMTP server (admin)');
    if (!cfg.server?.telegram) missing.push('Telegram bot (admin)');
    if (!missing.length) return;
    chHint.hidden = false;
    chHint.append(`Not configured: ${missing.join(', ')}. `,
      el('button', { class: 'link-btn', onclick: () => notifySettings(app) }, 'Notification settings…'));
  }).catch(() => {});

  const isShape = () => plotSel && plotSel.selectedOptions[0]?.dataset.shape === '1';
  const renderConds = () => {
    const list = isShape() ? ['signal'] : conds;
    const cur = condSel.value || alert?.cond;
    condSel.innerHTML = '';
    for (const c of list) condSel.append(el('option', { value: c, selected: c === cur }, COND_NAMES[c]));
    if (targetType) {
      const show = !isShape();
      for (const x of rows.filter(r => r.classList?.contains('tgt-row'))) x.hidden = !show;
      targetVal.hidden = targetType.value !== 'value';
      targetPlot.hidden = targetType.value !== 'plot';
    }
  };
  plotSel?.addEventListener('change', renderConds);
  targetType?.addEventListener('change', renderConds);
  renderConds();
  const help = kind === 'indicator'
    ? `Evaluated on the server on the ${alert?.tf || S.tf} timeframe with the same JS code as the chart.`
    : 'Price/drawing alerts are evaluated on the server on 1-minute bars (live data). Moving the drawing moves the alert too.';

  const m = modal({
    title: editing ? 'Edit alert' : 'Create alert', width: '520px',
    body: el('div', {}, el('div', { class: 'form-grid' }, rows), el('div', { class: 'help', style: { marginTop: '12px' } }, help)),
    footer: [
      el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', 'data-testid': 'alert-save', onclick: async () => {
        const a = { id: alert?.id, symbol, kind, cond: condSel.value, frequency: freqSel.value, message: msgIn.value, active: 1,
          channels: Object.entries(chBoxes).filter(([, b]) => b.checked).map(([c]) => c) };
        if (kind === 'price') { a.spec = { price: Number(priceIn.value) }; a.tf = '1m'; }
        else if (kind === 'drawing') { a.spec = { drawing_id: drawing.id, tool: drawing.tool }; a.tf = '1m'; }
        else {
          const custom = (inst?.type || spec0.type) === 'custom';
          a.tf = alert?.tf || S.tf;
          a.spec = {
            type: custom ? 'custom' : (inst?.type || spec0.type), script_id: custom ? (inst?.script_id || spec0.script_id) : undefined,
            params: inst ? (custom ? inst.params || {} : { ...defaultParams(inst.type), ...(inst.params || {}) }) : spec0.params,
            plot: plotSel.value, name: res?.name || spec0.name, tz: S.tzOffset,
            target: isShape() ? null : targetType.value === 'plot' ? { type: 'plot', plot: targetPlot.value } : { type: 'value', value: Number(targetVal.value) },
          };
        }
        try {
          await api.saveAlert(a);
          toast(editing ? 'Alert updated' : 'Alert created', 'ok');
          m.close();
          app.loadAlerts();
        } catch (e) { toast(e.message, 'error'); }
      } }, editing ? 'Save' : 'Create'),
    ],
  });
}

// ======================================================================= admin: data sources
export async function datasourceAdmin(app) {
  const body = el('div', {});
  const m = modal({ title: 'Data Sources (ClickHouse)', width: '820px', body });
  const renderList = async () => {
    body.innerHTML = '';
    let data;
    try { data = await api.adminDatasources(); } catch (e) { body.append(el('div', { class: 'err-box' }, e.message)); return; }
    body.append(el('div', { class: 'help' }, 'Chart history is read from these ClickHouse sources. Symbols appear as PREFIX:SYMBOL (e.g. BINANCE:BTCUSDT). With a live provider, the latest bars and realtime updates come from the exchange.'));
    const list = el('div', { class: 'ds-list' });
    for (const d of data.datasources) {
      list.append(el('div', { class: 'ds-item' },
        el('span', { class: 'ds-pfx' }, d.prefix),
        el('div', { style: { flex: 1, minWidth: 0 } }, el('div', {}, d.name, d.enabled ? '' : el('span', { class: 'muted' }, ' (disabled)')),
          el('div', { class: 'muted', style: { fontSize: '12px', overflowWrap: 'anywhere' } }, `${d.url} · ${d.user} · db: ${d.database} · ${Object.keys(d.tables).length} tables · live: ${d.live || 'none'}`)),
        el('button', { class: 'btn small', onclick: () => renderForm(d, data.timeframes) }, 'Edit'),
        el('button', { class: 'btn small danger', onclick: async () => {
          if (!(await confirm(`Delete source ${d.prefix}?`, { ok: 'Delete', danger: true }))) return;
          await api.adminDeleteDatasource(d.id); await reloadSymbols(app); renderList();
        } }, 'Delete')));
    }
    if (!data.datasources.length) list.append(el('div', { class: 'wl-empty' }, 'No sources yet.'));
    body.append(list, el('button', { class: 'btn primary', 'data-testid': 'ds-new', onclick: () => renderForm(null, data.timeframes) }, '+ New source'));
  };

  const renderForm = (d, tfs) => {
    body.innerHTML = '';
    const isNew = !d;
    d = d || { name: '', prefix: '', url: '', user: 'default', database: '', tables: {}, columns: {}, live: '', enabled: true };
    let host = d.url.replace(/^https?:\/\//, '').replace(/:\d+\/?$/, '');
    let port = (/:(\d+)\/?$/.exec(d.url) || [])[1] || '8123';
    const f = {
      name: el('input', { value: d.name, placeholder: 'Binance Futures' }),
      prefix: el('input', { value: d.prefix, placeholder: 'BINANCE', style: { textTransform: 'uppercase' }, 'data-testid': 'ds-prefix' }),
      scheme: el('select', {}, el('option', { value: 'http', selected: !d.url.startsWith('https') }, 'http'), el('option', { value: 'https', selected: d.url.startsWith('https') }, 'https')),
      host: el('input', { value: host, placeholder: '10.0.0.5 or clickhouse.local', 'data-testid': 'ds-host' }),
      port: el('input', { value: port, style: { maxWidth: '90px' } }),
      user: el('input', { value: d.user, 'data-testid': 'ds-user' }),
      password: el('input', { type: 'password', placeholder: d.has_password ? '•••••• (type to change)' : '', autocomplete: 'new-password', 'data-testid': 'ds-password' }),
      live: el('select', {}, [['', 'None (ClickHouse only)'], ['binance-futures', 'Binance USDT-M Futures'], ['binance-spot', 'Binance Spot']].map(([v, l]) => el('option', { value: v, selected: v === (d.live || '') }, l))),
      enabled: el('input', { type: 'checkbox', checked: d.enabled !== false }),
      database: el('select', { 'data-testid': 'ds-database' }, d.database ? el('option', { value: d.database }, d.database) : null),
    };
    const status = el('div');
    const tablesBox = el('div');
    const colInputs = {};
    const COLS = ['symbol', 'time', 'open', 'high', 'low', 'close', 'volume'];
    const colsBox = el('div', { class: 'form-grid', style: { marginTop: '10px' } });
    for (const c of COLS) { colInputs[c] = el('input', { value: d.columns?.[c] || c }); colsBox.append(el('label', {}, `Column: ${c}`), colInputs[c]); }
    let tableRows = Object.entries(d.tables).map(([tf, table]) => ({ table, tf, use: true }));

    const conn = () => ({
      id: d.id, url: `${f.scheme.value}://${f.host.value.trim()}:${f.port.value.trim() || 8123}`, user: f.user.value,
      password: f.password.value || (d.id ? undefined : ''), database: f.database.value,
    });
    const renderTables = () => {
      tablesBox.innerHTML = '';
      if (!tableRows.length) { tablesBox.append(el('div', { class: 'help' }, 'No tables selected. Use "Scan tables" to find OHLCV tables.')); return; }
      const tb = el('table', { class: 'ds-tables' }, el('tr', {}, el('th', {}, 'Use'), el('th', {}, 'Table'), el('th', {}, 'Timeframe'), el('th', {}, 'Columns')));
      for (const r of tableRows) {
        const use = el('input', { type: 'checkbox', checked: r.use, onchange: (e) => { r.use = e.target.checked; } });
        const tf = el('select', { onchange: (e) => { r.tf = e.target.value; } }, el('option', { value: '' }, '—'), tfs.map(t => el('option', { value: t, selected: t === r.tf }, t)));
        tb.append(el('tr', {}, el('td', {}, use), el('td', {}, r.table), el('td', {}, tf), el('td', { class: 'muted' }, r.ohlc === false ? 'no OHLC' : r.mapping ? Object.values(r.mapping).filter(Boolean).join(', ') : '')));
      }
      tablesBox.append(el('div', { class: 'table-wrap' }, tb));
    };
    const test = async () => {
      status.innerHTML = ''; status.append(el('span', { class: 'muted' }, 'Connecting…'));
      try {
        const r = await api.adminTestDatasource(conn());
        status.innerHTML = '';
        status.append(el('div', { class: 'ok-box' }, `✓ Connected · ClickHouse ${r.version} · ${r.databases.length} databases`));
        const cur = f.database.value;
        f.database.innerHTML = '';
        f.database.append(el('option', { value: '' }, '— select —'), ...r.databases.map(x => el('option', { value: x }, x)));
        if (r.databases.includes(cur)) f.database.value = cur;
      } catch (e) { status.innerHTML = ''; status.append(el('div', { class: 'err-box' }, e.message)); }
    };
    const discover = async () => {
      if (!f.database.value) return toast('Select a database first', 'error');
      status.innerHTML = ''; status.append(el('span', { class: 'muted' }, 'Scanning tables…'));
      try {
        const r = await api.adminDiscoverDatasource(conn());
        const ohlc = r.tables.filter(t => t.ohlc);
        const prev = Object.fromEntries(tableRows.map(x => [x.table, x]));
        tableRows = ohlc.map(t => ({ table: t.table, tf: prev[t.table]?.tf || t.tf_guess || '', use: prev[t.table] ? prev[t.table].use : !!t.tf_guess, mapping: t.mapping }));
        const first = ohlc.find(t => t.tf_guess) || ohlc[0];
        if (first && isNew) for (const c of COLS) if (first.mapping[c]) colInputs[c].value = first.mapping[c];
        status.innerHTML = '';
        status.append(el('div', { class: 'ok-box' }, `${r.tables.length} tables, ${ohlc.length} look like OHLC.`));
        renderTables();
      } catch (e) { status.innerHTML = ''; status.append(el('div', { class: 'err-box' }, e.message)); }
    };
    f.database.addEventListener('change', discover);
    body.append(
      el('div', { class: 'form-grid' },
        el('label', {}, 'Name'), f.name,
        el('label', {}, 'Symbol prefix'), f.prefix,
        el('label', {}, 'Server (IP/host)'), el('div', { style: { display: 'flex', gap: '6px' } }, f.scheme, f.host, f.port),
        el('label', {}, 'User'), f.user,
        el('label', {}, 'Password'), f.password,
        el('label', {}, ''), el('div', {}, el('button', { class: 'btn', 'data-testid': 'ds-test', onclick: test }, 'Test connection')),
        el('label', {}, 'Database'), el('div', { style: { display: 'flex', gap: '6px' } }, f.database, el('button', { class: 'btn', 'data-testid': 'ds-discover', onclick: discover }, 'Scan tables')),
        el('label', {}, 'Live data'), f.live,
        el('label', {}, 'Enabled'), f.enabled),
      el('div', { style: { margin: '10px 0' } }, status),
      el('b', {}, 'Timeframe tables'),
      el('div', { class: 'help' }, 'Pick one table per timeframe. Timeframes without a table (e.g. 30m, 2h, 1W) are aggregated inside ClickHouse from smaller ones.'),
      tablesBox, colsBox,
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', justifyContent: 'flex-end' } },
        el('button', { class: 'btn ghost', onclick: renderList }, 'Back'),
        el('button', { class: 'btn primary', 'data-testid': 'ds-save', onclick: async () => {
          const tables = {};
          for (const r of tableRows) if (r.use && r.tf) tables[r.tf] = r.table;
          const cfg = { ...conn(), name: f.name.value, prefix: f.prefix.value.toUpperCase(), live: f.live.value, enabled: f.enabled.checked, tables, columns: Object.fromEntries(COLS.map(c => [c, colInputs[c].value.trim()])) };
          try {
            await api.adminSaveDatasource(cfg);
            toast('Source saved', 'ok');
            await reloadSymbols(app);
            renderList();
          } catch (e) { toast(e.message, 'error'); }
        } }, 'Save')));
    renderTables();
  };
  renderList();
  return m;
}

async function reloadSymbols(app) {
  const r = await api.symbols();
  app.S.symbols = r.symbols;
  app.S.symMap = new Map(r.symbols.map(s => [s.symbol, s]));
  app.S.sources = Object.fromEntries((r.sources || []).map(x => [x.prefix, x]));
}

// ======================================================================= admin: users
export async function usersAdmin(app) {
  const body = el('div');
  const m = modal({ title: 'Users', width: '640px', body });
  const render = async () => {
    body.innerHTML = '';
    const [{ users }, { plans }] = await Promise.all([api.users(), api.adminPlans()]);
    const tb = el('table', { class: 'ds-tables' }, el('tr', {}, el('th', {}, 'User'), el('th', {}, 'Provider'), el('th', {}, 'Plan'), el('th', {}, 'Admin')));
    for (const u of users) {
      const sel = el('select', { 'data-testid': `user-plan-${u.username}`, onchange: async (e) => {
        try { await api.adminUpdateUser(u.id, { plan: e.target.value }); toast(`${u.username}: plan updated`, 'ok'); } catch (err) { toast(err.message, 'error'); }
      } }, el('option', { value: '' }, u.is_admin ? '(default: unlimited)' : '(default: free)'), plans.map(p => el('option', { value: p.id, selected: p.id === u.plan }, p.name)));
      const adm = el('input', { type: 'checkbox', checked: u.is_admin, onchange: async (e) => {
        try { await api.adminUpdateUser(u.id, { is_admin: e.target.checked }); toast(`${u.username}: updated`, 'ok'); } catch (err) { toast(err.message, 'error'); }
      } });
      tb.append(el('tr', {}, el('td', {}, u.username), el('td', {}, u.auth_provider), el('td', {}, sel), el('td', {}, adm)));
    }
    const un = el('input', { placeholder: 'username', 'data-testid': 'new-user-name' }), pw = el('input', { type: 'password', placeholder: 'password (min 6)', autocomplete: 'new-password', 'data-testid': 'new-user-pass' }), adm = el('input', { type: 'checkbox' });
    const plan = el('select', {}, el('option', { value: '' }, 'default'), plans.map(p => el('option', { value: p.id }, p.name)));
    body.append(el('div', { class: 'table-wrap' }, tb), el('h4', {}, 'New user'),
      el('div', { class: 'form-grid' }, el('label', {}, 'Username'), un, el('label', {}, 'Password'), pw, el('label', {}, 'Plan'), plan, el('label', {}, 'Admin'), adm),
      el('div', { style: { marginTop: '10px', textAlign: 'right' } }, el('button', { class: 'btn primary', 'data-testid': 'new-user-create', onclick: async () => {
        try { await api.createUser({ username: un.value, password: pw.value, is_admin: adm.checked, plan: plan.value }); toast('User created', 'ok'); render(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Create')));
  };
  render();
  return m;
}

export async function plansAdmin() {
  const body = el('div');
  const m = modal({ title: 'Subscription plans', width: '860px', body });
  const render = async () => {
    body.innerHTML = '';
    const { plans, limits } = await api.adminPlans();
    body.append(el('div', { class: 'help' }, 'Empty number = unlimited. Limits are enforced by the server (alerts, scripts, watchlists) and the alert engine (evaluation interval, max active alerts).'));
    const tb = el('table', { class: 'ds-tables' });
    tb.append(el('tr', {}, el('th', {}, 'Limit'), plans.map(p => el('th', {}, p.name, el('div', { class: 'muted' }, p.id)))));
    const inputs = {};
    for (const [k, [label, typ]] of Object.entries(limits)) {
      const row = el('tr', {}, el('td', {}, label));
      for (const p of plans) {
        const v = p.limits[k];
        let inp;
        if (typ === 'bool') inp = el('input', { type: 'checkbox', checked: v !== false });
        else if (typ === 'channels') inp = el('input', { value: (v || []).join(','), placeholder: 'app,telegram,email,webhook', style: { width: '150px' } });
        else inp = el('input', { type: 'number', value: v ?? '', placeholder: '∞', style: { width: '80px' } });
        (inputs[p.id] ||= {})[k] = [inp, typ];
        row.append(el('td', {}, inp));
      }
      tb.append(row);
    }
    const saveRow = el('tr', {}, el('td', {}), plans.map(p => el('td', {}, el('button', { class: 'btn small primary', onclick: async () => {
      const lim = {};
      for (const [k, [inp, typ]] of Object.entries(inputs[p.id])) {
        lim[k] = typ === 'bool' ? inp.checked : typ === 'channels' ? inp.value.split(',').map(x => x.trim()).filter(Boolean) : (inp.value === '' ? null : Number(inp.value));
      }
      try { await api.adminSavePlan({ ...p, limits: lim }); toast(`${p.name} saved`, 'ok'); } catch (e) { toast(e.message, 'error'); }
    } }, 'Save'))));
    tb.append(saveRow);
    const nid = el('input', { placeholder: 'id, e.g. team' }), nname = el('input', { placeholder: 'Name' });
    body.append(el('div', { class: 'table-wrap', style: { maxHeight: '60vh' } }, tb), el('h4', {}, 'New plan'),
      el('div', { style: { display: 'flex', gap: '8px' } }, nid, nname, el('button', { class: 'btn', onclick: async () => {
        try { await api.adminSavePlan({ id: nid.value, name: nname.value, sort: plans.length, limits: plans[0]?.limits || {} }); render(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Add')));
  };
  render();
  return m;
}

// ======================================================================= alert history
const EVENT_NAMES = { created: 'Created', updated: 'Edited', paused: 'Paused', resumed: 'Resumed', deleted: 'Deleted',
  triggered: 'Triggered', delivered: 'Sent', failed: 'Failed', deactivated: 'Stopped' };
const CHANNEL_NAMES = { app: 'in-app', telegram: 'Telegram', email: 'e-mail', webhook: 'webhook' };

function fmtLogTime(ms) {
  const d = new Date(ms);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function logText(app, e) {
  const price = e.price ? app.fmtPrice(e.price) : '';
  const bar = e.bar_time ? ` · bar ${new Date(e.bar_time * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  switch (e.event) {
    case 'triggered': return `at ${price}${bar}`;
    case 'delivered': return `via ${CHANNEL_NAMES[e.channel] || e.channel}`;
    case 'failed': return `via ${CHANNEL_NAMES[e.channel] || e.channel}: ${e.detail}`;
    case 'deactivated': return e.detail;
    default: return e.detail || '';
  }
}

/** One history entry (Alerts tab list or dialog). */
export function logRow(app, e, { compact = false } = {}) {
  return el('div', { class: 'log-row', 'data-event': e.event },
    el('span', { class: `log-ev ev-${e.event}` }, EVENT_NAMES[e.event] || e.event),
    el('div', { class: 'log-main' }, `${app.symbolName(e.symbol)} · ${e.summary}`),
    el('div', { class: 'log-sub' }, `${fmtLogTime(e.created_ms)} · ${logText(app, e)}`));
}

/** Full alert history: filter by alert and event type, page back in time. */
export async function alertLog(app, { alertId = '' } = {}) {
  const S = app.S;
  const alertSel = el('select', { 'data-testid': 'log-alert' },
    el('option', { value: '' }, 'All alerts'),
    (S.alerts || []).map(a => el('option', { value: a.id, selected: a.id === alertId }, `${app.symbolName(a.symbol)} · ${a.message || alertSummaryText(a)}`)));
  if (alertId && !(S.alerts || []).some(a => a.id === alertId)) alertSel.append(el('option', { value: alertId, selected: true }, 'Deleted alert'));
  const evSel = el('select', { 'data-testid': 'log-event' },
    el('option', { value: '' }, 'All events'),
    el('option', { value: 'triggered' }, 'Triggers'),
    el('option', { value: 'delivered,failed' }, 'Deliveries'),
    el('option', { value: 'failed' }, 'Failed deliveries'),
    el('option', { value: 'created,updated,paused,resumed,deleted,deactivated' }, 'Changes'));
  const tbody = el('tbody');
  const more = el('button', { class: 'btn small', 'data-testid': 'log-more' }, 'Load older');
  const empty = el('div', { class: 'wl-empty', hidden: true }, 'No entries.');
  let oldest = 0;
  const load = async (reset) => {
    if (reset) { tbody.innerHTML = ''; oldest = 0; }
    const { log } = await api.alertLog({ alert_id: alertSel.value, event: evSel.value, before: oldest || '', limit: 100 });
    for (const e of log) {
      tbody.append(el('tr', { 'data-event': e.event },
        el('td', { class: 'nowrap' }, fmtLogTime(e.created_ms)),
        el('td', { class: 'nowrap' }, el('span', { class: `log-ev ev-${e.event}` }, EVENT_NAMES[e.event] || e.event)),
        el('td', {}, `${app.symbolName(e.symbol)} · ${e.summary}`),
        el('td', {}, logText(app, e))));
    }
    if (log.length) oldest = log[log.length - 1].created_ms;
    more.hidden = log.length < 100;
    empty.hidden = !!tbody.children.length;
  };
  alertSel.onchange = evSel.onchange = () => load(true);
  more.onclick = () => load(false);
  modal({
    title: 'Alert history', width: '980px',
    body: el('div', {},
      el('div', { class: 'log-filters' }, alertSel, evSel,
        el('span', { class: 'muted', style: { alignSelf: 'center', fontSize: '12px' } }, 'Kept for 180 days. Deliveries are logged a few seconds after a trigger.')),
      el('div', { class: 'log-table-wrap' }, el('table', { class: 'log-table', 'data-testid': 'log-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Event'), el('th', {}, 'Alert'), el('th', {}, 'Details'))), tbody), empty),
      el('div', { style: { marginTop: '8px' } }, more)),
  });
  await load(true);
}

function alertSummaryText(a) {
  const sp = a.spec || {};
  if (a.kind === 'price') return `Price ${COND_NAMES[a.cond] || a.cond} ${sp.price}`;
  if (a.kind === 'drawing') return `Drawing (${sp.tool || '?'}) ${COND_NAMES[a.cond] || a.cond}`;
  return `${sp.name || sp.type} · ${sp.plot} ${COND_NAMES[a.cond] || a.cond}`;
}

export async function notifySettings(app) {
  const S = app.S;
  const cfg = await api.notify();
  const allowed = S.plan?.limits?.alert_channels || ['app', 'telegram', 'email', 'webhook'];
  const email = el('input', { type: 'email', value: cfg.email, placeholder: 'you@example.com', 'data-testid': 'notify-email' });
  const chat = el('input', { value: cfg.telegram_chat_id, placeholder: 'e.g. 123456789', 'data-testid': 'notify-telegram' });
  const hook = el('input', { value: cfg.webhook_url, placeholder: 'https://…', 'data-testid': 'notify-webhook' });
  const defs = {};
  const defRow = el('div', { style: { display: 'flex', gap: '12px', flexWrap: 'wrap' } }, ['telegram', 'email', 'webhook'].map(c => {
    defs[c] = el('input', { type: 'checkbox', checked: (cfg.default_channels || []).includes(c), disabled: !allowed.includes(c) });
    return el('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', opacity: allowed.includes(c) ? 1 : 0.5 } }, defs[c], c);
  }));
  const out = el('div', { style: { marginTop: '10px' } });
  const collect = () => ({ email: email.value, telegram_chat_id: chat.value, webhook_url: hook.value, default_channels: ['app', ...Object.entries(defs).filter(([, b]) => b.checked).map(([c]) => c)] });
  const m = modal({
    title: 'Alert notifications', width: '520px',
    body: el('div', {},
      el('div', { class: 'help' }, 'Alerts are evaluated on the server, so notifications arrive even when this page is closed.'),
      el('div', { class: cfg.server?.smtp && cfg.server?.telegram ? 'ok-box' : 'err-box', style: { marginBottom: '10px' }, 'data-testid': 'notify-server-status' },
        `Server: e-mail (SMTP) ${cfg.server?.smtp ? 'configured' : 'not configured'} · Telegram bot ${cfg.server?.telegram ? 'configured' : 'not configured'}`,
        S.user?.is_admin && !(cfg.server?.smtp && cfg.server?.telegram)
          ? el('span', {}, ' — ', el('button', { class: 'link-btn', onclick: () => { m.close(); notifyAdmin(app); } }, 'Notification servers…'))
          : (!(cfg.server?.smtp && cfg.server?.telegram) ? ' — ask your administrator' : null)),
      el('div', { class: 'form-grid' },
        el('label', {}, 'E-mail'), email,
        el('label', {}, 'Telegram chat id'), chat,
        el('label', {}, 'Webhook URL'), hook,
        el('label', {}, 'Default channels'), defRow),
      el('div', { class: 'help', style: { marginTop: '10px' } }, 'Telegram: open the bot configured by your administrator, press Start, then get your chat id from @userinfobot. Webhook receives a JSON POST per alert.'),
      out),
    footer: [
      el('button', { class: 'btn', 'data-testid': 'notify-test', onclick: async () => {
        try {
          await api.saveNotify(collect());
          const chans = ['telegram', 'email', 'webhook'].filter(c => ({ telegram: chat.value, email: email.value, webhook: hook.value })[c]);
          const { result } = await api.testNotify(chans);
          out.innerHTML = '';
          out.append(el('div', { class: Object.values(result).every(v => v === 'ok') ? 'ok-box' : 'err-box' }, Object.entries(result).map(([k, v]) => `${k}: ${v}`).join('\n') || 'Nothing configured'));
        } catch (e) { toast(e.message, 'error'); }
      } }, 'Send test'),
      el('button', { class: 'btn primary', 'data-testid': 'notify-save', onclick: async () => {
        try { const r = await api.saveNotify(collect()); S.notifyDefaults = r.default_channels; toast('Saved', 'ok'); m.close(); } catch (e) { toast(e.message, 'error'); }
      } }, 'Save'),
    ],
  });
}

export async function notifyAdmin() {
  const g = await api.adminNotify();
  const host = el('input', { value: g.smtp.host || '', placeholder: 'smtp.example.com' });
  const port = el('input', { type: 'number', value: g.smtp.port || 587 });
  const sec = el('select', {}, [['starttls', 'STARTTLS'], ['ssl', 'SSL/TLS'], ['none', 'None']].map(([v, l]) => el('option', { value: v, selected: (g.smtp.security || 'starttls') === v }, l)));
  const user = el('input', { value: g.smtp.user || '', autocomplete: 'off' });
  const pass = el('input', { type: 'password', placeholder: g.smtp.has_password ? '•••••• (type to change)' : '', autocomplete: 'new-password' });
  const from = el('input', { value: g.smtp.from || '', placeholder: 'Charting <alerts@example.com>' });
  const bot = el('input', { type: 'password', placeholder: g.telegram.has_bot_token ? '•••••• (type to change)' : '123456:ABC…', autocomplete: 'off' });
  const m = modal({
    title: 'Notification servers', width: '540px',
    body: el('div', {},
      el('b', {}, 'E-mail (SMTP)'),
      el('div', { class: 'form-grid', style: { marginTop: '8px' } },
        el('label', {}, 'Host'), host, el('label', {}, 'Port'), port, el('label', {}, 'Security'), sec,
        el('label', {}, 'User'), user, el('label', {}, 'Password'), pass, el('label', {}, 'From'), from),
      el('b', { style: { display: 'block', marginTop: '16px' } }, 'Telegram'),
      el('div', { class: 'form-grid', style: { marginTop: '8px' } }, el('label', {}, 'Bot token'), bot),
      el('div', { class: 'help', style: { marginTop: '8px' } }, 'Create a bot with @BotFather and paste its token. Secrets are stored encrypted.')),
    footer: [el('button', { class: 'btn primary', onclick: async () => {
      try {
        await api.adminSaveNotify({ smtp: { host: host.value, port: port.value, security: sec.value, user: user.value, password: pass.value, from: from.value }, telegram: { bot_token: bot.value } });
        toast('Saved', 'ok'); m.close();
      } catch (e) { toast(e.message, 'error'); }
    } }, 'Save')],
  });
}

/** Chart settings: candle body / border / wick colors, line color, background, grid. Live preview. */
export function chartSettings(app) {
  const S = app.S;
  const before = { ...S.style };
  const st = S.style;
  let frame = 0;
  const preview = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => app.applyStyle()); };
  const color = (k, testid) => el('input', { type: 'color', value: st[k], 'data-testid': testid || `cs-${k}`, oninput: (e) => { st[k] = e.target.value; preview(); } });
  const check = (k) => el('input', { type: 'checkbox', checked: !!st[k], 'data-testid': `cs-${k}`, onchange: (e) => { st[k] = e.target.checked; preview(); } });
  const row = (label, k, ...colors) => [el('label', {}, k ? el('span', { class: 'cs-check' }, check(k), ' ', label) : label), el('div', { class: 'cs-colors' }, colors)];
  const body = el('div', { class: 'form-grid cs-grid' },
    el('div', { class: 'form-section' }, 'Symbol'),
    ...row('Body', 'body', color('upColor'), color('downColor')),
    ...row('Borders', 'borderVisible', color('borderUpColor'), color('borderDownColor')),
    ...row('Wick', 'wickVisible', color('wickUpColor'), color('wickDownColor')),
    ...row('Line / area', null, color('lineColor')),
    el('div', { class: 'form-section' }, 'Canvas'),
    ...row('Background', null, color('background')),
    ...row('Grid lines', 'gridVisible', color('gridColor')),
  );
  const m = modal({
    title: 'Chart settings', width: '420px', body,
    onClose: () => { if (!saved) { Object.assign(S.style, before); app.applyStyle(); } },
    footer: [
      el('button', { class: 'btn ghost', 'data-testid': 'cs-defaults', onclick: () => {
        Object.assign(S.style, app.DEFAULT_STYLE);
        for (const inp of body.querySelectorAll('input')) {
          const k = inp.dataset.testid.slice(3);
          if (inp.type === 'checkbox') inp.checked = !!S.style[k]; else inp.value = S.style[k];
        }
        app.applyStyle();
      } }, 'Defaults'),
      el('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn primary', 'data-testid': 'cs-save', onclick: () => { saved = true; app.saveLayout(); m.close(); } }, 'Save'),
    ],
  });
  let saved = false;
}

export function changePassword() {
  const o = el('input', { type: 'password', autocomplete: 'current-password' }), n = el('input', { type: 'password', autocomplete: 'new-password' });
  const m = modal({
    title: 'Change password', width: '400px', body: el('div', { class: 'form-grid' }, el('label', {}, 'Current password'), o, el('label', {}, 'New password'), n),
    footer: [el('button', { class: 'btn primary', onclick: async () => {
      try { await api.changePassword(o.value, n.value); toast('Password changed', 'ok'); m.close(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Save')],
  });
}
