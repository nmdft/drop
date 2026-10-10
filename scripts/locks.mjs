import { getStore } from '@edgeone/pages-blob';

const store = getStore({ name: 'pickup-drop', consistency: 'strong', projectId: process.env.EDGEONE_PROJECT_ID, token: process.env.EDGEONE_PAGES_API_TOKEN });
const { blobs } = await store.list({ prefix: 'locks/' });
for (const { key } of blobs) {
  const value = await store.get(key, { type: 'json' });
  console.log({ key, started: value?.started, number: value?.number, choosing: value?.choosing });
}
if (process.argv.includes('--reset-after-pausing-site')) {
  if (blobs.length && (await Promise.all(blobs.map(blob => store.get(blob.key, { type: 'json' })))).some(value => !value || Date.now() - value.started < 180000)) {
    throw new Error('拒绝恢复：存在不足3分钟的锁。请先停止站点请求，再等待至少3分钟。');
  }
  for (const { key } of blobs) await store.delete(key);
  console.log(`Removed ${blobs.length} stale tickets. Resume the site only after this command finishes.`);
}
