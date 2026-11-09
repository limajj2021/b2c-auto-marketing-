import { handleApi } from './admin/routes';
import { handleLineWebhook } from './line/webhook';
import { withCreds } from './integrations';
import { handleCallback, handleMetaCallback, refreshIfNeeded } from './threads/oauth';
import { runCron } from './threads/scheduler';
import type { Env } from './types';

export default {
  async fetch(req: Request, rawEnv: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      const env = await withCreds(rawEnv); // 後台所設的加密憑證優先於 wrangler secret
      if (pathname === '/line/webhook' && req.method === 'POST') return await handleLineWebhook(env, req);
      if (pathname === '/threads/callback' && req.method === 'GET') return await handleCallback(env, req);
      if (pathname === '/threads/deauthorize' && req.method === 'POST') return await handleMetaCallback(env, req, 'deauthorize');
      if (pathname === '/threads/delete' && req.method === 'POST') return await handleMetaCallback(env, req, 'delete');
      if (pathname.startsWith('/api/')) return await handleApi(env, req);
    } catch (e) {
      console.error('unhandled', (e as Error).message); // 不記錄請求內容
      return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return rawEnv.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledController, rawEnv: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      let env = await withCreds(rawEnv);
      await refreshIfNeeded(env).catch((e) => console.error('refresh', (e as Error).message));
      env = await withCreds(rawEnv); // 續期後重新取得最新 token
      await runCron(env);
    })());
  },
} satisfies ExportedHandler<Env>;
