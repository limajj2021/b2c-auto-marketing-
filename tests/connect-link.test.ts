// 授權連結：傳給 Threads 帳號擁有者，不登入後台也能完成授權
import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleApi } from '../src/admin/routes';
import { makeConnectLink } from '../src/threads/connectlink';
import { listAccounts } from '../src/threads/accounts';
import { hashPassword, signToken } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const ck = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const customer = async (env: any) => ck(await call(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' }));
const get = (env: any, url: string) => worker.fetch(new Request(url, { redirect: 'manual' }), env);
const meta = (name: string) => mockFetch((u) => u.includes('/oauth/access_token') ? jres({ access_token: 's' }) : u.includes('th_exchange_token') ? jres({ access_token: 'L', expires_in: 5184000 }) : jres({ id: '9', username: name }));

async function setup() {
  const env: any = await makeEnv();
  env.THREADS_APP_ID = 'app'; env.THREADS_APP_SECRET = 'sec'; env.PUBLIC_BASE_URL = 'https://x.dev';
  return env;
}

describe('Threads authorization link', () => {
  it('opens a plain explanation page, then sends the account owner to Threads — no login to this admin needed', async () => {
    const env = await setup();
    const c = await customer(env);
    const made = (await (await call(env, 'POST', '/api/threads/connect-link', { username: '@Afu.Coffee' }, c)).json()) as any;
    expect(made.url).toMatch(/^https:\/\/x\.dev\/threads\/connect\?t=/); expect(made.days).toBe(7);
    // 沒有 Cookie（客戶的員工、帳號擁有者）：先看到說明頁，不是直接跳走
    const page = await get(env, made.url);
    const html = await page.text();
    expect(page.status).toBe(200); expect(html).toContain('測試品牌'); expect(html).toContain('@afu.coffee'); expect(html).toContain('繼續授權');
    const next = new URL(html.match(/href="([^"]*go=1)"/)![1].replace(/&amp;/g, '&'), 'https://x.dev');
    const go = await get(env, next.toString());
    expect(go.status).toBe(302);
    const to = new URL(go.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://threads.net/oauth/authorize'); expect(to.searchParams.get('redirect_uri')).toBe('https://x.dev/threads/callback');
    // 授權回來：帳號連到產生連結的品牌，結果顯示在公開的結果頁
    const m = meta('Afu.Coffee'); restore = m.restore;
    const done = await get(env, `https://x.dev/threads/callback?code=c&state=${encodeURIComponent(to.searchParams.get('state')!)}`);
    expect(done.headers.get('location')).toMatch(/^\/connect-done\.html\?ok=1&u=Afu\.Coffee&b=/);
    expect((await listAccounts(env)).map((a) => a.username)).toEqual(['Afu.Coffee']);
  });

  it('refuses a different account than the one the link was made for, and says so on the result page', async () => {
    const env = await setup();
    const link = await makeConnectLink(env, 'https://x.dev', 'b1', 'vuca.tw');
    const html = await (await get(env, link)).text();
    const to = new URL((await get(env, new URL(html.match(/href="([^"]*go=1)"/)![1].replace(/&amp;/g, '&'), 'https://x.dev').toString())).headers.get('location')!);
    const m = meta('vuca.canada'); restore = m.restore;
    const r = await get(env, `https://x.dev/threads/callback?code=c&state=${encodeURIComponent(to.searchParams.get('state')!)}`);
    const loc = decodeURIComponent(r.headers.get('location')!);
    expect(loc).toMatch(/^\/connect-done\.html\?err=/); expect(loc).toContain('你授權的是 @vuca.canada'); expect(loc).toContain('@vuca.tw');
    expect(await listAccounts(env)).toEqual([]);
  });

  it('works without naming an account (any account the owner authorizes is connected to that brand)', async () => {
    const env = await setup();
    const html = await (await get(env, await makeConnectLink(env, 'https://x.dev', 'b1'))).text();
    expect(html).toContain('你的 Threads 帳號');
    const to = new URL((await get(env, new URL(html.match(/href="([^"]*go=1)"/)![1].replace(/&amp;/g, '&'), 'https://x.dev').toString())).headers.get('location')!);
    const m = meta('anyone'); restore = m.restore;
    expect((await get(env, `https://x.dev/threads/callback?code=c&state=${encodeURIComponent(to.searchParams.get('state')!)}`)).headers.get('location')).toContain('ok=1');
  });

  it('rejects expired, tampered, suspended-brand and foreign tokens; a link token is not a login session', async () => {
    const env = await setup();
    const old = await makeConnectLink(env, 'https://x.dev', 'b1', undefined, Date.now() - 8 * 86400000);
    expect((await get(env, old)).status).toBe(400);
    const good = await makeConnectLink(env, 'https://x.dev', 'b1');
    expect((await get(env, good.slice(0, -3) + 'xxx')).status).toBe(400);
    expect((await get(env, 'https://x.dev/threads/connect')).status).toBe(400);
    await env.DB.prepare("UPDATE brands SET status='suspended' WHERE id='b1'").run();
    expect((await get(env, good)).status).toBe(400);
    await env.DB.prepare("UPDATE brands SET status='active' WHERE id='b1'").run();
    // 用別的金鑰、或別的用途簽出的 token 不能當授權連結
    const foreign = `https://x.dev/threads/connect?t=${encodeURIComponent(await signToken(env.SESSION_SECRET, { uid: 0, p: 'threads_link', b: 'b1', exp: Math.floor(Date.now() / 1000) + 600 }))}`;
    expect((await get(env, foreign)).status).toBe(400);
    // 授權連結 token 不能拿來當登入 Session
    const t = new URL(good).searchParams.get('t')!;
    expect((await call(env, 'GET', '/api/me', undefined, `sid=${t}`)).status).toBe(401);
    // 一個品牌的連結不能把帳號放進別的品牌：授權 state 的品牌來自連結，不是使用者可改的參數
    expect(new URL(good).searchParams.get('b')).toBeNull();
  });

  it('only brand admins and operators can create links; invalid names are rejected', async () => {
    const env = await setup();
    const staff = ck(await call(env, 'POST', '/api/login', { username: 'cs', password: 'staff-password-1' }));
    expect((await call(env, 'POST', '/api/threads/connect-link', {}, staff)).status).toBe(403);
    expect((await call(env, 'POST', '/api/threads/connect-link', {})).status).toBe(401);
    const c = await customer(env);
    expect((await call(env, 'POST', '/api/threads/connect-link', { username: 'bad name!' }, c)).status).toBe(400);
    expect((await call(env, 'POST', '/api/threads/connect-link', {}, c)).status).toBe(200);
    // 營運人員（維護人員也可以）替客戶產生
    await env.DB.prepare("UPDATE brands SET slug='acme' WHERE id='b1'").run();
    await env.DB.prepare('INSERT INTO operators(username,password_hash,role,created_at) VALUES(?,?,?,?)').bind('sup', await hashPassword('operator-pass-1'), 'support', 'x').run();
    const op = ck(await call(env, 'POST', '/api/op/login', { username: 'sup', password: 'operator-pass-1' }));
    const r = (await (await call(env, 'POST', '/api/op/tenants/acme/connect-link', { username: 'afu' }, op)).json()) as any;
    expect(r.url).toContain('/threads/connect?t='); expect((await call(env, 'POST', '/api/op/tenants/nobody/connect-link', {}, op)).status).toBe(404);
  });
});
