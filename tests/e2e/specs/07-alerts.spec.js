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
