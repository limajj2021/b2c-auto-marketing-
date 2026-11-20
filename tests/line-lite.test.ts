// LINE 預設只需官方帳號 ID；連接 LINE 數據只讀好友數、不接管訊息；自動接待為加購
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { syncLineFollowers } from '../src/line/insights';
import { lineAddUrl, lineIdFromUrl } from '../src/line/links';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const SECRET = 'a'.repeat(32);

describe('LINE ID only (default)', () => {
  it('turns an official account ID into an add-friend link and back', () => {
    expect(lineAddUrl('@033AZWUD')).toBe('https://line.me/R/ti/p/@033azwud');
    expect(lineAddUrl('033azwud')).toBe('https://line.me/R/ti/p/@033azwud');
    expect(lineAddUrl('https://line.me/R/ti/p/%40033azwud')).toBe('https://line.me/R/ti/p/@033azwud');
    expect(lineAddUrl('不是 ID')).toBeNull();
    expect(lineIdFromUrl('https://line.me/R/ti/p/@033azwud')).toBe('@033azwud');
    expect(lineIdFromUrl('https://example.com')).toBe('');
  });

  it('saving just the LINE ID sets the link used by posts', async () => {
    const env = await makeEnv();
    const c = await login(env);
    expect((await api(env, 'PUT', '/api/settings', { line_id: 'oops id!' }, c)).status).toBe(400);
    expect((await api(env, 'PUT', '/api/settings', { line_id: '@vuca' }, c)).status).toBe(200);
    const s = (await (await api(env, 'GET', '/api/settings', undefined, c)).json()) as any;
    expect(s.settings).toMatchObject({ line_add_url: 'https://line.me/R/ti/p/@vuca', line_id: '@vuca' });
  });
});

describe('connect LINE data (read-only) without the auto-reply add-on', () => {
  it('does not take over the webhook, and fills the LINE link from the account ID', async () => {
    const env = await makeEnv({ leads: false });
    await env.DB.prepare("UPDATE brand_settings SET line_add_url=''").run();
    const m = mockFetch((u) => u.endsWith('/oauth/accessToken') ? jres({ access_token: 'TOK', expires_in: 2592000 })
      : u.endsWith('/v2/bot/info') ? jres({ displayName: 'VUCA', basicId: '@vuca', chatMode: 'bot' }) : jres({ success: true })); restore = m.restore;
    const c = await login(env);
    const r = (await (await api(env, 'POST', '/api/integrations/line', { channel_id: '2001234567', channel_secret: SECRET }, c)).json()) as any;
    expect(r).toMatchObject({ ok: true, mode: 'data', webhook_set: false });
    expect(m.calls.some((x) => x.url.includes('/webhook'))).toBe(false);
    expect(((await env.DB.prepare('SELECT line_add_url u FROM brand_settings').first()) as any).u).toBe('https://line.me/R/ti/p/@vuca');
    expect((await api(env, 'POST', '/api/integrations/line/webhook', undefined, c)).status).toBe(403); // 自動接待需加購
  });

  it('records daily new friends from LINE statistics (yesterday, Japan time), once', async () => {
    const env: any = await makeEnv({ leads: false });
    env.LINE_CHANNEL_ACCESS_TOKEN = 'TOK';
    const cum: Record<string, number> = { 20261110: 100, 20261111: 112 };
    const m = mockFetch((u) => { const d = new URL(u).searchParams.get('date')!; return jres(cum[d] !== undefined ? { status: 'ready', followers: cum[d], blocks: 3 } : { status: 'unready' }); }); restore = m.restore;
    const now = new Date('2026-11-12T03:00:00Z'); // 日本時間 11/12 12:00 → 昨天 11/11
    await syncLineFollowers(env, now);
    const rows = (await env.DB.prepare("SELECT day,name,count FROM metrics_daily ORDER BY name,day").all()).results;
    expect(rows).toEqual([
      { day: '2026-11-11', name: 'friend_add', count: 12 },
      { day: '2026-11-10', name: 'line_followers', count: 100 }, { day: '2026-11-11', name: 'line_followers', count: 112 },
    ]);
    const n = m.calls.length;
    await syncLineFollowers(env, new Date('2026-11-12T04:00:00Z'));
    expect(m.calls.length).toBe(n); // 已有昨天的資料就不再查
  });

  it('waits when LINE has not prepared the data yet, and skips add-on customers (counted live by webhook)', async () => {
    const env: any = await makeEnv({ leads: false });
    env.LINE_CHANNEL_ACCESS_TOKEN = 'TOK';
    let m = mockFetch(() => jres({ status: 'unready' })); restore = m.restore;
    await syncLineFollowers(env, new Date('2026-11-12T03:00:00Z'));
    expect(((await env.DB.prepare('SELECT COUNT(*) c FROM metrics_daily').first()) as any).c).toBe(0);
    m.restore();
    const addon: any = await makeEnv({ leads: true });
    addon.LINE_CHANNEL_ACCESS_TOKEN = 'TOK';
    m = mockFetch(() => jres({ status: 'ready', followers: 1 })); restore = m.restore;
    await syncLineFollowers(addon, new Date('2026-11-12T03:00:00Z'));
    expect(m.calls.length).toBe(0);
  });
});
