import { getStore } from '@edgeone/pages-blob';
import { createService, handle, HttpError } from './service.js';

export function route(context, action) {
  return handle(context, env => {
    if (!env.SITE_SECRET || env.SITE_SECRET.length < 32) throw new HttpError(503, '服务尚未配置 SITE_SECRET。');
    return createService({
      store: getStore({ name: 'pickup-drop', consistency: 'strong' }),
      secret: env.SITE_SECRET,
      cleanupSecret: env.CLEANUP_SECRET,
    });
  }, action);
}
