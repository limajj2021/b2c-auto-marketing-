import { handleApi } from './admin/routes';
import { handleLineWebhook } from './line/webhook';
import { runCron } from './threads/scheduler';
import type { Env } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/line/webhook' && req.method === 'POST') return await handleLineWebhook(env, req);
      if (pathname.startsWith('/api/')) return await handleApi(env, req);
    } catch (e) {
      console.error('unhandled', (e as Error).message); // 不記錄請求內容
      return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
