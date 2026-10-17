import { getStore } from '@edgeone/pages-blob';
import { createService, handle } from './service.js';
import { siteSecret, cleanupSecret } from './secrets.js';

export async function serviceFromEnv(env) {
  const store = getStore({ name: 'pickup-drop', consistency: 'strong' });
  const secret = await siteSecret(store, env);
  return createService({ store, secret, cleanupSecret: env.CLEANUP_SECRET || cleanupSecret(secret) });
}

export function route(context, action) {
  return handle(context, serviceFromEnv, action);
}
