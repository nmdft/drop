import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { BusyError, exclusive, records } from './storage.js';

export const MB = 1000000;
export const LIMITS = Object.freeze({ file: 300 * MB, text: 100000, chunk: 4 * MB, soft: 900 * MB, capacity: 980 * MB });
export const DAY = 86400000;
const DURATIONS = [3600, 10800, 86400, 259200];
const PENDING_MS = 2 * 3600000;
const HASH = value => createHash('sha256').update(value).digest('hex');

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function check(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

function equal(secret, input) {
  return typeof input === 'string' && timingSafeEqual(Buffer.from(HASH(secret)), Buffer.from(HASH(input)));
}

export function sign(secret, value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verify(secret, token, now) {
  check(typeof token === 'string' && token.length <= 2048, 403, '授权无效或已过期。');
  const [body, signature, extra] = token.split('.');
  check(body && signature && !extra && equal(createHmac('sha256', secret).update(body).digest('base64url'), signature), 403, '授权无效或已过期。');
  let value;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw new HttpError(403, '授权无效或已过期。'); }
  check(Number.isFinite(value.exp) && value.exp > now, 403, '授权无效或已过期。');
  return value;
}

export async function readBody(request, maxBytes) {
  const body = request instanceof Request ? Reflect.get(Request.prototype, 'body', request) : request.body;
  const reader = body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, '请求内容超过大小限制。');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export function createService({ store, secret, cleanupSecret, now = Date.now, chooseCode = () => String(randomInt(10000)).padStart(4, '0'), lock = exclusive }) {
  check(typeof secret === 'string' && secret.length >= 32, 503, '服务尚未配置 SITE_SECRET。');
  const ticket = (kind, id, exp, extra = {}) => sign(secret, { kind, id, exp, ...extra });
  const tokenValue = (token, kind) => {
    const value = verify(secret, token, now());
    check(value.kind === kind, 403, '授权无效。');
    return value;
  };
  const getTransfer = async id => {
    check(typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id), 403, '授权无效。');
    const transfer = await store.get(`transfers/${id}`, { type: 'json' });
    check(transfer && transfer.deleteAt > now() && !['deleting', 'revoked'].includes(transfer.state), 404, '内容不存在或已过期。');
    return transfer;
  };
  const usage = async () => (await records(store, 'transfers/')).reduce((total, record) => total + record.value.reservedBytes, 0);
  const limit = used => Math.min(used >= LIMITS.soft ? MB : LIMITS.file, Math.max(0, LIMITS.capacity - used));
  const throttle = async (ip, action, count, windowMs) => {
    const identity = HASH(`${secret}:${ip || 'unknown'}:${action}`);
    const key = `rates/${identity}`;
    const previous = await store.get(key, { type: 'json' });
    const current = previous?.until > now() ? previous : { hits: 0, until: now() + windowMs };
    check(current.hits < count, 429, '请求太频繁，请稍后重试。');
    current.hits += 1;
    await store.setJSON(key, current);
  };
  const deleteTransfer = async transfer => {
    const key = `transfers/${transfer.id}`;
    await store.setJSON(key, { ...transfer, state: 'deleting' });
    const { blobs } = await store.list({ prefix: `files/${transfer.id}/` });
    for (let offset = 0; offset < blobs.length; offset += 10) {
      await Promise.all(blobs.slice(offset, offset + 10).map(blob => store.delete(blob.key)));
    }
    if (transfer.code) {
      const mapping = await store.get(`codes/${transfer.code}`, { type: 'json' });
      if (mapping?.id === transfer.id) await store.setJSON(`codes/${transfer.code}`, { ...mapping, revoked: true });
    }
    await store.delete(key);
  };
  const publish = async transfer => {
    const timestamp = now();
    let code;
    for (let attempts = 0; attempts < 200; attempts += 1) {
      const candidate = chooseCode();
      const previous = await store.get(`codes/${candidate}`, { type: 'json' });
      if (!previous || previous.reservedUntil <= timestamp) { code = candidate; break; }
    }
    check(code !== undefined, 503, '暂时没有可用取件码，请稍后重试。');
    const ready = { ...transfer, state: 'ready', code, createdAt: timestamp, codeExpiresAt: timestamp + transfer.duration * 1000, deleteAt: timestamp + 3 * DAY };
    await store.setJSON(`codes/${code}`, { id: ready.id, reservedUntil: ready.deleteAt, codeExpiresAt: ready.codeExpiresAt });
    await store.setJSON(`transfers/${ready.id}`, ready);
    return { code, expiresAt: ready.codeExpiresAt, deleteAt: ready.deleteAt, revokeToken: ticket('revoke', ready.id, ready.deleteAt) };
  };
  return {
    async status() {
      const usedBytes = await usage();
      return { usedBytes, capacityBytes: LIMITS.capacity, maxFileBytes: limit(usedBytes), textBytes: LIMITS.text, chunkBytes: LIMITS.chunk };
    },
    challenge(ip) {
      const salt = randomBytes(16).toString('hex');
      const token = ticket('challenge', randomUUID(), now() + 10 * 60000, { salt, ip: HASH(ip || 'unknown') });
      return { token, salt, difficulty: 17 };
    },
    async send(input, ip) {
      const proof = tokenValue(input.challengeToken, 'challenge');
      check(proof.ip === HASH(ip || 'unknown') && Number.isSafeInteger(input.nonce) && input.nonce >= 0 && input.nonce < 100000000, 403, '计算验证无效，请重新发送。');
      const digest = createHash('sha256').update(`${proof.salt}:${input.nonce}`).digest();
      check(digest[0] === 0 && digest[1] === 0 && digest[2] < 128, 403, '计算验证无效，请重新发送。');
      check(DURATIONS.includes(input.duration), 400, '取件码有效期不正确。');
      check(['file', 'text'].includes(input.kind), 400, '请选择文件或文字。');
      const textBytes = input.kind === 'text' && typeof input.text === 'string' ? Buffer.byteLength(input.text) : 0;
      check(input.kind !== 'text' || (textBytes > 0 && textBytes <= LIMITS.text), 413, '文字不能为空且不能超过100KB。');
      check(input.kind !== 'file' || (Number.isSafeInteger(input.size) && input.size > 0 && input.size <= LIMITS.file && typeof input.name === 'string' && input.name.length <= 255), 413, '文件不能为空且不能超过300MB。');
      return lock(store, async () => {
        await throttle(ip, 'send', 10, 3600000);
        check(!await store.get(`proofs/${proof.id}`, { type: 'json' }), 403, '计算验证已使用，请重新发送。');
        await store.setJSON(`proofs/${proof.id}`, { until: proof.exp });
        const usedBytes = await usage();
        const size = input.kind === 'file' ? input.size : textBytes;
        check(input.kind !== 'file' || size <= limit(usedBytes), 413, '文件超过当前可用容量或上传大小限制。');
        const reservedBytes = size + 8192;
        check(usedBytes + reservedBytes <= LIMITS.capacity, 507, '空间已满，请等待每日清理。');
        const id = randomUUID();
        const transfer = { id, kind: input.kind, duration: input.duration, size, reservedBytes, name: input.kind === 'file' ? input.name.replace(/[\r\n\x00-\x1f]/g, '') || 'file' : '文字消息', text: input.kind === 'text' ? input.text : undefined, state: 'pending', createdAt: now(), deleteAt: now() + PENDING_MS, parts: Math.ceil(size / LIMITS.chunk) };
        await store.setJSON(`transfers/${id}`, transfer);
        if (input.kind === 'text') return publish(transfer);
        return { uploadToken: ticket('upload', id, transfer.deleteAt), chunkBytes: LIMITS.chunk, parts: transfer.parts };
      });
    },
    async part(token, index, data) {
      const { id } = tokenValue(token, 'upload');
      return lock(store, async () => {
        const transfer = await getTransfer(id);
        check(transfer.state === 'pending', 409, '上传已经结束。');
        check(Number.isInteger(index) && index >= 0 && index < transfer.parts, 400, '分块编号无效。');
        const expected = Math.min(LIMITS.chunk, transfer.size - index * LIMITS.chunk);
        check(data.byteLength === expected, 413, '分块大小与申报文件大小不一致。');
        await store.set(`files/${id}/${index}`, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), { cacheControl: 'no-store' });
        return { ok: true };
      });
    },
    async complete(token) {
      const { id } = tokenValue(token, 'upload');
      return lock(store, async () => {
        const transfer = await getTransfer(id);
        if (transfer.state === 'ready') return { code: transfer.code, expiresAt: transfer.codeExpiresAt, deleteAt: transfer.deleteAt, revokeToken: ticket('revoke', id, transfer.deleteAt) };
        for (let index = 0; index < transfer.parts; index += 1) {
          const metadata = await store.getMetadata(`files/${id}/${index}`);
          const expected = Math.min(LIMITS.chunk, transfer.size - index * LIMITS.chunk);
          check(metadata && Number(metadata.headers?.['content-length']) === expected, 409, '文件尚未完整上传，请重新上传。');
        }
        return publish(transfer);
      });
    },
    async pickup(code, ip) {
      return lock(store, async () => {
        await throttle(ip, 'pickup', 12, 60000);
        check(typeof code === 'string' && /^\d{4}$/.test(code), 400, '请输入四位数字取件码。');
        const mapping = await store.get(`codes/${code}`, { type: 'json' });
        check(mapping && !mapping.revoked && mapping.codeExpiresAt > now(), 404, '取件码不存在或已过期。');
        const transfer = await getTransfer(mapping.id);
        check(transfer.state === 'ready' && transfer.code === code && transfer.codeExpiresAt > now(), 404, '取件码不存在或已过期。');
        return { kind: transfer.kind, name: transfer.name, size: transfer.size, text: transfer.text, parts: transfer.parts, expiresAt: transfer.codeExpiresAt, downloadToken: transfer.kind === 'file' ? ticket('download', transfer.id, transfer.codeExpiresAt) : undefined };
      });
    },
    async download(token, index) {
      const { id } = tokenValue(token, 'download');
      const transfer = await getTransfer(id);
      check(transfer.state === 'ready' && transfer.codeExpiresAt > now(), 404, '取件码已失效。');
      check(Number.isInteger(index) && index >= 0 && index < transfer.parts, 400, '分块编号无效。');
      const data = await store.get(`files/${id}/${index}`, { type: 'arrayBuffer' });
      check(data, 404, '文件不存在。');
      return data;
    },
    async revoke(token) {
      const value = verify(secret, token, now());
      check(['upload', 'revoke'].includes(value.kind), 403, '授权无效。');
      return lock(store, async () => {
        const transfer = await store.get(`transfers/${value.id}`, { type: 'json' });
        if (transfer) await deleteTransfer(transfer);
        return { ok: true };
      });
    },
    async cleanup(authorization) {
      check(typeof cleanupSecret === 'string' && cleanupSecret.length >= 32 && equal(`Bearer ${cleanupSecret}`, authorization), 403, '清理授权无效。');
      let deleted = 0;
      let more = false;
      for (const { value: transfer } of await records(store, 'transfers/')) {
        if (transfer.deleteAt > now() && transfer.state !== 'deleting') continue;
        if (deleted >= 2) { more = true; break; }
        await lock(store, async () => {
          const latest = await store.get(`transfers/${transfer.id}`, { type: 'json' });
          if (latest && (latest.deleteAt <= now() || latest.state === 'deleting')) { await deleteTransfer(latest); deleted += 1; }
        });
      }
      await lock(store, async () => {
        for (const [prefix, field] of [['codes/', 'reservedUntil'], ['rates/', 'until'], ['proofs/', 'until']]) {
          let pruned = 0;
          for (const { key, value } of await records(store, prefix)) {
            if (value[field] > now()) continue;
            if (pruned >= 50) { more = true; break; }
            await store.delete(key);
            pruned += 1;
          }
        }
      });
      const { blobs } = await store.list({ prefix: 'files/' });
      let orphaned = 0;
      for (const blob of blobs) {
        const id = blob.key.split('/')[1];
        if (!await store.get(`transfers/${id}`, { type: 'json' })) {
          if (orphaned >= 100) { more = true; break; }
          await store.delete(blob.key);
          orphaned += 1;
        }
      }
      return { ok: true, deleted, more };
    },
  };
}

export async function handle(context, serviceFactory, action) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  try {
    const { request, env = {}, clientIp } = context;
    const expected = ['status', 'health'].includes(action) ? 'GET' : 'POST';
    check(request.method === expected, 405, '请求方法不支持。');
    if (request.method === 'POST' && request.headers.has('origin')) check(request.headers.get('origin') === new URL(request.url).origin, 403, '不允许跨站请求。');
    const service = serviceFactory(env);
    if (action === 'health') { await service.status(); return Response.json({ ok: true, storage: 'reachable' }, { headers }); }
    let input;
    if (!['status', 'health', 'part', 'cleanup'].includes(action)) {
      try { input = JSON.parse((await readBody(request, LIMITS.text + 8192)).toString('utf8')); } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, '请求格式错误。');
      }
      check(input && typeof input === 'object' && !Array.isArray(input), 400, '请求格式错误。');
    }
    let result;
    if (action === 'status') result = await service.status();
    else if (action === 'challenge') result = service.challenge(clientIp);
    else if (action === 'send') result = await service.send(input, clientIp);
    else if (action === 'part') result = await service.part(request.headers.get('x-upload-token'), Number(new URL(request.url).searchParams.get('index')), await readBody(request, LIMITS.chunk));
    else if (action === 'complete') result = await service.complete(input.token);
    else if (action === 'pickup') result = await service.pickup(input.code, clientIp);
    else if (action === 'download') return new Response(await service.download(input.token, input.index), { headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
    else if (action === 'revoke') result = await service.revoke(input.token);
    else if (action === 'cleanup') result = await service.cleanup(request.headers.get('authorization'));
    else throw new HttpError(404, '接口不存在。');
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof BusyError ? 503 : error.status || 500;
    if (status === 500) console.error('pickup-drop request failed', error.name, error.code || 'INTERNAL');
    return Response.json({ error: status === 500 ? '服务暂时不可用，请稍后重试。' : error.message }, { status, headers });
  }
}
