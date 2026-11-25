import { request } from '@playwright/test';
import fs from 'node:fs';
import { STATE_FILE } from './global-setup.js';

export default async function globalTeardown(config) {
  if (!fs.existsSync(STATE_FILE)) return;
  const { admin, users } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const ctx = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  await ctx.post('/api/auth/login', { data: admin });
  // purge=1: remove the test users together with everything they created (layouts, drawings, alerts …)
  for (const u of Object.values(users)) {
    const r = await ctx.delete(`/api/admin/users/${u.id}?purge=1`);
    if (!r.ok()) console.warn(`teardown: could not purge ${u.username}: ${r.status()} ${await r.text()}`);
  }
  await ctx.dispose();
  fs.unlinkSync(STATE_FILE);
}
