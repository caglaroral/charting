// Thin fetch wrapper. Emits 'auth-required' on 401 so the app can show the login screen.

export const events = new EventTarget();

async function req(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401) events.dispatchEvent(new Event('auth-required'));
  if (!r.ok) {
    if (r.status === 402) events.dispatchEvent(new Event('plan-limit'));
    const err = new Error((data && (data.error + (data.detail ? ': ' + data.detail : ''))) || r.statusText);
    err.status = r.status;
    throw err;
  }
  return data;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

export const api = {
  authConfig: () => req('GET', '/api/auth/config'),
  login: (username, password) => req('POST', '/api/auth/login', { username, password }),
  logout: () => req('POST', '/api/auth/logout'),
  changePassword: (old_password, new_password) => req('POST', '/api/auth/password', { old_password, new_password }),
  me: () => req('GET', '/api/me'),
  users: () => req('GET', '/api/admin/users'),
  createUser: (u) => req('POST', '/api/admin/users', u),
  adminDatasources: () => req('GET', '/api/admin/datasources'),
  adminTestDatasource: (cfg) => req('POST', '/api/admin/datasources/test', cfg),
  adminDiscoverDatasource: (cfg) => req('POST', '/api/admin/datasources/discover', cfg),
  adminSaveDatasource: (cfg) => req('POST', '/api/admin/datasources', cfg),
  adminNotify: () => req('GET', '/api/admin/notify'),
  adminSaveNotify: (cfg) => req('PUT', '/api/admin/notify', cfg),
  adminPlans: () => req('GET', '/api/admin/plans'),
  adminSavePlan: (p) => req('PUT', '/api/admin/plans', p),
  adminDeletePlan: (id) => req('DELETE', '/api/admin/plans/' + encodeURIComponent(id)),
  adminUpdateUser: (id, patch) => req('POST', '/api/admin/users/' + encodeURIComponent(id), patch),
  notify: () => req('GET', '/api/notify'),
  saveNotify: (cfg) => req('PUT', '/api/notify', cfg),
  testNotify: (channels) => req('POST', '/api/notify/test', { channels }),
  adminDeleteDatasource: (id) => req('DELETE', '/api/admin/datasources/' + encodeURIComponent(id)),

  symbols: () => req('GET', '/api/symbols'),
  bars: (symbol, tf, to, limit = 1500) => req('GET', '/api/bars?' + qs({ symbol, tf, to, limit })),
  quotes: (symbols) => req('GET', '/api/quotes?' + qs({ symbols: symbols.join(',') })),
  symbolInfo: (symbol) => req('GET', '/api/symbol?' + qs({ symbol })),

  watchlists: () => req('GET', '/api/watchlists'),
  saveWatchlist: (wl) => req('POST', '/api/watchlists', wl),
  deleteWatchlist: (id) => req('DELETE', '/api/watchlists/' + encodeURIComponent(id)),

  drawings: (symbol) => req('GET', '/api/drawings?' + qs({ symbol })),
  saveDrawings: (symbol, drawings) => req('POST', '/api/drawings', { symbol, drawings }),
  deleteDrawings: (symbol, ids) => req('POST', '/api/drawings/delete', { symbol, ids }),

  getSetting: (key) => req('GET', '/api/settings/' + encodeURIComponent(key)),
  setSetting: (key, value) => req('PUT', '/api/settings/' + encodeURIComponent(key), { value }),

  alerts: () => req('GET', '/api/alerts'),
  saveAlert: (a) => req('POST', '/api/alerts', a),
  deleteAlert: (id) => req('DELETE', '/api/alerts/' + encodeURIComponent(id)),
  alertLog: (o = {}) => req('GET', '/api/alerts/log?' + qs(o)),
  alertEvents: (since) => req('GET', '/api/alerts/events?' + qs({ since })),

  screenerMeta: () => req('GET', '/api/screener/meta'),
  screenerRun: (spec) => req('POST', '/api/screener/run', { spec }),
  screens: () => req('GET', '/api/screens'),
  saveScreen: (s) => req('POST', '/api/screens', s),
  deleteScreen: (id) => req('DELETE', '/api/screens/' + encodeURIComponent(id)),
  backtest: (body) => req('POST', '/api/backtest', body),
  papers: () => req('GET', '/api/papers'),
  savePaper: (p) => req('POST', '/api/papers', p),
  deletePaper: (id) => req('DELETE', '/api/papers/' + encodeURIComponent(id)),
  resetPaper: (id) => req('POST', '/api/papers/' + encodeURIComponent(id) + '/reset', {}),
  paperTrades: (id, run) => req('GET', '/api/papers/' + encodeURIComponent(id) + '/trades?' + qs({ run })),

  scripts: () => req('GET', '/api/scripts'),
  saveScript: (s) => req('POST', '/api/scripts', s),
  deleteScript: (id) => req('DELETE', '/api/scripts/' + encodeURIComponent(id)),
};
