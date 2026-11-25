// TC-AUTH: login, logout, session, API protection, tenant isolation
import { test, expect } from '@playwright/test';
import { user, login, trackErrors } from '../helpers.js';

test('TC-AUTH-01 wrong password shows an error and no session is created', async ({ page }) => {
  await page.goto('/');
  await page.fill('#login-user', user().username);
  await page.fill('#login-pass', 'definitely-wrong');
  await page.click('#login-submit');
  await expect(page.locator('#login-error')).toHaveText(/Invalid username or password/);
  expect((await page.request.get('/api/me')).status()).toBe(401);
});

test('TC-AUTH-02 login opens the chart, session survives reload, logout ends it', async ({ page }) => {
  const errors = trackErrors(page);
  await login(page);
  await expect(page.locator('#symbol-label')).not.toHaveText('—');
  await page.reload();
  await page.waitForFunction(() => window.__app && __app.S.user);
  await page.click('#user-btn');
  await page.click('[data-testid=menu-logout]');
  await expect(page.locator('#login')).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('TC-AUTH-03 API endpoints require a session', async ({ request }) => {
  for (const path of ['/api/symbols', '/api/watchlists', '/api/alerts', '/api/scripts', '/api/drawings?symbol=BINANCE:BTCUSDT', '/api/settings/layout']) {
    expect((await request.get(path)).status(), path).toBe(401);
  }
});

test('TC-AUTH-04 users cannot see each other\'s data (tenant isolation)', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const pa = await a.newPage(), pb = await b.newPage();
  await pa.request.post('/api/auth/login', { data: { username: user('pro').username, password: user('pro').password } });
  await pb.request.post('/api/auth/login', { data: { username: user('free').username, password: user('free').password } });
  const marker = 'iso_' + Date.now();
  await pa.request.post('/api/drawings', { data: { symbol: 'BINANCE:BTCUSDT', drawings: [{ id: marker, tool: 'hline', points: [{ t: 1, p: 1 }], style: {} }] } });
  const mine = await (await pa.request.get('/api/drawings?symbol=BINANCE:BTCUSDT')).json();
  const theirs = await (await pb.request.get('/api/drawings?symbol=BINANCE:BTCUSDT')).json();
  expect(mine.drawings.some(d => d.id === marker)).toBe(true);
  expect(theirs.drawings.some(d => d.id === marker)).toBe(false);
  await pa.request.post('/api/drawings/delete', { data: { symbol: 'BINANCE:BTCUSDT', ids: [marker] } });
  // non-admins cannot use admin endpoints
  expect((await pb.request.get('/api/admin/users')).status()).toBe(403);
  await a.close(); await b.close();
});

test('TC-AUTH-05 malformed input is rejected without server errors', async ({ page }) => {
  await page.request.post('/api/auth/login', { data: { username: user().username, password: user().password } });
  expect((await page.request.get("/api/bars?symbol=BINANCE:BTCUSDT'%20OR%201=1--&tf=1h")).status()).toBe(404);
  expect((await page.request.get('/api/bars?symbol=BINANCE:BTCUSDT&tf=7x')).status()).toBe(400);
  expect((await page.request.post('/api/alerts', { data: { kind: 'nope' } })).status()).toBe(400);
});
