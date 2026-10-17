import test from 'node:test';
import assert from 'node:assert/strict';
import { siteSecret, cleanupSecret, SECRET_KEY } from '../lib/secrets.js';
import { sign, verify } from '../lib/service.js';

class MemoryStore {
  data = new Map();
  async get(key) { return structuredClone(this.data.get(key) ?? null); }
  async setJSON(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix }) { return { blobs: [...this.data.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
}
test('first initialization creates one stable key across concurrent instances and redeploys', async () => {
  const store = new MemoryStore();
  const values = await Promise.all(Array.from({ length: 8 }, () => siteSecret(store)));
  assert.match(values[0], /^[a-f0-9]{64}$/);
  assert.ok(values.every(value => value === values[0]));
  const token = sign(values[0], { exp: Date.now() + 60000 });
  assert.equal(await siteSecret(store), values[0]);
  assert.ok(verify(await siteSecret(store), token, Date.now()));
  assert.equal([...store.data.keys()].filter(key => key.startsWith('locks/')).length, 0);
});
test('legacy key is adopted once and subsequent env changes cannot rotate it', async () => {
  const store = new MemoryStore();
  const old = 'legacy-secret-at-least-thirty-two-characters';
  assert.equal(await siteSecret(store, { SITE_SECRET: old }), old);
  assert.equal(await siteSecret(store, { SITE_SECRET: 'changed-env-secret-at-least-thirty-two-characters' }), old);
  assert.equal(await siteSecret(store), old);
  assert.notEqual(cleanupSecret(old), old);
  assert.equal(cleanupSecret(old), cleanupSecret(old));
});
test('corrupt persisted key and storage errors fail closed, never silently regenerate', async () => {
  const store = new MemoryStore();
  await store.setJSON(SECRET_KEY, { secret: 'bad' });
  await assert.rejects(siteSecret(store), /Stored site secret/);
  assert.deepEqual(await store.get(SECRET_KEY), { secret: 'bad' });
  await store.setJSON(SECRET_KEY, false);
  await assert.rejects(siteSecret(store), /Stored site secret/);
  assert.equal(await store.get(SECRET_KEY), false);
  await assert.rejects(siteSecret({ get: async () => { throw new Error('storage unavailable'); } }), /storage unavailable/);
});
