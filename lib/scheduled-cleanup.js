import { HttpError, readBody } from './service.js';

export async function scheduledCleanup(context, serviceFactory, now = Date.now) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    if (context.request.method !== 'POST') throw new HttpError(405, '请求方法不支持。');
    let input;
    try { input = JSON.parse((await readBody(context.request, 4096)).toString('utf8')); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, '请求格式错误。'); }
    const service = serviceFactory(context.env || {});
    const authorization = `Bearer ${input?.token || ''}`;
    const deadline = now() + 80000;
    let deleted = 0;
    for (let batch = 0; batch < 500; batch += 1) {
      const result = await service.cleanup(authorization);
      deleted += result.deleted;
      if (!result.more) {
        console.info('Drop scheduled cleanup completed', { deleted, batches: batch + 1 });
        return Response.json({ ok: true, deleted, more: false }, { headers });
      }
      if (now() >= deadline) break;
    }
    console.error('Drop scheduled cleanup incomplete; inspect function logs and rerun with authorization');
    return Response.json({ ok: false, deleted, more: true }, { status: 503, headers });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('Drop scheduled cleanup failed', error.name);
    return Response.json({ error: status === 500 ? '清理失败，请检查函数日志。' : error.message }, { status, headers });
  }
}
