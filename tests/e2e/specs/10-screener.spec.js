// TC-SCREEN / TC-TEST / TC-PAPER: screener (saved screens, screener alerts), strategy tester, paper trading.
// Runs against the backtester service through the backend. Uses the throw-away users only.
import { test, expect, devices } from '@playwright/test';
import { login, user, trackErrors } from '../helpers.js';

const cleanup = (page) => page.evaluate(async () => {
  const j = async (u, o) => (await fetch(u, o)).json();
  for (const s of (await j('/api/screens')).screens) await fetch('/api/screens/' + s.id, { method: 'DELETE' });
  for (const p of (await j('/api/papers')).papers) await fetch('/api/papers/' + p.id, { method: 'DELETE' });
  for (const s of (await j('/api/strategies')).strategies) await fetch('/api/strategies/' + s.id, { method: 'DELETE' });
  for (const a of (await j('/api/alerts')).alerts) await fetch('/api/alerts/' + a.id, { method: 'DELETE' });
  for (const k of ['sc.cur', 'st.form', 'st.cur', 'bp.tab', 'chart.strategy', 'rep.page']) localStorage.removeItem(k);
  // the strategy on the chart and the active screen are saved with the chart layout
  const L = (await j('/api/settings/layout')).value;
  if (L && (L.chartStrategy || L.activeScreen || L.screenTab)) {
    await fetch('/api/settings/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { ...L, chartStrategy: null, activeScreen: null, screenTab: null } }) });
  }
});

const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json() };
}, [method, url, body]);

const RSI_SPEC = { source: 'BINANCE', tf: '1h', conds: [{ a: { ind: 'rsi', p: [14] }, op: '<', b: { const: 50 } }], columns: [], universe: { type: 'all' } };
const STRATEGY = { tf: '1h', long: { entry: [{ a: { ind: 'rsi', p: [14] }, op: '<', b: { const: 30 } }], stop: { k: 'pct', v: 0.02 }, tp: { k: 'pct', v: 0.04 } }, short: null };

test.beforeEach(async ({ page }) => { await login(page); await cleanup(page); });
test.afterEach(async ({ page }) => { await cleanup(page); });

test('TC-SCREEN-01 screener: filter, column, sort, save / rename / save as / open / delete', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.click('[data-testid=bp-screener]');
  await expect(page.locator('[data-testid=sc-table]')).toBeVisible({ timeout: 120_000 });
  const all = await page.locator('[data-testid=sc-table] tbody tr').count();
  expect(all).toBeGreaterThan(50);
  // filter RSI(14) < 50 on 1h
  await page.selectOption('[data-testid=sc-tf]', '1h');
  await page.click('[data-testid=filter-add]');
  await page.selectOption('[data-testid=cond-a] [data-role=ind]', 'rsi');
  await page.selectOption('[data-testid=cond-op]', '<');
  await page.fill('[data-testid=cond-b] [data-role=value]', '50');
  await page.click('[data-testid=cond-ok]');
  await expect(page.locator('[data-testid=filter-chip]')).toHaveText(/RSI\(14\) < 50/);
  // a column: EMA(200) on 4h
  await page.click('[data-testid=col-add]');
  await page.selectOption('[data-testid=col-a] [data-role=ind]', 'ema');
  await page.fill('[data-testid=col-a] [data-role=p0]', '200');
  await page.selectOption('[data-testid=col-a] [data-role=tf]', '4h');
  await page.click('[data-testid=col-ok]');
  await expect(page.locator('[data-testid=sc-table] th', { hasText: 'EMA(200) 4h' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid=sc-table] th', { hasText: 'RSI(14)' })).toBeVisible();
  await expect(page.locator('[data-testid=sc-status]')).toContainText(/\d+ of \d+ match/);
  const n = await page.locator('[data-testid=sc-table] tbody tr').count();
  expect(n).toBeLessThan(all);
  // every row has RSI < 50 (column after Symbol, Price, Chg, Vol, Regime)
  const rsis = await page.locator('[data-testid=sc-table] tbody tr td:nth-child(6)').allTextContents();
  for (const v of rsis) expect(parseFloat(v)).toBeLessThan(50);
  // sort by RSI ascending
  await page.locator('[data-testid=sc-table] th', { hasText: 'RSI(14)' }).click();
  await page.locator('[data-testid=sc-table] th', { hasText: 'RSI(14)' }).click();
  const sorted = (await page.locator('[data-testid=sc-table] tbody tr td:nth-child(6)').allTextContents()).map(parseFloat);
  expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
  // a row opens its symbol on the chart
  const sym = await page.locator('[data-testid=sc-table] tbody tr').nth(1).getAttribute('data-sym');
  await page.locator('[data-testid=sc-table] tbody tr').nth(1).click();
  await page.waitForFunction((s) => __app.S.symbol === s, sym);

  // save, rename, save as, open, delete
  await page.click('[data-testid=sc-menu]');
  await page.click('[data-testid=sc-save]');
  await page.fill('.modal input', 'e2e oversold');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e oversold$/);
  await page.click('[data-testid=sc-menu]');
  await page.click('[data-testid=sc-rename]');
  await page.fill('.modal input', 'e2e renamed');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e renamed$/);
  await page.click('[data-testid=sc-menu]');
  await page.click('[data-testid=sc-saveas]');
  await page.fill('.modal input', 'e2e copy');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e copy$/);
  let screens = (await api(page, 'GET', '/api/screens')).body.screens;
  expect(screens.map(s => s.name).sort()).toEqual(['e2e copy', 'e2e renamed']);
  expect(screens[0].spec.columns[0]).toMatchObject({ ind: 'ema', p: [200], tf: '4h' });
  // edit the copy: a change marks it unsaved, Save stores it
  await page.selectOption('[data-testid=sc-tf]', '4h');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e copy \*$/);
  await page.click('[data-testid=sc-menu]');
  await page.click('[data-testid=sc-save]');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e copy$/);
  screens = (await api(page, 'GET', '/api/screens')).body.screens;
  expect(screens.find(s => s.name === 'e2e copy').spec.tf).toBe('4h');
  // open the other one, delete it
  await page.click('[data-testid=sc-menu]');
  await page.locator('[data-testid=sc-open]', { hasText: 'e2e renamed' }).click();
  await expect(page.locator('[data-testid=sc-tf]')).toHaveValue('1h');
  await page.click('[data-testid=sc-menu]');
  await page.click('[data-testid=sc-delete]');
  await page.click('[data-testid=confirm-ok]');
  await expect.poll(async () => (await api(page, 'GET', '/api/screens')).body.screens.length).toBe(1);
  expect(errors).toEqual([]);
});

test('TC-SCREEN-02 screener alert from a saved screen; free plan limits', async ({ page }) => {
  test.setTimeout(180_000);
  await page.click('[data-testid=bp-screener]');
  await expect(page.locator('[data-testid=sc-status]')).toContainText(/match/, { timeout: 120_000 });
  await page.click('[data-testid=sc-alert]');
  await page.click('[data-testid=confirm-ok]');            // save the screen first
  await page.fill('.modal input', 'e2e alert screen');
  await page.keyboard.press('Enter');
  await page.selectOption('[data-testid=sa-freq]', 'once_per_bar');
  await page.click('[data-testid=sa-create]');
  await page.click('.rp-tab[data-tab=alerts]');
  const item = page.locator('.al-item').first();
  await expect(item).toContainText('Screener');
  await expect(item).toContainText('Screen "e2e alert screen": new matches');
  const alerts = (await api(page, 'GET', '/api/alerts')).body.alerts;
  expect(alerts[0]).toMatchObject({ kind: 'screener', cond: 'entered', symbol: 'BINANCE:*' });
  // deleting the screen: the alert is deactivated by the engine (not checked here: it waits for a bar)

  // free plan: no screener alerts, 5 saved screens
  await login(page, user('free'));
  await cleanup(page);
  for (let i = 0; i < 5; i++) expect((await api(page, 'POST', '/api/screens', { name: `f${i}`, spec: RSI_SPEC })).status).toBe(200);
  const over = await api(page, 'POST', '/api/screens', { name: 'f5', spec: RSI_SPEC });
  expect(over.status).toBe(402);
  const sid = (await api(page, 'GET', '/api/screens')).body.screens[0].id;
  const al = await api(page, 'POST', '/api/alerts', { kind: 'screener', spec: { screen_id: sid }, channels: ['app'] });
  expect(al.status).toBe(402);
  // invalid conditions are rejected by the backtester's validation
  await api(page, 'DELETE', '/api/screens/' + sid);
  const bad = await api(page, 'POST', '/api/screens', { name: 'bad', spec: { ...RSI_SPEC, conds: [{ a: { ind: 'nope' }, op: '<', b: { const: 1 } }] } });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toContain('unknown indicator');
  await cleanup(page);
});

test('TC-TEST-01 strategy tester: backtest, results, trades on the chart', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.click('[data-testid=bp-tester]');
  await page.click('[data-testid=st-run]');               // no entry condition yet
  await expect(page.locator('[data-testid=st-results]')).toContainText('long entry', { timeout: 30_000 });
  await page.click('[data-testid=long-entry-add]');
  await page.fill('[data-testid=cond-b] [data-role=value]', '30');
  await page.click('[data-testid=cond-ok]');
  await page.selectOption('[data-testid=st-tf]', '1h');
  await page.fill('[data-testid=long-stop-v]', '2');
  await page.fill('[data-testid=long-tp-v]', '4');
  await page.click('[data-testid=st-run]');
  // report: overview with the equity curve, performance, list of trades, symbols
  await expect(page.locator('[data-testid=st-total]')).toContainText('Trades', { timeout: 180_000 });
  await expect(page.locator('[data-testid=st-equity] canvas').first()).toBeVisible();
  await page.click('[data-testid=rep-performance]');
  await expect(page.locator('[data-testid=st-perf]')).toContainText('Max consecutive losses');
  await page.click('[data-testid=rep-symbols]');
  await expect(page.locator('[data-testid=st-table]')).toBeVisible();
  const trades = parseInt(await page.locator('[data-testid=st-table] tbody tr td:nth-child(2)').first().textContent());
  expect(trades).toBeGreaterThan(5);
  await page.click('[data-testid=rep-trades]');
  await expect(page.locator('[data-testid=st-trades] tbody tr')).toHaveCount(trades);
  await expect(page.locator('[data-testid=st-trades] tbody tr').first()).toContainText(/TP|SL/);
  await page.click('[data-testid=rep-symbols]');
  await page.locator('[data-testid=st-table] tbody tr').first().click();
  await expect(page.locator('[data-testid=trades-table] tbody tr')).toHaveCount(trades);
  await page.waitForFunction(() => __app.S.tf === '1h');
  await page.locator('[data-testid=trades-table] tbody tr').nth(2).click();
  // the trade is on screen: its entry bar inside the visible range
  await page.waitForTimeout(1500);
  const visible = await page.evaluate(() => {
    const r = __app.chart.timeScale().getVisibleRange();
    return r && r.to > r.from;
  });
  expect(visible).toBeTruthy();
  // plan limit: free users test at most 5 symbols per run
  await login(page, user('free'));
  const r = await api(page, 'POST', '/api/backtest', { source: 'BINANCE', strategy: STRATEGY,
    symbols: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT'], start: 1735689600, end: 1764547200 });
  expect(r.status).toBe(402);
  expect(errors.filter(e => !/status of 40[02]/.test(e))).toEqual([]);   // the 400 / 402 above are expected
});

test('TC-PAPER-01 paper trading: create, edit, pause / resume, restart, delete; the engine advances it', async ({ page }) => {
  test.setTimeout(240_000);
  await page.click('[data-testid=bp-paper]');
  await page.click('[data-testid=pp-new]');
  await page.fill('[data-testid=pp-name]', 'e2e paper');
  await page.click('.modal [data-testid=long-entry-add]');
  await page.click('[data-testid=cond-ok]');
  await page.selectOption('.modal [data-testid=st-tf]', '1m');
  // symbols from the symbol search, several at once
  await page.click('[data-testid=pp-sym-clear]');
  await page.click('[data-testid=pp-sym-add]');
  for (const sym of ['BTCUSDT', 'DOGEUSDT']) {
    await page.fill('[data-testid=symbol-search]', sym);
    await page.click(`.search-item[data-symbol="BINANCE:${sym}"]`);
  }
  await page.click('[data-testid=search-done]');
  await expect(page.locator('.modal [data-testid=sym-chip]')).toHaveCount(2);
  await page.click('[data-testid=pp-save]');
  const row = page.locator('[data-testid=pp-table] tbody tr').first();
  await expect(row).toContainText('e2e paper');
  await expect(row).toContainText('running');
  let p = (await api(page, 'GET', '/api/papers')).body.papers[0];
  expect(p).toMatchObject({ run: 1, active: true, symbols: ['BINANCE:BTCUSDT', 'BINANCE:DOGEUSDT'] });
  // the engine (every 30 s) records a state per symbol
  await expect.poll(async () => Object.keys((await api(page, 'GET', '/api/papers')).body.papers[0].state).length,
    { timeout: 120_000, intervals: [5000] }).toBe(2);
  // rename: same run; size change: new run
  await row.locator('[data-testid=pp-edit]').click();
  await page.fill('[data-testid=pp-name]', 'e2e paper 2');
  await page.click('[data-testid=pp-save]');
  await expect(row).toContainText('e2e paper 2');
  p = (await api(page, 'GET', '/api/papers')).body.papers[0];
  expect(p.run).toBe(1);
  await row.locator('[data-testid=pp-edit]').click();
  await page.fill('.modal .st-num >> nth=-1', '500');
  await page.click('[data-testid=pp-save]');
  await expect.poll(async () => (await api(page, 'GET', '/api/papers')).body.papers[0].run).toBe(2);
  // pause, resume (new run), restart
  await row.locator('[data-testid=pp-toggle]').click();
  await expect(row).toContainText('paused');
  await row.locator('[data-testid=pp-toggle]').click();
  await expect(row).toContainText('running');
  await row.locator('[data-testid=pp-reset]').click();
  await page.click('[data-testid=confirm-ok]');
  await expect.poll(async () => (await api(page, 'GET', '/api/papers')).body.papers[0].run).toBe(4);
  // details
  await row.click();
  await expect(page.locator('[data-testid=paper]')).toContainText('Open positions');
  await row.locator('[data-testid=pp-delete]').click();
  await page.click('[data-testid=confirm-ok]');
  await expect(page.locator('[data-testid=pp-table]')).toHaveCount(0);
  // free plan: one running strategy
  await login(page, user('free'));
  await cleanup(page);
  const body = { name: 'f', source: 'BINANCE', strategy: STRATEGY, symbols: ['BTCUSDT'] };
  expect((await api(page, 'POST', '/api/papers', body)).status).toBe(200);
  expect((await api(page, 'POST', '/api/papers', body)).status).toBe(402);
  await cleanup(page);
});

test('TC-SCREEN-03 phone: screener, tester and paper trading from the menu', async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  await login(page);
  await page.click('[data-testid=m-menu]');
  await page.click('[data-testid=m-screener]');
  const panel = page.locator('#bpanel');
  await expect(page.locator('[data-testid=sc-table]')).toBeVisible({ timeout: 120_000 });
  const box = await panel.boundingBox();
  const vw = page.viewportSize();
  expect(box.width).toBeGreaterThanOrEqual(vw.width - 1);   // full width overlay
  await page.click('.bp-tab[data-bp=tester]');
  await expect(page.locator('[data-testid=st-run]')).toBeVisible();
  await page.click('[data-testid=tab-chart]');
  await expect(panel).toBeHidden();
  await ctx.close();
});

test('TC-STRAT-01 saved strategies: save / rename / save as / open / delete; strategy on the chart with its report', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  await page.waitForFunction(() => __app.S.bars.length > 100);
  await page.click('[data-testid=bp-tester]');
  await page.click('[data-testid=long-entry-add]');
  await page.fill('[data-testid=cond-b] [data-role=value]', '30');
  await page.click('[data-testid=cond-ok]');
  // symbols picked in the symbol search
  await page.selectOption('[data-testid=st-symbols]', 'list');
  await page.fill('[data-testid=symbol-search]', 'ETHUSDT');
  await page.click('.search-item[data-symbol="BINANCE:ETHUSDT"]');
  await page.fill('[data-testid=symbol-search]', 'XRPUSDT');
  await page.click('.search-item[data-symbol="BINANCE:XRPUSDT"]');
  await page.click('.search-item[data-symbol="BINANCE:XRPUSDT"]');   // a second click removes it
  await page.click('[data-testid=search-done]');
  await expect(page.locator('[data-testid=st-sym-chips] [data-testid=sym-chip]')).toHaveText(['ETHUSDT×']);
  // save, rename, save as
  await page.click('[data-testid=st-menu]');
  await page.click('[data-testid=st-save]');
  await page.fill('.modal input', 'e2e rsi');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi$/);
  let list = (await api(page, 'GET', '/api/strategies')).body.strategies;
  expect(list).toHaveLength(1);
  expect(list[0].spec).toMatchObject({ symbols: { mode: 'list', list: ['BINANCE:ETHUSDT'] }, size: 1000 });
  expect(list[0].spec.strategy.long.entry[0].b).toEqual({ const: 30 });
  await page.click('[data-testid=st-menu]');
  await page.click('[data-testid=st-rename]');
  await page.fill('.modal input', 'e2e rsi 2');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi 2$/);
  // a change marks it unsaved; save as makes a copy
  await page.fill('[data-testid=long-tp-v]', '6');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi 2 \*$/);
  await page.click('[data-testid=st-menu]');
  await page.click('[data-testid=st-saveas]');
  await page.fill('.modal input', 'e2e rsi tp6');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi tp6$/);
  list = (await api(page, 'GET', '/api/strategies')).body.strategies;
  expect(list.map(x => x.name).sort()).toEqual(['e2e rsi 2', 'e2e rsi tp6']);
  expect(list.find(x => x.name === 'e2e rsi tp6').spec.strategy.long.tp.v).toBeCloseTo(0.06);
  expect(list.find(x => x.name === 'e2e rsi 2').spec.strategy.long.tp.v).toBeCloseTo(0.04);
  // open the other one
  await page.click('[data-testid=st-menu]');
  await page.locator('[data-testid=st-open]', { hasText: 'e2e rsi 2' }).click();
  await expect(page.locator('[data-testid=long-tp-v]')).toHaveValue('4');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi 2$/);
  // add it to the chart: runs on the chart's symbol and timeframe, entries / exits as markers, SL / TP lines
  await page.click('[data-testid=st-to-chart]');
  const legend = page.locator('[data-testid=chart-strategy]');
  await expect(legend).toContainText('e2e rsi 2');
  await expect(legend).toContainText(/\d+ trades/, { timeout: 120_000 });
  // saved with the user's chart layout on the server: back after a reload
  await expect.poll(async () => (await api(page, 'GET', '/api/settings/layout')).body.value?.chartStrategy?.name, { timeout: 10_000 }).toBe('e2e rsi 2');
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.bars.length > 50);
  await expect(legend).toContainText(/\d+ trades/, { timeout: 120_000 });
  await page.click('[data-testid=bp-tester]');
  // it follows a timeframe change
  await page.evaluate(() => __app.setTf ? __app.setTf('4h') : null);
  await expect(legend).toContainText(/\d+ trades/, { timeout: 120_000 });
  // the report of the chart run
  await legend.hover();
  await page.click('[data-testid=cs-report]');
  await expect(page.locator('[data-testid=st-results]')).toContainText('(chart)');
  await expect(page.locator('[data-testid=st-total]')).toContainText('Net profit');
  // hide, remove
  await legend.hover();
  await page.click('[data-testid=cs-toggle]');
  await expect(legend).toHaveClass(/off/);
  await legend.hover();
  await page.click('[data-testid=cs-remove]');
  await expect(legend).toHaveCount(0);
  // a saved strategy from the Indicators dialog: on the chart and active in the Strategy Tester
  await page.click('[data-testid=st-menu]');
  await page.click('[data-testid=st-new]');
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/Unsaved strategy/);
  await page.click('#btn-indicators');
  await expect(page.locator('[data-testid=ind-strategy]')).toHaveCount(2);
  await page.fill('[data-testid=ind-search]', 'tp6');
  await page.locator('[data-testid=ind-strategy]', { hasText: 'e2e rsi tp6' }).click();
  await expect(legend).toContainText('e2e rsi tp6');
  await expect(legend).toContainText(/\d+ trades/, { timeout: 120_000 });
  await expect(page.locator('[data-testid=st-menu]')).toHaveText(/e2e rsi tp6$/);
  await expect(page.locator('[data-testid=long-tp-v]')).toHaveValue('6');
  await legend.hover();
  await page.click('[data-testid=cs-remove]');
  // delete
  await page.click('[data-testid=st-menu]');
  await page.locator('[data-testid=st-open]', { hasText: 'e2e rsi 2' }).click();
  await page.click('[data-testid=st-menu]');
  await page.click('[data-testid=st-delete]');
  await page.click('[data-testid=confirm-ok]');
  await expect.poll(async () => (await api(page, 'GET', '/api/strategies')).body.strategies.length).toBe(1);
  // plan limit and validation
  const bad = await api(page, 'POST', '/api/strategies', { name: 'bad', spec: { strategy: { tf: '1h', long: { entry: [] } } } });
  expect(bad.status).toBe(400);
  expect(errors.filter(e => !/status of 400/.test(e))).toEqual([]);
});

test('TC-SCREEN-04 right panel: the active screen\'s matches in the Screener tab', async ({ page }) => {
  test.setTimeout(180_000);
  const r = await api(page, 'POST', '/api/screens', { name: 'e2e tab', spec: RSI_SPEC });
  expect(r.status).toBe(200);
  await page.click('[data-testid=rp-screen]');
  await expect(page.locator('[data-testid=rs-list]')).toContainText('No screen yet');
  await page.click('[data-testid=rs-menu]');
  await page.locator('[data-testid=rs-open]', { hasText: 'e2e tab' }).click();
  await expect(page.locator('[data-testid=rs-status]')).toContainText(/\d+ match/, { timeout: 120_000 });
  const rows = page.locator('[data-testid=rs-list] .rs-row');
  expect(await rows.count()).toBeGreaterThan(0);
  const sym = await rows.nth(0).getAttribute('data-sym');
  await rows.nth(0).click();
  await page.waitForFunction((s) => __app.S.symbol === s, sym);
  await expect(rows.nth(0)).toHaveClass(/active/);
  // columns: add Vol 24h and the screen's RSI value, remove Chg 24h; sort by RSI
  const head = page.locator('[data-testid=rs-head]');
  await expect(head).toHaveText(/Symbol.*Price.*Chg 24h/);
  await page.click('[data-testid=rs-cols]');
  await page.click('[data-testid=rs-col-opt][data-key=qvol24] input');
  await page.click('[data-testid=rs-col-opt][data-key=chg24] input');
  await page.locator('[data-testid=rs-col-opt]', { hasText: 'RSI(14)' }).locator('input').click();
  await page.keyboard.press('Escape');
  await expect(head).toHaveText(/^Symbol\s*Price\s*Vol 24h[ ▼▲]*RSI\(14\)/);
  await page.locator('[data-testid=rs-th]', { hasText: 'RSI(14)' }).click();   // descending
  await page.locator('[data-testid=rs-th]', { hasText: 'RSI(14)' }).click();   // ascending
  await expect(page.locator('[data-testid=rs-th]', { hasText: 'RSI(14)' })).toHaveText(/▲/);
  const rsi = (await page.locator('[data-testid=rs-list] .rs-row span:nth-child(4)').allTextContents()).map(parseFloat);
  expect(rsi.length).toBeGreaterThan(1);
  expect(rsi.every(v => v < 50)).toBeTruthy();
  expect(rsi).toEqual(rsi.slice().sort((a, b) => a - b));
  await expect.poll(async () => (await api(page, 'GET', '/api/settings/layout')).body.value?.screenTab, { timeout: 10_000 })
    .toEqual({ cols: ['last', 'qvol24', 'op:RSI(14)'], sort: { key: 'op:RSI(14)', dir: 1 } });
  // the active screen is saved with the user's chart layout: back after a reload
  await expect.poll(async () => (await api(page, 'GET', '/api/settings/layout')).body.value?.activeScreen?.name, { timeout: 10_000 }).toBe('e2e tab');
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.bars.length > 50);
  await page.click('[data-testid=rp-screen]');
  await expect(page.locator('[data-testid=rs-menu]')).toHaveText(/e2e tab/);
  await expect(page.locator('[data-testid=rs-status]')).toContainText(/\d+ match/, { timeout: 120_000 });
  await expect(page.locator('[data-testid=rs-head]')).toHaveText(/^Symbol\s*Price\s*Vol 24h\s*RSI\(14\) ▲$/);
  // the screener opens the same screen
  await page.click('[data-testid=rs-menu]');
  await page.click('[data-testid=rs-edit]');
  await expect(page.locator('[data-testid=sc-menu]')).toHaveText(/e2e tab$/);
});

test('TC-STRAT-02 strategy alert: from the tester, edit, plan flag', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = trackErrors(page);
  const sv = await api(page, 'POST', '/api/strategies', { name: 'e2e alert strat', spec: { strategy: STRATEGY, symbols: { mode: 'current', list: [] }, size: 1000, days: 30 } });
  expect(sv.status).toBe(200);
  await page.click('[data-testid=bp-tester]');
  await page.click('[data-testid=st-menu]');
  await page.locator('[data-testid=st-open]', { hasText: 'e2e alert strat' }).click();
  await page.click('[data-testid=st-alert]');
  await expect(page.locator('.modal [data-testid=sym-chip]')).toHaveCount(1);   // the tester's symbols (current symbol)
  await page.click('[data-testid=sta-exit]');                                    // entries only
  await page.click('[data-testid=sta-create]');
  const item = page.locator('.al-item').first();
  await page.click('.rp-tab[data-tab=alerts]');
  await expect(item).toContainText('Strategy');
  await expect(item).toContainText(/Strategy "e2e alert strat": entries on \w+ \(1h\)/);
  let al = (await api(page, 'GET', '/api/alerts')).body.alerts[0];
  expect(al).toMatchObject({ kind: 'strategy', cond: 'order', tf: '1h', active: 1 });
  expect(al.spec).toMatchObject({ strategy_id: sv.body.strategy.id, events: ['entry'], state: {} });
  // edit: add a symbol and exits
  await item.locator('[data-testid=al-edit]').click();
  await page.click('[data-testid=sta-exit]');
  await page.click('[data-testid=sta-sym-add]');
  await page.fill('[data-testid=symbol-search]', 'DOGEUSDT');
  await page.click('.search-item[data-symbol="BINANCE:DOGEUSDT"]');
  await page.click('[data-testid=search-done]');
  await page.click('[data-testid=sta-create]');
  await expect(item).toContainText(/entries \+ exits on 2 symbols/);
  al = (await api(page, 'GET', '/api/alerts')).body.alerts[0];
  expect(al.symbol).toBe('BINANCE:*');
  expect(al.spec.symbols).toContain('BINANCE:DOGEUSDT');
  // free plan: no strategy alerts
  await login(page, user('free'));
  await cleanup(page);
  const fs = await api(page, 'POST', '/api/strategies', { name: 'f', spec: { strategy: STRATEGY, symbols: { mode: 'current', list: [] }, size: 1000, days: 30 } });
  const r = await api(page, 'POST', '/api/alerts', { kind: 'strategy', spec: { strategy_id: fs.body.strategy.id, symbols: ['BTCUSDT'], events: ['entry'] }, channels: ['app'] });
  expect(r.status).toBe(402);
  await cleanup(page);
  expect(errors.filter(e => !/status of 402/.test(e))).toEqual([]);   // the 402 above is expected
});
