// TC-ALERT: price / drawing / indicator alerts, channels, plan limits, engine evaluation
import { test, expect } from '@playwright/test';
import { login, user, resetLayout } from '../helpers.js';

const deleteAllAlerts = (page) => page.evaluate(async () => {
  const { alerts } = await (await fetch('/api/alerts')).json();
  for (const a of alerts) await fetch('/api/alerts/' + a.id, { method: 'DELETE' });
  await __app.loadAlerts();
});

test.beforeEach(async ({ page }) => { await login(page); await deleteAllAlerts(page); });
test.afterEach(async ({ page }) => { await deleteAllAlerts(page); });

test('TC-ALERT-01 create a price alert from the toolbar, toggle and delete it', async ({ page }) => {
  await page.click('#btn-alert');
  await page.fill('[data-testid=alert-price]', '1000000');
  await page.selectOption('[data-testid=alert-cond]', 'crossing_up');
  await page.fill('[data-testid=alert-message]', 'e2e price alert');
  await page.click('[data-testid=alert-save]');
  await page.click('.rp-tab[data-tab=alerts]');
  const item = page.locator('.al-item').first();
  await expect(item).toContainText('Price crossing up 1000000');
  // the alert line is drawn on the chart
  expect(await page.evaluate(() => __app.dm.alertLines.length)).toBe(1);
  await item.locator('[data-testid=al-toggle]').click();
  await expect(page.locator('.al-item.paused')).toHaveCount(1);
  await page.locator('.al-item [data-testid=al-delete]').click();
  await page.click('[data-testid=confirm-ok]');
  await expect(page.locator('.al-item')).toHaveCount(0);
});

test('TC-ALERT-02 alert on a drawing from the floating toolbar', async ({ page }) => {
  await page.evaluate(() => __app.dm.setTool('hline'));
  const r = await page.locator('#chart').boundingBox();
  await page.mouse.click(r.x + r.width * 0.5, r.y + 120);
  await page.click('[data-testid=db-alert]');
  await page.selectOption('[data-testid=alert-cond]', 'crossing');
  await page.click('[data-testid=alert-save]');
  await page.waitForFunction(() => __app.S.alerts.some(a => a.kind === 'drawing'));
  expect(await page.evaluate(() => __app.dm.alertDrawingIds.size)).toBe(1);
  await page.evaluate(() => __app.dm.removeAll());
});

test('TC-ALERT-03 indicator alert: RSI crossing a value, evaluated by the server engine', async ({ page }) => {
  await resetLayout(page);
  await page.evaluate(() => __app.addIndicator('rsi'));
  await page.waitForFunction(() => __app.ind.items.some(i => i.inst.type === 'rsi' && i.res.plots));
  await page.evaluate(() => { const it = __app.ind.items.find(i => i.inst.type === 'rsi'); window.__e2eInd = it.inst; });
  await page.evaluate(async () => {
    const { alertDialog } = await import('/js/dialogs.js');
    alertDialog(__app, { kind: 'indicator', inst: window.__e2eInd });
  });
  await page.selectOption('[data-testid=alert-plot]', 'rsi');
  await page.selectOption('[data-testid=alert-cond]', 'greater');
  await page.fill('[data-testid=alert-value]', '0'); // RSI is always > 0 -> fires on the next pass
  await page.click('[data-testid=alert-save]');
  await page.waitForFunction(() => __app.S.alerts.some(a => a.kind === 'indicator'));
  const a = await page.evaluate(() => __app.S.alerts.find(x => x.kind === 'indicator'));
  expect(a.spec).toMatchObject({ type: 'rsi', plot: 'rsi', target: { type: 'value', value: 0 } });
  // the engine (20s pass) evaluates the RSI on the server with the same JS and fires
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/alerts/events?since=0')).json()).events.length), { timeout: 70_000, intervals: [3000] }).toBeGreaterThan(0);
  await expect(page.locator('.toast.alert')).toBeVisible({ timeout: 20_000 });
  await resetLayout(page);
});

test('TC-ALERT-04 free plan: alert count limit and channel restrictions', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, user('free'));
  await deleteAllAlerts(page);
  const limit = await page.evaluate(() => __app.S.plan.limits.active_alerts);
  expect(limit).toBe(5);
  const statuses = await page.evaluate(async (n) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const r = await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', kind: 'price', cond: 'crossing', spec: { price: 1000000 + i } }) });
      out.push(r.status);
    }
    return out;
  }, limit);
  expect(statuses).toEqual([...Array(limit).fill(200), 402]);
  // e-mail and webhook are not part of the free plan
  const ch = await page.evaluate(async () => (await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', kind: 'price', cond: 'crossing', active: 0, spec: { price: 1 }, channels: ['email'] }) })).status);
  expect(ch).toBe(402);
  await page.click('#btn-alert');
  await expect(page.locator('[data-testid=alert-ch-email]')).toBeDisabled();
  await expect(page.locator('[data-testid=alert-ch-telegram]')).toBeEnabled();
  await deleteAllAlerts(page);
  await ctx.close();
});

test('TC-ALERT-05 notification settings are saved per user', async ({ page }) => {
  await page.click('#user-btn');
  await page.click('[data-testid=menu-notify]');
  await page.fill('[data-testid=notify-email]', 'e2e@example.com');
  await page.fill('[data-testid=notify-webhook]', 'https://example.com/hook');
  await page.click('[data-testid=notify-save]');
  const cfg = await page.evaluate(async () => (await fetch('/api/notify')).json());
  expect(cfg).toMatchObject({ email: 'e2e@example.com', webhook_url: 'https://example.com/hook' });
  const bad = await page.evaluate(async () => (await fetch('/api/notify', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook_url: 'ftp://x' }) })).status);
  expect(bad).toBe(400);
});

test('TC-ALERT-06 alert history: lifecycle, trigger, per-channel delivery result, auto stop', async ({ page }) => {
  // an unreachable webhook makes one channel fail on purpose
  await page.evaluate(() => fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhook_url: 'http://127.0.0.1:9/e2e-hook', default_channels: ['app'] }) }));
  const id = await page.evaluate(async () => (await (await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BINANCE:BTCUSDT', kind: 'price', cond: 'greater', frequency: 'once', spec: { price: 1 },
      message: 'e2e history alert', channels: ['app', 'webhook'] }) })).json()).alert.id);
  const events = () => page.evaluate(async (a) => (await (await fetch('/api/alerts/log?alert_id=' + a)).json()).log.map(e => e.event + (e.channel ? ':' + e.channel : '')), id);
  // the engine (20 s pass) fires, then delivers in the background
  await expect.poll(events, { timeout: 80_000, intervals: [3000] }).toEqual(expect.arrayContaining(['created', 'triggered', 'delivered:app', 'failed:webhook', 'deactivated']));
  const failed = await page.evaluate(async (a) => (await (await fetch('/api/alerts/log?event=failed&alert_id=' + a)).json()).log[0], id);
  expect(failed.ok).toBe(0);
  expect(failed.detail.length).toBeGreaterThan(5); // the error text is kept

  // Alerts tab shows the latest entries; the dialog filters by alert and event type
  await page.click('.rp-tab[data-tab=alerts]');
  await page.evaluate(() => __app.loadAlertLog());
  await expect(page.locator('[data-testid=al-log] .log-row[data-event=failed]').first()).toContainText('webhook');
  await page.click('[data-testid=al-log-all]');
  await page.selectOption('[data-testid=log-event]', 'failed');
  await expect(page.locator('[data-testid=log-table] tbody tr')).not.toHaveCount(0);
  for (const ev of await page.locator('[data-testid=log-table] tbody tr').evaluateAll(rows => rows.map(r => r.dataset.event))) expect(ev).toBe('failed');
  await page.keyboard.press('Escape');
  // deleting is logged too
  await page.evaluate((a) => fetch('/api/alerts/' + a, { method: 'DELETE' }), id);
  await expect.poll(events).toContain('deleted');
});

test('TC-ALERT-07 trend line alert follows the line as drawn: extended right, on a log scale', async ({ page }) => {
  await resetLayout(page);
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.view.length > 120);
  await page.click('#sb-log'); // log scale, saved in the layout the engine reads
  await page.waitForTimeout(1300);
  // A rising line that ends 50 bars ago. At the last bar (twice the distance from the first point):
  //   straight in price (linear scale)  0.1c -> 0.4c -> 0.7c   (below the close c)
  //   straight in log(price) (log)      0.1c -> 0.4c -> 1.6c   (above the close c)
  // so "close less than the line" fires only if the engine extends the line and follows the log scale.
  const id = await page.evaluate(() => {
    const v = __app.S.view, n = v.length, c = v[n - 1].close, sec = v[n - 1].time - v[n - 2].time;
    const tN = v[n - 1].time;
    const d = { id: 'e2e-trend-' + Date.now(), tool: 'trend', style: {}, z: 999,
      points: [{ t: tN - 100 * sec, p: 0.1 * c }, { t: tN - 50 * sec, p: 0.4 * c }] };
    __app.dm.drawings.push(d);
    __app.dm.select(d.id);
    __app.dm.commit();
    return d.id;
  });
  await page.click('[data-testid=db-ext-right]');
  expect(await page.evaluate((id) => __app.dm.drawings.find(d => d.id === id).style.extend, id)).toBe(true);
  await expect(page.locator('[data-testid=db-ext-right]')).toHaveClass(/active/);
  await page.click('[data-testid=db-alert]');
  await page.selectOption('[data-testid=alert-cond]', 'less');
  await page.click('[data-testid=alert-save]');
  await page.waitForFunction(() => __app.S.alerts.some(a => a.kind === 'drawing'));
  await page.waitForTimeout(500); // drawing saved (debounced)
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/alerts/events?since=0')).json()).events.length), { timeout: 70_000, intervals: [3000] }).toBeGreaterThan(0);
  await page.evaluate(() => __app.dm.removeAll());
  await resetLayout(page);
});

test('TC-ALERT-08 timeframe: "Chart" by default, any available timeframe; closed above / below conditions', async ({ page }) => {
  await page.evaluate(() => __app.setTf('1h'));
  await page.click('#btn-alert');
  const tf = page.locator('[data-testid=alert-tf]');
  await expect(tf.locator('option').first()).toHaveText('Chart (1 hour)');
  await expect(tf).toHaveValue('chart');
  const tfs = await tf.locator('option').evaluateAll(os => os.slice(1).map(o => o.value));
  expect(tfs).toEqual(await page.evaluate(() => Object.keys(__app.TF_SEC).filter(t => __app.S.availableTfs.includes(t))));
  const conds = await page.locator('[data-testid=alert-cond] option').evaluateAll(os => os.map(o => o.textContent));
  expect(conds).toEqual(expect.arrayContaining(['Closed above', 'Closed below']));
  // default: the chart's timeframe
  await page.fill('[data-testid=alert-price]', '1000000');
  await page.selectOption('[data-testid=alert-cond]', 'closed_above');
  await page.click('[data-testid=alert-save]');
  await page.click('.rp-tab[data-tab=alerts]');
  await expect(page.locator('.al-item').first()).toContainText('Price closed above 1000000 (1h)');
  // another timeframe from the list
  await page.click('#btn-alert');
  await page.fill('[data-testid=alert-price]', '1');
  await page.selectOption('[data-testid=alert-tf]', '4h');
  await page.selectOption('[data-testid=alert-cond]', 'closed_below');
  await page.click('[data-testid=alert-save]');
  await expect(page.locator('.al-item')).toHaveCount(2);
  const saved = await page.evaluate(async () => (await (await fetch('/api/alerts')).json()).alerts.map(a => `${a.tf} ${a.cond} ${a.spec.price}`).sort());
  expect(saved).toEqual(['1h closed_above 1000000', '4h closed_below 1']);
  // editing shows the alert's own timeframe
  await page.evaluate(() => __app.setTf('15m'));
  await page.locator('.al-item', { hasText: 'closed below' }).locator('button[title=Edit]').click();
  await expect(page.locator('[data-testid=alert-tf]')).toHaveValue('4h');
  await page.keyboard.press('Escape');
  await page.evaluate(() => __app.setTf('1h'));
});
