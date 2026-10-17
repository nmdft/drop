import { serviceFromEnv } from '../../lib/runtime.js';
import { scheduledCleanup } from '../../lib/scheduled-cleanup.js';
import { scheduleToken } from '../../lib/generated-schedule.js';
export const onRequest = context => scheduledCleanup(context, serviceFromEnv, Date.now, scheduleToken);
