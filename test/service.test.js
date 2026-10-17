import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createService, DAY, handle, LIMITS, MB, readBody, sign, verify } from '../lib/service.js';
import { exclusive } from '../lib/storage.js';

class MemoryStore {
  data = new Map();
  async setJSON(key, value) { this.data.set(key, { json: structuredClone(value) }); }
  async set(key, value) { this.data.set(key, { bytes: Buffer.from(value) }); }
  async get(key, options = {}) {
    const value = this.data.get(key);
    if (!value) return null;
    if (options.type === 'json') return structuredClone(value.json);
    const buffer = value.bytes || Buffer.from(JSON.stringify(value.json));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async delete(key) { this.data.delete(key); }
  async list({ prefix = '' } = {}) { return { blobs: [...this.data.keys()].filter(key => key.startsWith(prefix)).sort().map(key => ({ key })) }; }
  async getMetadata(key) { const value = this.data.get(key); return value ? { headers: { 'content-length': String(value.bytes.length) } } : null; }
}

const SECRET = 'testing-secret-with-at-least-32-characters';
const CLEANUP = 'testing-cleanup-secret-at-least-32-characters';
function fixture(options = {}) {
  let timestamp = 1800000000000;
  let nextCode = 7;
  const store = new MemoryStore();
  const service = createService({ store, secret: SECRET, cleanupSecret: CLEANUP, now: () => timestamp, chooseCode: () => String(nextCode++).padStart(4, '0'), lock: (backend, operation) => exclusive(backend, operation, { pause: 1 }), ...options });
  const input = (fields = {}) => {
    const challenge = service.challenge('127.0.0.1');
    let nonce = 0;
    while (true) {
      const digest = createHash('sha256').update(`${challenge.salt}:${nonce}`).digest();
      if (digest[0] === 0 && digest[1] === 0 && digest[2] < 128) break;
      nonce += 1;
    }
    return { kind: 'text', text: '你好，另一台电脑！', duration: 3600, challengeToken: challenge.token, nonce, ...fields };
  };
  return { store, service, input, advance: milliseconds => { timestamp += milliseconds; }, now: () => timestamp };
}

test('text pickup preserves leading zero and supports repeated collection', async () => {
  const { service, input, now } = fixture();
  const receipt = await service.send(input(), '127.0.0.1');
  assert.equal(receipt.code, '0007');
  assert.equal(receipt.expiresAt, now() + 3600000);
  assert.equal(receipt.deleteAt, receipt.expiresAt);
  for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await service.pickup('0007', 'receiver')).text, '你好，另一台电脑！');
});

test('one-hour expiration rejects access but retains content until daily cleanup', async () => {
  const { service, input, store, advance } = fixture();
  const receipt = await service.send(input(), '127.0.0.1');
  advance(3600000);
  await assert.rejects(service.pickup(receipt.code, 'receiver'), { status: 404 });
  assert.equal((await store.list({ prefix: 'transfers/' })).blobs.length, 1);
  assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).deleted, 1);
  assert.equal((await store.list({ prefix: 'transfers/' })).blobs.length, 0);
});

test('all supported durations and exact three-day boundary', async () => {
  for (const duration of [3600, 10800, 86400, 259200]) {
    const { service, input, advance } = fixture();
    const receipt = await service.send(input({ duration }), '127.0.0.1');
    advance(duration * 1000 - 1);
    assert.equal((await service.pickup(receipt.code, 'receiver')).kind, 'text');
    advance(1);
    await assert.rejects(service.pickup(receipt.code, 'receiver'), { status: 404 });
  }
});

test('file uploads enforce chunk sizes and round-trip exact bytes', async () => {
  const { service, input } = fixture();
  const content = Buffer.from('a file\0with arbitrary bytes');
  const upload = await service.send(input({ kind: 'file', name: 'example.bin', size: content.length }), '127.0.0.1');
  await assert.rejects(service.complete(upload.uploadToken), { status: 409 });
  await assert.rejects(service.part(upload.uploadToken, 0, Buffer.from('bad')), { status: 413 });
  await assert.rejects(service.part(upload.uploadToken, 1, content), { status: 400 });
  await service.part(upload.uploadToken, 0, content);
  const receipt = await service.complete(upload.uploadToken);
  assert.equal((await service.complete(upload.uploadToken)).code, receipt.code);
  const picked = await service.pickup(receipt.code, 'receiver');
  assert.deepEqual(Buffer.from(await service.download(picked.downloadToken, 0)), content);
  await assert.rejects(service.part(upload.uploadToken, 0, content), { status: 409 });
});

test('multi-chunk file and download expiration on every chunk request', async () => {
  const { service, input, advance } = fixture();
  const size = LIMITS.chunk + 9;
  const upload = await service.send(input({ kind: 'file', name: 'large.dat', size }), '127.0.0.1');
  await service.part(upload.uploadToken, 0, Buffer.alloc(LIMITS.chunk, 42));
  await service.part(upload.uploadToken, 1, Buffer.alloc(9, 7));
  const receipt = await service.complete(upload.uploadToken);
  const picked = await service.pickup(receipt.code, 'receiver');
  assert.equal((await service.download(picked.downloadToken, 0)).byteLength, LIMITS.chunk);
  assert.equal((await service.download(picked.downloadToken, 1)).byteLength, 9);
  advance(3600000);
  await assert.rejects(service.download(picked.downloadToken, 1), { status: 403 });
});

test('UTF-8 text limit counts bytes rather than characters', async () => {
  const { service, input } = fixture();
  await service.send(input({ text: '汉'.repeat(333333) }), '127.0.0.1');
  await assert.rejects(service.send(input({ text: '汉'.repeat(333334) }), '127.0.0.1'), { status: 413 });
});

test('capacity lowers limit at 700MB and rejects exceeding remaining space', async () => {
  const { service, store, input, now } = fixture();
  await store.setJSON('transfers/existing', { reservedBytes: 700 * MB, deleteAt: now() + DAY });
  assert.equal((await service.status()).maxFileBytes, 10 * MB);
  await assert.rejects(service.send(input({ kind: 'file', size: 10 * MB + 1, name: 'large.zip' }), '127.0.0.1'), { status: 413 });
  await store.setJSON('transfers/existing', { reservedBytes: LIMITS.capacity - 1000, deleteAt: now() + DAY });
  await assert.rejects(service.send(input({ text: 'hi' }), '127.0.0.1'), { status: 507 });
});

test('concurrent reservations cannot exceed capacity', async () => {
  const { service, store, input, now } = fixture();
  await store.setJSON('transfers/existing', { reservedBytes: 600 * MB, deleteAt: now() + DAY });
  const requests = [input({ kind: 'file', size: 200 * MB, name: 'first.zip' }), input({ kind: 'file', size: 200 * MB, name: 'second.zip' })];
  const results = await Promise.allSettled(requests.map(body => service.send(body, '127.0.0.1')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok((await service.status()).usedBytes < LIMITS.capacity);
});

test('random code collision does not overwrite existing content, even after code expiry', async () => {
  let attempts = 0;
  const { service, input, advance } = fixture({ chooseCode: () => attempts++ < 3 ? '0023' : '0045' });
  const first = await service.send(input({ text: 'first' }), '127.0.0.1');
  advance(3600000);
  const second = await service.send(input({ text: 'second' }), '127.0.0.1');
  assert.equal(first.code, '0023');
  assert.equal(second.code, '0045');
  await assert.rejects(service.pickup(first.code, 'receiver'), { status: 404 });
  assert.equal((await service.pickup(second.code, 'receiver')).text, 'second');
});

test('concurrent code allocation returns distinct codes', async () => {
  const { service, input } = fixture();
  const results = await Promise.all([service.send(input({ text: 'one' }), '127.0.0.1'), service.send(input({ text: 'two' }), '127.0.0.1')]);
  assert.notEqual(results[0].code, results[1].code);
});

test('revoking releases storage but keeps code tombstone for three days', async () => {
  const { service, input, store, advance } = fixture();
  const receipt = await service.send(input(), '127.0.0.1');
  await service.revoke(receipt.revokeToken);
  assert.equal((await service.status()).usedBytes, 0);
  assert.ok(await store.get(`codes/${receipt.code}`, { type: 'json' }));
  await assert.rejects(service.pickup(receipt.code, 'receiver'), { status: 404 });
  advance(3 * DAY);
  await service.cleanup(`Bearer ${CLEANUP}`);
  assert.equal(await store.get(`codes/${receipt.code}`, { type: 'json' }), null);
});

test('abandoned upload and orphan chunks are reclaimed', async () => {
  const { service, input, store, advance } = fixture();
  const upload = await service.send(input({ kind: 'file', size: 3, name: 'abandoned' }), '127.0.0.1');
  await service.part(upload.uploadToken, 0, Buffer.from('abc'));
  await store.set('files/orphan/0', new Uint8Array([1]).buffer);
  advance(2 * 3600000);
  await service.cleanup(`Bearer ${CLEANUP}`);
  assert.equal((await store.list({ prefix: 'files/' })).blobs.length, 0);
  assert.equal((await service.status()).usedBytes, 0);
});

test('proof cannot be replayed, forged, or used by a different IP', async () => {
  const { service, input } = fixture();
  const body = input();
  await assert.rejects(service.send(body, 'different'), { status: 403 });
  await service.send(body, '127.0.0.1');
  await assert.rejects(service.send(body, '127.0.0.1'), { status: 403 });
  await assert.rejects(service.send({ ...body, challengeToken: 'fake' }, '127.0.0.1'), { status: 403 });
});

test('pickup rate limiting survives service instance changes', async () => {
  const { service, store, now } = fixture();
  for (let attempt = 0; attempt < 12; attempt += 1) await assert.rejects(service.pickup('9999', 'bad-actor'), { status: 404 });
  const second = createService({ store, secret: SECRET, now });
  await assert.rejects(second.pickup('9999', 'bad-actor'), { status: 429 });
});

test('tokens are signed, purpose-bound and expired; cleanup requires secret', async () => {
  const { service, now } = fixture();
  const token = sign(SECRET, { kind: 'upload', id: 'a', exp: now() + 1000 });
  assert.equal(verify(SECRET, token, now()).id, 'a');
  assert.throws(() => verify(SECRET, token, now() + 1000), { status: 403 });
  await assert.rejects(service.download(token, 0), { status: 403 });
  await assert.rejects(service.cleanup('Bearer wrong'), { status: 403 });
});

test('Bakery coordination excludes simultaneous writers across independent clients', async () => {
  const store = new MemoryStore();
  let active = 0;
  let finished = 0;
  await Promise.all(Array.from({ length: 15 }, () => exclusive(store, async () => {
    active += 1;
    assert.equal(active, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    finished += 1;
    active -= 1;
  }, { pause: 1 })));
  assert.equal(finished, 15);
  assert.equal((await store.list({ prefix: 'locks/' })).blobs.length, 0);
});

test('stale lock fails closed rather than overwriting state', async () => {
  const store = new MemoryStore();
  await store.setJSON('locks/stale', { identity: 'stale', choosing: false, number: 1 });
  await assert.rejects(exclusive(store, () => assert.fail('Must not enter'), { timeout: 5, pause: 1 }));
  assert.equal((await store.list({ prefix: 'locks/' })).blobs.length, 1);
});

test('Makers parsed body override preserves raw JSON and binary size checks', async () => {
  const request = new Request('https://test/api/challenge', { method: 'POST', body: '{}' });
  Object.defineProperty(request, 'body', { get: () => Promise.resolve({}) });
  assert.equal((await readBody(request, 2)).toString(), '{}');
  const oversized = new Request('https://test/api/part', { method: 'POST', body: Buffer.from([0, 255, 1, 2, 3]) });
  Object.defineProperty(oversized, 'body', { get: () => Buffer.from([0, 255, 1, 2, 3]) });
  await assert.rejects(readBody(oversized, 4), { status: 413 });
  const { service } = fixture();
  const fresh = new Request('https://test/api/challenge', { method: 'POST', body: '{}' });
  Object.defineProperty(fresh, 'body', { get: () => ({}) });
  assert.equal((await handle({ request: fresh, clientIp: 'sender' }, () => service, 'challenge')).status, 200);
});

test('browser same-origin metadata works behind proxy without accepting cross-origin requests', async () => {
  const { service } = fixture();
  const call = headers => handle({ request: new Request('http://internal/api/challenge', { method: 'POST', headers, body: '{}' }), clientIp: 'sender' }, () => service, 'challenge');
  assert.equal((await call({ origin: 'https://public.example', 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await call({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call({ origin: 'https://sub.public.example', 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ origin: 'http://internal' })).status, 200);
});

test('HTTP layer rejects cross-origin, malformed JSON, oversized body and method mismatch', async () => {
  const { service } = fixture();
  const call = request => handle({ request, clientIp: 'receiver' }, () => service, 'pickup');
  assert.equal((await call(new Request('https://test/api/pickup'))).status, 405);
  assert.equal((await call(new Request('https://test/api/pickup', { method: 'POST', headers: { origin: 'https://evil' }, body: '{}' }))).status, 403);
  assert.equal((await call(new Request('https://test/api/pickup', { method: 'POST', body: '{' }))).status, 400);
  assert.equal((await call(new Request('https://test/api/pickup', { method: 'POST', body: 'x'.repeat(7000000) }))).status, 413);
  await assert.rejects(readBody(new Request('https://test', { method: 'POST', body: '12345' }), 4), { status: 413 });
});

test('1MB text limit allows JSON escape expansion without admitting oversized text', async () => {
  const { service, input } = fixture();
  const call = text => handle({ request: new Request('https://test/api/send', { method: 'POST', body: JSON.stringify(input({ text })) }), clientIp: '127.0.0.1' }, () => service, 'send');
  const text = '\u0001'.repeat(LIMITS.text);
  const response = await call(text);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal((await service.pickup(receipt.code, 'receiver')).text, text);
  assert.equal((await call('a'.repeat(LIMITS.text + 1))).status, 413);
});

test('service refuses unconfigured secrets without exposing internal details', () => {
  assert.throws(() => createService({ store: new MemoryStore(), secret: '' }), { status: 503 });
});

test('300MB file completes 75 chunks with identical downloaded SHA-256; 300MB+1 rejected', async () => {
  const { service, input } = fixture();
  await assert.rejects(service.send(input({ kind: 'file', name: 'too-large.bin', size: LIMITS.file + 1 }), '127.0.0.1'), { status: 413 });
  const upload = await service.send(input({ kind: 'file', name: '300MB.bin', size: LIMITS.file }), '127.0.0.1');
  assert.equal(upload.parts, 75);
  const original = createHash('sha256');
  for (let index = 0; index < upload.parts; index += 1) {
    const chunk = Buffer.alloc(LIMITS.chunk, index);
    original.update(chunk);
    await service.part(upload.uploadToken, index, chunk);
  }
  const receipt = await service.complete(upload.uploadToken);
  const result = await service.pickup(receipt.code, 'receiver');
  const downloaded = createHash('sha256');
  let size = 0;
  for (let index = 0; index < result.parts; index += 1) {
    const chunk = Buffer.from(await service.download(result.downloadToken, index));
    size += chunk.byteLength;
    downloaded.update(chunk);
  }
  assert.equal(size, LIMITS.file);
  assert.equal(downloaded.digest('hex'), original.digest('hex'));
});

test('cleanup paginates multiple expired transfers and is idempotent', async () => {
  const { service, input, advance } = fixture();
  for (let index = 0; index < 3; index += 1) await service.send(input({ text: `message ${index}` }), '127.0.0.1');
  advance(3 * DAY);
  assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).more, true);
  assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).more, false);
  assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).deleted, 0);
});

test('700MB boundary allows exactly 10MB and rejects 10MB plus one byte', async () => {
  const { service, store, input, now } = fixture();
  await store.setJSON('transfers/existing', { reservedBytes: 700 * MB - 1, deleteAt: now() + DAY });
  assert.equal((await service.status()).maxFileBytes, LIMITS.capacity - (700 * MB - 1));
  await store.setJSON('transfers/existing', { reservedBytes: 700 * MB, deleteAt: now() + DAY });
  assert.equal((await service.status()).maxFileBytes, 10 * MB);
  await service.send(input({ kind: 'file', size: 10 * MB, name: 'allowed.bin' }), '127.0.0.1');
  await assert.rejects(service.send(input({ kind: 'file', size: 10 * MB + 1, name: 'large.bin' }), '127.0.0.1'), { status: 413 });
});

test('daily cleanup honors each retention period and preserves unexpired content', async () => {
  for (const duration of [3600, 10800, 86400, 259200]) {
    const { service, input, store, advance } = fixture();
    const receipt = await service.send(input({ duration }), '127.0.0.1');
    assert.equal(receipt.deleteAt, receipt.expiresAt);
    advance(duration * 1000 - 1);
    assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).deleted, 0);
    advance(1);
    assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).deleted, 1);
    assert.equal((await store.list({ prefix: 'transfers/' })).blobs.length, 0);
  }
});

test('daily cleanup expires legacy three-day records by their pickup expiry', async () => {
  const { service, store, input, advance, now } = fixture();
  const receipt = await service.send(input(), '127.0.0.1');
  const { id } = await store.get(`codes/${receipt.code}`, { type: 'json' });
  const record = await store.get(`transfers/${id}`, { type: 'json' });
  await store.setJSON(`transfers/${id}`, { ...record, deleteAt: now() + 3 * DAY });
  advance(3600000);
  assert.equal((await service.cleanup(`Bearer ${CLEANUP}`)).deleted, 1);
});


test('request body is consumed before asynchronous storage initialization', async () => {
  for (const action of ['part', 'send']) {
    const request = new Request('https://example.test/api/' + action + '?index=0', {
      method: 'POST', body: action === 'part' ? Buffer.alloc(1000000, 7) : JSON.stringify({ kind: 'text', text: 'hello' }),
    });
    const response = await handle({ request }, async () => {
      assert.equal(request.bodyUsed, true);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { part: async (token, index, data) => { assert.equal(data.length, 1000000); assert.ok(data.every(byte => byte === 7)); return { ok: true }; }, send: async input => { assert.equal(input.text, 'hello'); return { ok: true }; } };
    }, action);
    assert.equal(response.status, 200);
  }
});
