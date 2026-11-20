import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { credStatus, getMeta, withCreds } from '../src/integrations';
import { renewLineTokenIfNeeded } from '../src/line/token';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) =>
  handleApi(env, new Request(`https://x${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const SECRET = 'a'.repeat(32);

describe('LINE: connect with Channel ID + secret only', () => {
  it('issues a token, stores it, sets the webhook, and renews it before expiry', async () => {
    const env = await makeEnv();
    let n = 0;
    const m = mockFetch((u, init) => {
      if (u.endsWith('/v2/oauth/accessToken')) {
        const p = new URLSearchParams(String(init?.body));
        if (p.get('client_secret') !== SECRET) return jres({ error: 'invalid_client' }, 400);
        return jres({ access_token: `TOK${++n}`, expires_in: 2592000, token_type: 'Bearer' });
      }
      if (u.endsWith('/v2/bot/info')) return jres({ displayName: 'VUCA', basicId: '@vuca', chatMode: 'chat' });
      if (u.endsWith('/webhook/test')) return jres({ success: true });
      return jres({});
    }); restore = m.restore;
    const c = await login(env);
    const bad = await api(env, 'POST', '/api/integrations/line', { channel_id: '2001234567', channel_secret: 'b'.repeat(32) }, c);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain('不正確');
    const ok = await api(env, 'POST', '/api/integrations/line', { channel_id: '2001234567', channel_secret: SECRET }, c);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as any;
    expect(okBody.webhook_verified).toBe(true);
    expect(okBody).toMatchObject({ basic_id: '@vuca', chat_mode: 'chat' }); // 聊天功能開啟中要提醒
    const ig = (await (await api(env, 'GET', '/api/integrations', undefined, c)).json()) as any;
    expect(ig.line).toMatchObject({ configured: true, basic_id: '@vuca', chat_mode: 'chat', auto_token: true });
    const e1 = await withCreds({ ...env, LINE_CHANNEL_ACCESS_TOKEN: '', LINE_CHANNEL_SECRET: '' });
    expect(e1.LINE_CHANNEL_ACCESS_TOKEN).toBe('TOK1');
    expect(e1.LINE_CHANNEL_ID).toBe('2001234567');
    expect((await credStatus(env)).line_channel_access_token.meta.auto).toBe(true);

    await renewLineTokenIfNeeded(e1, new Date()); // 還有 30 天：不換
    expect(n).toBe(1);
    await renewLineTokenIfNeeded(e1, new Date(Date.now() + 25 * 86400000)); // 剩 5 天：換新
    expect(n).toBe(2);
    expect((await withCreds(env)).LINE_CHANNEL_ACCESS_TOKEN).toBe('TOK2');
    expect((await getMeta(env, 'line_channel_access_token'))!.name).toBe('VUCA');
  });

  it('still accepts a self-issued long-lived token, which is never auto-renewed', async () => {
    const env = await makeEnv();
    const m = mockFetch((u) => u.endsWith('/v2/bot/info') ? jres({ displayName: 'X' }) : jres({ success: true })); restore = m.restore;
    const c = await login(env);
    expect((await api(env, 'POST', '/api/integrations/line', { channel_secret: SECRET, channel_access_token: 'L'.repeat(60) }, c)).status).toBe(200);
    const n = m.calls.length;
    await renewLineTokenIfNeeded(await withCreds(env), new Date(Date.now() + 365 * 86400000));
    expect(m.calls.length).toBe(n);
    expect(m.calls.some((x) => x.url.includes('/oauth/accessToken'))).toBe(false);
  });
});
