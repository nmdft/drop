import { route } from '../../lib/runtime.js';
export const onRequest = context => route(context, 'health');
