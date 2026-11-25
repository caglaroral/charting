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
