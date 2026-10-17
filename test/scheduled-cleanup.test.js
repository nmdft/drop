import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scheduledCleanup } from '../lib/scheduled-cleanup.js';
import { createService } from '../lib/service.js';

const secret = 'isolated-test-secret-at-least-32-characters';
const context = (token = secret, method = 'POST') => ({ request: new Request('https://example.test/api/scheduled-cleanup', { method, ...(method === 'POST' ? { body: JSON.stringify({ token }) } : {}) }), env: { CLEANUP_SECRET: secret } });

test('scheduled cleanup rejects missing and incorrect credentials before storage access', async () => {
  const factory = env => createService({ store: {}, secret, cleanupSecret: env.CLEANUP_SECRET });
  for (const token of ['', 'incorrect']) assert.equal((await scheduledCleanup(context(token), factory)).status, 403);
  assert.equal((await scheduledCleanup(context(secret, 'GET'), factory)).status, 405);
});

test('scheduled cleanup drains multiple batches and supplies authorization', async () => {
  let batches = 0;
  const response = await scheduledCleanup(context(), () => ({ cleanup: async authorization => {
    assert.equal(authorization, `Bearer ${secret}`);
    return { deleted: 2, more: ++batches < 3 };
  } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: 6, more: false });
});

test('scheduled cleanup reports unfinished work when its time budget expires', async () => {
  let clock = 0;
  const response = await scheduledCleanup(context(), () => ({ cleanup: async () => ({ deleted: 2, more: true }) }), () => { clock += 81000; return clock; });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).more, true);
});

test('build automatically pairs scheduler credentials without environment secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-build-test-'));
  try {
    await cp('public', join(dir, 'public'), { recursive: true });
    await cp('edgeone.json', join(dir, 'edgeone.json'));
    const script = resolve('scripts/build.mjs');
    const build = env => spawnSync(process.execPath, [script], { cwd: dir, env: { ...process.env, SITE_SECRET: '', CLEANUP_SECRET: '', ...env }, encoding: 'utf8' });
    assert.equal(build({}).status, 0);
    let config = JSON.parse(await readFile(join(dir, 'edgeone.json')));
    const token = config.schedules[0].payload.token;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.ok((await readFile(join(dir, 'lib/generated-schedule.js'), 'utf8')).includes(token));
    assert.equal(config.schedules[0].timezone, 'Asia/Shanghai');
    for (const file of ['index.html', 'app.js', 'style.css', 'proof-worker.js']) assert.ok(!(await readFile(join(dir, 'dist', file), 'utf8')).includes(token));
    assert.equal(build({ SITE_SECRET: secret, CLEANUP_SECRET: secret }).status, 0);
    config = JSON.parse(await readFile(join(dir, 'edgeone.json')));
    assert.notEqual(config.schedules[0].payload.token, token);
    assert.notEqual(config.schedules[0].payload.token, secret);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('scheduled cleanup rejects malformed and oversized payloads', async () => {
  for (const [body, status] of [['not json', 400], ['x'.repeat(4097), 413]]) {
    const response = await scheduledCleanup({ request: new Request('https://example.test', { method: 'POST', body }) }, () => { throw new Error('must not read storage'); });
    assert.equal(response.status, status);
  }
});

test('deployment token rejects unauthorized requests before opening Blob', async () => {
  let called = false;
  const factory = async env => { called = true; assert.equal(env.CLEANUP_SECRET, secret); return { cleanup: async () => ({ deleted: 0, more: false }) }; };
  assert.equal((await scheduledCleanup(context('wrong'), factory, Date.now, secret)).status, 403);
  assert.equal(called, false);
  assert.equal((await scheduledCleanup(context(), factory, Date.now, secret)).status, 200);
  assert.equal(called, true);
});
