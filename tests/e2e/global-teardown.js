import { request } from '@playwright/test';
import fs from 'node:fs';
import { STATE_FILE } from './global-setup.js';

export default async function globalTeardown(config) {
  if (!fs.existsSync(STATE_FILE)) return;
  const { admin, users } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const ctx = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  await ctx.post('/api/auth/login', { data: admin });
  for (const u of Object.values(users)) await ctx.delete(`/api/admin/users/${u.id}`);
  await ctx.dispose();
  fs.unlinkSync(STATE_FILE);
}
