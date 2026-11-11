import { handleApi } from './admin/routes';
import { brandBySlug, forBrand, getBrand, isMulti } from './db';
import { withCreds } from './integrations';
import { handleLineWebhook } from './line/webhook';
import { runAllTenants } from './tenants';
import { handleCallback, handleMetaCallback } from './threads/oauth';
import type { Env } from './types';

export default {
  async fetch(req: Request, raw: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      // LINE Webhook：共用架構下每個工作區一個網址 /line/webhook/<工作區代號>
      const lw = pathname.match(/^\/line\/webhook(?:\/([a-z0-9-]{2,40}))?$/);
      if (lw && req.method === 'POST') {
        const b = lw[1] ? await brandBySlug(raw, lw[1]) : isMulti(raw) ? null : await getBrand(raw).catch(() => null);
        if (!b || b.status === 'suspended') return new Response('not found', { status: 404 });
        return await handleLineWebhook(await withCreds(forBrand(raw, b.id)), req);
      }
      if (pathname === '/threads/callback' && req.method === 'GET') return await handleCallback(raw, req);
      if (pathname === '/threads/deauthorize' && req.method === 'POST') return await handleMetaCallback(raw, req, 'deauthorize');
      if (pathname === '/threads/delete' && req.method === 'POST') return await handleMetaCallback(raw, req, 'delete');
      if (pathname.startsWith('/api/')) return await handleApi(raw, req);
    } catch (e) {
      console.error('unhandled', (e as Error).message); // 不記錄請求內容
      return new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return raw.ASSETS.fetch(req);
  },

  async scheduled(_ev: ScheduledController, raw: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAllTenants(raw).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
