import { randomBytes, createHmac } from 'node:crypto';
import { exclusive } from './storage.js';

export const SECRET_KEY = 'config/site-secret-v1';

export async function siteSecret(store, env = {}) {
  let record = await store.get(SECRET_KEY, { type: 'json' });
  if (record === null) record = await exclusive(store, async () => {
    const existing = await store.get(SECRET_KEY, { type: 'json' });
    if (existing !== null) return existing;
    if (env.SITE_SECRET && env.SITE_SECRET.length < 32) throw new Error('Invalid legacy SITE_SECRET');
    const candidate = { secret: env.SITE_SECRET || randomBytes(32).toString('hex') };
    await store.setJSON(SECRET_KEY, candidate);
    return candidate;
  });
  if (typeof record?.secret !== 'string' || record.secret.length < 32) throw new Error('Stored site secret is missing or invalid; restore it instead of regenerating');
  return record.secret;
}

export const cleanupSecret = secret => createHmac('sha256', secret).update('drop/manual-cleanup/v1').digest('hex');
