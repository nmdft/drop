import { randomUUID } from 'node:crypto';

export class BusyError extends Error {}

export async function exclusive(store, operation, { timeout = 15000, pause = 80 } = {}) {
  const identity = randomUUID();
  const key = `locks/${identity}`;
  const started = Date.now();
  const readTickets = async () => {
    const { blobs } = await store.list({ prefix: 'locks/' });
    return (await Promise.all(blobs.map(blob => store.get(blob.key, { type: 'json' })))).filter(Boolean);
  };
  try {
    await store.setJSON(key, { identity, choosing: true, number: 0, started });
    const number = Math.max(0, ...(await readTickets()).map(ticket => ticket.number)) + 1;
    await store.setJSON(key, { identity, choosing: false, number, started });
    while (true) {
      const blocked = (await readTickets()).some(ticket => ticket.identity !== identity && (
        ticket.choosing || ticket.number < number ||
        (ticket.number === number && ticket.identity < identity)
      ));
      if (!blocked) return await operation();
      if (Date.now() - started >= timeout) throw new BusyError('服务暂时繁忙，请稍后重试。');
      await new Promise(resolve => setTimeout(resolve, pause));
    }
  } finally {
    await store.delete(key);
  }
}

export async function records(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const result = [];
  for (let offset = 0; offset < blobs.length; offset += 20) {
    const batch = await Promise.all(blobs.slice(offset, offset + 20).map(async blob => ({
      key: blob.key, value: await store.get(blob.key, { type: 'json' }),
    })));
    result.push(...batch.filter(record => record.value));
  }
  return result;
}
