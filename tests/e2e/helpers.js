import { expect } from '@playwright/test';
import fs from 'node:fs';
import { STATE_FILE } from './global-setup.js';

export const state = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
export const user = (plan = 'pro') => state().users[plan];
export const admin = () => state().admin;

/** Collect uncaught page errors; assert none at the end of a test with expectNoErrors(). */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) errors.push(m.text()); });
  return errors;
}

export async function login(page, u = user(), { navigate = true } = {}) {
  if (navigate) {
    await page.request.post('/api/auth/logout'); // switch users cleanly
    await page.goto('/');
  }
  await page.waitForSelector('#login-user', { state: 'visible' });
  await page.fill('#login-user', u.username);
  await page.fill('#login-pass', u.password);
  await page.click('#login-submit');
  await waitChart(page);
}

export async function waitChart(page) {
  await page.waitForFunction(() => window.__app && __app.S.view && __app.S.view.length > 50 && __app.mainSeries, null, { timeout: 30_000 });
}

export const appState = (page, fn) => page.evaluate(fn);

/** Pixel position (page coords) of a bar index / price on the main pane. */
export async function chartPoint(page, idxFromEnd, priceFrac) {
  return page.evaluate(([k, f]) => {
    const r = document.querySelector('#chart').getBoundingClientRect();
    const ts = __app.chart.timeScale();
    const n = __app.S.view.length;
    const x = ts.logicalToCoordinate(n - 1 - k);
    const h = __app.chart.panes()[0].getHeight();
    return { x: r.left + x, y: r.top + h * f };
  }, [idxFromEnd, priceFrac]);
}

export async function closeModals(page) {
  while (await page.locator('.modal-backdrop').count()) await page.keyboard.press('Escape');
}

export async function resetLayout(page) {
  await page.evaluate(async () => {
    await fetch('/api/settings/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: null }) });
  });
}

export { expect };
