// Small DOM helpers: element builder, modals, dropdown menus, toasts, confirm/prompt dialogs.

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const $ = (s, root = document) => root.querySelector(s);

// ---------------------------------------------------------------- toasts
export function toast(msg, kind = 'info', title = null, ms = 4000) {
  const t = el('div', { class: `toast ${kind}`, role: 'status' }, title ? el('b', {}, title) : null, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// ---------------------------------------------------------------- modals
export function modal({ title, body, footer, width, cls, onClose } = {}) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = el('div', { class: `modal ${cls || ''}`, role: 'dialog', 'aria-label': title, style: width ? { '--w': width } : null },
    el('div', { class: 'modal-head' }, el('span', {}, title), el('button', { class: 'x', title: 'Close', 'aria-label': 'Close', onclick: close }, '×')),
    el('div', { class: 'modal-body' }, body),
    footer ? el('div', { class: 'modal-foot' }, footer) : null);
  const back = el('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  $('#modal-root').append(back);
  document.addEventListener('keydown', onKey, true);
  return { close, box, body: box.querySelector('.modal-body') };
}

export function confirmDialog(text, { ok = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const m = modal({
      title: 'Confirm', body: el('div', {}, text), width: '400px',
      onClose: () => { if (!done) resolve(false); },
      footer: [
        el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, 'data-testid': 'confirm-ok', onclick: () => { done = true; m.close(); resolve(true); } }, ok),
      ],
    });
  });
}

export function promptDialog(title, value = '', { multiline = false, label = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    const input = multiline ? el('textarea', { rows: 4, style: { width: '100%' } }) : el('input', { style: { width: '100%' } });
    input.value = value;
    const submit = () => { done = true; m.close(); resolve(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); submit(); } });
    const m = modal({
      title, width: '420px', body: el('div', {}, label ? el('div', { class: 'help' }, label) : null, input),
      onClose: () => { if (!done) resolve(null); },
      footer: [el('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'), el('button', { class: 'btn primary', onclick: submit }, 'OK')],
    });
    setTimeout(() => { input.focus(); input.select?.(); }, 0);
  });
}

// ---------------------------------------------------------------- dropdown menus
let openMenu = null;
export function closeMenus() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

/** items: [{label, onClick, active, kbd, sep, title, el}] */
export function showMenu(anchor, items, { align = 'left' } = {}) {
  closeMenus();
  const m = el('div', { class: 'dd-menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { m.append(el('div', { class: 'dd-sep' })); continue; }
    if (it.title) { m.append(el('div', { class: 'dd-title' }, it.title)); continue; }
    if (it.el) { m.append(it.el); continue; }
    m.append(el('div', {
      class: `dd-item ${it.active ? 'active' : ''}`, role: 'menuitem', 'data-testid': it.testid,
      onclick: () => { closeMenus(); it.onClick?.(); },
    }, it.icon || null, it.label, it.kbd ? el('span', { class: 'kbd' }, it.kbd) : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(4, Math.min(left, window.innerWidth - mw - 4));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 4) top = Math.max(4, r.top - mh - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  openMenu = m;
  return m;
}

// ---------------------------------------------------------------- formatting
export function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + ' T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + ' B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + ' M';
  if (a >= 1e4) return (v / 1e3).toFixed(2) + ' K';
  return v.toFixed(digits);
}

export function decimalsOf(values) {
  let d = 0;
  for (const v of values) {
    if (v == null) continue;
    const s = String(v);
    if (s.includes('e-')) { d = Math.max(d, Number(s.split('e-')[1]) + 2); continue; }
    const i = s.indexOf('.');
    if (i >= 0) d = Math.max(d, s.length - i - 1);
  }
  return Math.min(d, 10);
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const ICONS = {
  eye: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.1 6.1C3.6 7.8 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 4.2-.9" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="1.6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zM10 19a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  code: '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="11" width="14" height="9" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="11" width="14" height="9" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M8 11V8a4 4 0 0 1 7.5-2" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="8" y="8" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 16V4h12" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  text: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 5h14M12 5v15" stroke="currentColor" stroke-width="1.8"/></svg>',
  caret: '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>',
};

ICONS.braces = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 3-2 3 1 0 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 3 2 3-1 0-2 1.5-2 3v2c0 2-1 3-3 3" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
ICONS.up = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>';
ICONS.down = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>';
ICONS.maximize = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>';
ICONS.history = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
ICONS.collapse = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 5l5 5 5-5M7 19l5-5 5 5" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>';
ICONS.expand = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 9l5-5 5 5M7 15l5 5 5-5" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>';
ICONS.restore = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" stroke="currentColor" stroke-width="1.7" fill="none"/></svg>';

export const ic = (name) => el('span', { html: ICONS[name], style: { display: 'inline-flex' } });
