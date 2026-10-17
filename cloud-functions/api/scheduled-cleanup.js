import { serviceFromEnv } from '../../lib/runtime.js';
import { scheduledCleanup } from '../../lib/scheduled-cleanup.js';
export const onRequest = context => scheduledCleanup(context, serviceFromEnv);
