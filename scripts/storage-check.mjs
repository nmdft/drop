import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '@edgeone/pages-blob';
import { createService, MB } from '../lib/service.js';

const storeOptions = { name: 'pickup-drop', consistency: 'strong', projectId: process.env.EDGEONE_PROJECT_ID, token: process.env.EDGEONE_PAGES_API_TOKEN };
const services = Array.from({ length: 3 }, () => createService({ store: getStore(storeOptions), secret: process.env.SITE_SECRET, cleanupSecret: process.env.CLEANUP_SECRET }));
const identity = `verification-${randomUUID()}`;
const receipts = [];

function input(service, fields, ip) {
  const challenge = service.challenge(ip);
  let nonce = 0;
  while (true) {
    const digest = createHash('sha256').update(`${challenge.salt}:${nonce}`).digest();
    if (digest[0] === 0 && digest[1] === 0 && digest[2] < 128) break;
    nonce += 1;
  }
  return { ...fields, duration: 3600, challengeToken: challenge.token, nonce };
}

async function send(service, fields, ip) {
  const receipt = await service.send(input(service, fields, ip), ip);
  receipts.push({ token: receipt.revokeToken || receipt.uploadToken, code: receipt.code });
  return receipt;
}

try {
  assert.equal((await services[0].status()).usedBytes, 0, 'Run only when the station has no retained transfers.');
  const texts = await Promise.all(services.map((service, index) => send(service, { kind: 'text', text: `${identity}-${index}` }, `${identity}-${index}`)));
  assert.equal(new Set(texts.map(receipt => receipt.code)).size, texts.length);
  for (const [index, receipt] of texts.entries()) {
    assert.equal((await services[index].pickup(receipt.code, `${identity}-receiver-${index}`)).text, `${identity}-${index}`);
    await services[index].revoke(receipt.revokeToken);
  }
  console.log('PASS: independent real Blob clients allocate distinct codes concurrently');

  const files = await Promise.all(services.map((service, index) => send(service, { kind: 'file', size: 300 * MB, name: `${identity}-${index}.bin` }, `${identity}-file-${index}`)));
  const status = await services[0].status();
  assert.ok(status.usedBytes >= 900 * MB && status.usedBytes <= 980 * MB);
  assert.equal(status.maxFileBytes, MB);
  await assert.rejects(send(services[0], { kind: 'file', size: MB + 1, name: `${identity}-too-large.bin` }, `${identity}-boundary`), { status: 413 });
  await send(services[0], { kind: 'file', size: MB, name: `${identity}-small.bin` }, `${identity}-boundary-small`);
  await assert.rejects(send(services[0], { kind: 'file', size: 300 * MB, name: `${identity}-over-capacity.bin` }, `${identity}-full`), { status: 413 });
  assert.equal(files.length, 3);
  console.log('PASS: real Blob concurrent 900MB reservations enforce 1MB admission limit');
} finally {
  const outcomes = await Promise.allSettled(receipts.map(receipt => services[0].revoke(receipt.token)));
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 0, 'Verification fixture revocation failed.');
}
assert.equal((await services[0].status()).usedBytes, 0);
console.log('PASS: all owned verification transfers removed; reserved capacity returned to zero');
