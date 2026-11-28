// TC-WL: watchlist CRUD, live quotes, persistence
import { test, expect } from '@playwright/test';
import { login } from '../helpers.js';

test('TC-WL-01 add / remove symbols, live quotes, persisted across reload', async ({ page }) => {
  await login(page);
  await page.click('#wl-add');
  await page.fill('[data-testid=symbol-search]', 'AVAXUSDT');
  await page.click('.search-item[data-symbol="BINANCE:AVAXUSDT"]');
  await page.keyboard.press('Escape');
  await expect(page.locator('.wl-row[data-sym="BINANCE:AVAXUSDT"]')).toBeVisible();
  // live quote arrives through the mini ticker stream
  await expect(page.locator('.wl-row[data-sym="BINANCE:AVAXUSDT"] .wl-last')).not.toHaveText('—', { timeout: 20_000 });
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.watchlists.length);
  await expect(page.locator('.wl-row[data-sym="BINANCE:AVAXUSDT"]')).toBeVisible();
  await page.hover('.wl-row[data-sym="BINANCE:AVAXUSDT"]');
  await page.click('.wl-row[data-sym="BINANCE:AVAXUSDT"] [data-testid=wl-remove]');
  await expect(page.locator('.wl-row[data-sym="BINANCE:AVAXUSDT"]')).toHaveCount(0);
});

test('TC-WL-02 clicking a row loads that symbol', async ({ page }) => {
  await login(page);
  await page.click('.wl-row[data-sym="BINANCE:ETHUSDT"]');
  await page.waitForFunction(() => __app.S.symbol === 'BINANCE:ETHUSDT' && __app.S.bars.length > 0);
  await expect(page.locator('.wl-row.active')).toHaveAttribute('data-sym', 'BINANCE:ETHUSDT');
  await page.click('.wl-row[data-sym="BINANCE:BTCUSDT"]');
});

test('TC-WL-03 create, rename and delete a list', async ({ page }) => {
  await login(page);
  page.on('dialog', d => d.accept());
  await page.click('[data-testid=wl-menu]');
  await page.click('[data-testid=wl-new]');
  await page.fill('.modal input', 'E2E list');
  await page.keyboard.press('Enter');
  await expect(page.locator('#wl-name')).toContainText('E2E list');
  await expect(page.locator('#wl-list .wl-empty')).toBeVisible();
  await page.click('[data-testid=wl-menu]');
  await page.click('[data-testid=wl-delete]');
  await page.click('[data-testid=confirm-ok]');
  await expect(page.locator('#wl-name')).not.toContainText('E2E list');
});

test('TC-WL-04 columns and sort: add / remove columns, sort by a column, saved with the layout', async ({ page }) => {
  await login(page);
  const reset = () => page.evaluate(async () => {
    const L = (await (await fetch('/api/settings/layout')).json()).value;
    if (L && L.wlView) await fetch('/api/settings/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { ...L, wlView: null } }) });
  });
  const head = page.locator('[data-testid=wl-head]');
  await expect(head).toHaveText(/^Symbol\s*Last\s*Chg\s*Chg%$/);
  // add High 24h and Turnover 24h, remove Chg
  await page.click('[data-testid=wl-cols-btn]');
  await page.click('[data-testid=wl-col-opt][data-key=high] input');
  await page.click('[data-testid=wl-col-opt][data-key=qvol] input');
  await page.click('[data-testid=wl-col-opt][data-key=chg] input');
  await page.keyboard.press('Escape');
  await expect(head).toHaveText(/^Symbol\s*Last\s*Chg%\s*High 24h\s*Turnover 24h$/);
  const rows = page.locator('#wl-list .wl-row');
  await expect(rows.first().locator('.wl-high')).not.toHaveText('', { timeout: 20_000 });
  // sort by Chg%: descending, ascending, then the list's own order
  const own = await rows.evaluateAll(r => r.map(x => x.dataset.sym));
  const th = page.locator('[data-testid=wl-th][data-key=chgp]');
  const chgs = async () => (await page.locator('#wl-list .wl-row .wl-chgp').allTextContents()).map(parseFloat).filter(v => !Number.isNaN(v));
  await th.click();
  await expect(th).toHaveText(/▼/);
  let v = await chgs();
  expect(v).toEqual(v.slice().sort((a, b) => b - a));
  await th.click();
  await expect(th).toHaveText(/▲/);
  v = await chgs();
  expect(v).toEqual(v.slice().sort((a, b) => a - b));
  // saved with the layout: back after a reload
  await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/settings/layout')).json()).value?.wlView), { timeout: 10_000 })
    .toEqual({ cols: ['last', 'chgp', 'high', 'qvol'], sort: { key: 'chgp', dir: 1 } });
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.watchlists.length);
  await expect(head).toHaveText(/^Symbol\s*Last\s*Chg% ▲\s*High 24h\s*Turnover 24h$/);
  await page.locator('[data-testid=wl-th][data-key=chgp]').click();
  await expect(page.locator('[data-testid=wl-th][data-key=chgp]')).not.toHaveText(/[▲▼]/);
  expect(await rows.evaluateAll(r => r.map(x => x.dataset.sym))).toEqual(own);
  await reset();
});
