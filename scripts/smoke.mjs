import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getStore } from '@edgeone/pages-blob';

const target = process.env.TEST_URL;
if (!target) throw new Error('Set TEST_URL to a local or deployed HTTPS site URL.');
const base = new URL(target);
let cookie = '';
if (base.searchParams.has('eo_token')) {
  const response = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'Preview authorization did not issue cookies; obtain a fresh preview URL.');
  base.search = '';
}
const receipts = [];
const api = async (action, body, options = {}) => {
  const url = new URL(`/api/${action}`, base);
  url.search = base.search;
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base.origin, 'Sec-Fetch-Site': 'same-origin' }, ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(110000),
  });
  if (options.binary && response.ok) return response.arrayBuffer();
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`${action}: HTTP ${response.status}, expected JSON; check site authorization and deployment.`);
  const output = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${action}: ${output.error || response.status}`), { status: response.status });
  return output;
};

async function proof(fields) {
  const challenge = await api('challenge', {});
  let nonce = 0;
  while (true) {
    const digest = createHash('sha256').update(`${challenge.salt}:${nonce}`).digest();
    if (digest[0] === 0 && digest[1] === 0 && digest[2] < 128) break;
    nonce += 1;
  }
  return { ...fields, duration: 3600, challengeToken: challenge.token, nonce };
}

try {
  assert.equal((await api('health')).storage, 'reachable');
  const text = `临时取件站真实存储验证 ${Date.now()}`;
  const receipt = await api('send', await proof({ kind: 'text', text }));
  receipts.push(receipt);
  assert.match(receipt.code, /^\d{4}$/);
  assert.equal((await api('pickup', { code: receipt.code })).text, text);
  assert.equal((await api('pickup', { code: receipt.code })).text, text);
  console.log('PASS: real text storage, four-digit code, repeated pickup');

  await assert.rejects(api('send', await proof({ kind: 'file', size: 300000001, name: 'over-limit.bin' })), { status: 413 });
  console.log('PASS: server rejects files exceeding 300MB');

  const size = Number(process.env.FILE_MB || '5') * 1000000;
  assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 300000000);
  const upload = await api('send', await proof({ kind: 'file', size, name: `verification-${size}.bin` }));
  receipts.push({ revokeToken: upload.uploadToken });
  const original = createHash('sha256');
  for (let index = 0; index < upload.parts; index += 1) {
    const chunk = Buffer.alloc(Math.min(upload.chunkBytes, size - index * upload.chunkBytes), index % 256);
    original.update(chunk);
    const url = new URL('/api/part', base);
    url.search = base.search;
    url.searchParams.set('index', String(index));
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': upload.uploadToken, Origin: base.origin, 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}) }, body: chunk, signal: AbortSignal.timeout(110000) });
    const output = await response.json();
    assert.equal(response.status, 200, output.error);
    if (index % 10 === 0 || index + 1 === upload.parts) console.log(`Upload: ${index + 1}/${upload.parts}`);
  }
  const fileReceipt = await api('complete', { token: upload.uploadToken });
  receipts.push(fileReceipt);
  const file = await api('pickup', { code: fileReceipt.code });
  const downloaded = createHash('sha256');
  let bytes = 0;
  for (let index = 0; index < file.parts; index += 1) {
    const chunk = Buffer.from(await api('download', { token: file.downloadToken, index }, { binary: true }));
    bytes += chunk.byteLength;
    downloaded.update(chunk);
    console.log(`Download: ${index + 1}/${file.parts}`);
  }
  assert.equal(bytes, size);
  assert.equal(downloaded.digest('hex'), original.digest('hex'));
  console.log(`PASS: ${size} byte real file upload/download SHA-256 match`);
  await api('revoke', { token: fileReceipt.revokeToken });
  await assert.rejects(api('download', { token: file.downloadToken, index: 0 }, { binary: true }), { status: 404 });
  console.log('PASS: revoked file cannot be downloaded');

  if (process.env.VERIFY_CLEANUP === '1') {
    const store = getStore({ name: 'pickup-drop', consistency: 'strong', projectId: process.env.EDGEONE_PROJECT_ID, token: process.env.EDGEONE_PAGES_API_TOKEN });
    const id = JSON.parse(Buffer.from(receipt.revokeToken.split('.')[0], 'base64url').toString()).id;
    const record = await store.get(`transfers/${id}`, { type: 'json' });
    assert.equal(record.text, text);
    await store.setJSON(`transfers/${id}`, { ...record, codeExpiresAt: Date.now() - 1, deleteAt: Date.now() - 1 });
    const mapping = await store.get(`codes/${receipt.code}`, { type: 'json' });
    await store.setJSON(`codes/${receipt.code}`, { ...mapping, codeExpiresAt: Date.now() - 1, reservedUntil: Date.now() - 1 });
    await assert.rejects(api('pickup', { code: receipt.code }), { status: 404 });
    const cleanup = await api('cleanup', {}, { headers: { Authorization: `Bearer ${process.env.CLEANUP_SECRET}` } });
    assert.ok(cleanup.deleted >= 1);
    assert.equal(await store.get(`transfers/${id}`, { type: 'json' }), null);
    console.log('PASS: expired content inaccessible and physically removed by cleanup');
  }
} finally {
  for (const receipt of receipts.reverse()) {
    try { await api('revoke', { token: receipt.revokeToken }); }
    catch (error) { if (error.status !== 404) console.error('Fixture cleanup failed:', error.message); }
  }
}
