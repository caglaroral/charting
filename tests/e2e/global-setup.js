// Creates throw-away users for this run (one per plan under test) using the admin account.
import { request } from '@playwright/test';
import fs from 'node:fs';

export const STATE_FILE = new URL('./.e2e-users.json', import.meta.url);

export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const admin = { username: process.env.E2E_ADMIN_USER || 'admin', password: process.env.E2E_ADMIN_PASS };
  if (!admin.password) throw new Error('Set E2E_ADMIN_PASS (and optionally E2E_ADMIN_USER) to run the e2e tests');
  const ctx = await request.newContext({ baseURL });
  const login = await ctx.post('/api/auth/login', { data: admin });
  if (!login.ok()) throw new Error('Admin login failed: ' + (await login.text()));
  // Some tests need the admin's unlimited plan; keep the admin's own workspace and restore it in teardown
  const adminLayout = (await (await ctx.get('/api/settings/layout')).json()).value ?? null;
  // Remove users left behind by an interrupted earlier run
  const existing = (await (await ctx.get('/api/admin/users')).json()).users || [];
  for (const u of existing) if (/^e2e_(pro|free)_/.test(u.username)) await ctx.delete(`/api/admin/users/${u.id}?purge=1`);
  const run = Date.now().toString(36);
  const users = {};
  for (const plan of ['pro', 'free']) {
    const u = { username: `e2e_${plan}_${run}`, password: `pw_${run}_${Math.random().toString(36).slice(2, 8)}`, plan };
    const r = await ctx.post('/api/admin/users', { data: u });
    if (!r.ok()) throw new Error('Could not create test user: ' + (await r.text()));
    u.id = (await r.json()).user.id;
    users[plan] = u;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ admin, users, adminLayout }, null, 2));
  await ctx.dispose();
}
