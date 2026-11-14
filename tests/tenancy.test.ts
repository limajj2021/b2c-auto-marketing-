import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleApi } from '../src/admin/routes';
import { setCred, withCreds } from '../src/integrations';
import { forBrand } from '../src/db';
import { runAllTenants } from '../src/tenants';
import { upsertAccount, listAccounts } from '../src/threads/accounts';
import { hashPassword, hmacBase64 } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());

/** 兩個工作區：acme（b1）與 beta（b2），共用架構模式 */
async function twoTenants() {
  const env: any = await makeEnv();
  env.MULTI_TENANT = '1';
  await env.DB.prepare("UPDATE brands SET slug='acme', created_at='2026-01-01' WHERE id='b1'").run();
  await env.DB.prepare("INSERT INTO brands(id,slug,name,industry,description,timezone,created_at) VALUES('b2','beta','Beta 公司','general','','Asia/Taipei','2026-02-01')").run();
  await env.DB.prepare("INSERT INTO brand_settings(brand_id,updated_at,leads_enabled) VALUES('b2','x',1)").run();
  await env.DB.prepare("INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES('b2','admin','beta-boss',?)").bind(await hashPassword('beta-password-1')).run();
  return env;
}
const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) =>
  handleApi(env, new Request(`https://app.dev${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const loginTo = async (env: any, _ignored: string | undefined, username: string, password: string) => {
  const r = await call(env, 'POST', '/api/login', { username, password });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], body: await r.json() as any };
};

describe('workspace login & isolation', () => {
  it('logs in with username and password only; the username decides the workspace (case-insensitive)', async () => {
    const env = await twoTenants();
    expect((await loginTo(env, undefined, 'beta-boss', 'correct-horse-1')).status).toBe(401); // acme 的密碼不能登入 beta 的帳號
    expect((await loginTo(env, undefined, 'nobody', 'x')).status).toBe(401);
    const a = await loginTo(env, undefined, 'BOSS', 'correct-horse-1');
    const b = await loginTo(env, undefined, 'beta-boss', 'beta-password-1');
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect((await (await call(env, 'GET', '/api/settings', undefined, a.cookie)).json() as any).brand.name).toBe('測試品牌');
    expect((await (await call(env, 'GET', '/api/settings', undefined, b.cookie)).json() as any).brand.name).toBe('Beta 公司');
  });

  it('usernames are unique across all workspaces (case-insensitive): rename, add staff and onboarding are refused', async () => {
    const env = await twoTenants();
    // 資料庫層：不允許兩個工作區出現同名（不分大小寫）帳號
    await expect(env.DB.prepare("INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES('b2','staff','BOSS','x')").run()).rejects.toThrow();
    const b = (await loginTo(env, undefined, 'beta-boss', 'beta-password-1')).cookie;
    expect((await call(env, 'POST', '/api/account', { current: 'beta-password-1', username: 'Boss' }, b)).status).toBe(409);
    expect((await call(env, 'POST', '/api/users', { username: 'Boss', role: 'staff', password: 'longpassword1' }, b)).status).toBe(409);
    expect((await call(env, 'POST', '/api/users', { username: 'beta-cs', role: 'staff', password: 'longpassword1' }, b)).status).toBe(200);
    expect((await loginTo(env, undefined, 'beta-cs', 'longpassword1')).status).toBe(200);
  });

  it("cannot read or modify another workspace's posts, inquiries or accounts", async () => {
    const env = await twoTenants();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES('b1','acme 草稿','draft','x','x')").run();
    await env.DB.prepare("INSERT INTO contacts(brand_id,line_user_id,created_at) VALUES('b1','Uacme','x')").run();
    await env.DB.prepare("INSERT INTO inquiries(brand_id,contact_id,flow_id,answers,created_at) VALUES('b1',1,'f','{\"name\":\"王小明\"}','2026-11-01')").run();
    const acct = await upsertAccount(forBrand(env, 'b1'), 'b1', { userId: '9', username: 'acme_threads', token: 'T', expiresAt: null });
    const b = (await loginTo(env, undefined, 'beta-boss', 'beta-password-1')).cookie;
    expect(await (await call(env, 'GET', '/api/posts', undefined, b)).json()).toEqual([]);
    expect(await (await call(env, 'GET', '/api/inquiries', undefined, b)).json()).toEqual([]);
    expect((await call(env, 'PUT', '/api/posts/1', { parts: ['被改了'] }, b)).status).toBe(409);
    expect((await call(env, 'DELETE', '/api/inquiries/1', undefined, b)).status).toBe(200); // 指令被接受但不影響別人的資料
    expect(((await env.DB.prepare('SELECT COUNT(*) c FROM inquiries').first()) as any).c).toBe(1);
    expect((await call(env, 'PATCH', `/api/accounts/${acct}`, { persona: 'x' }, b)).status).toBe(404);
    expect((await call(env, 'POST', '/api/posts/generate', { account_id: acct }, b)).status).toBe(404);
    const exp = await (await call(env, 'GET', '/api/export', undefined, b)).json() as any;
    expect(exp.posts).toEqual([]); expect(exp.inquiries).toEqual([]); expect(JSON.stringify(exp)).not.toContain('acme');
  });

  it('credentials are per workspace; platform-level LINE/Threads secrets are never used in shared mode', async () => {
    const env = await twoTenants();
    await setCred(forBrand(env, 'b1'), 'b1', 'line_channel_secret', 'a'.repeat(32));
    const a = await withCreds(forBrand(env, 'b1')), b = await withCreds(forBrand(env, 'b2'));
    expect(a.LINE_CHANNEL_SECRET).toBe('a'.repeat(32));
    expect(b.LINE_CHANNEL_SECRET).toBe(''); // env 裡的 line-secret 不可外流到 beta
    expect(b.THREADS_ACCESS_TOKEN).toBe('');
    expect((await listAccounts(forBrand(env, 'b2'))).length).toBe(0);
  });

  it('LINE webhook is routed by workspace and verified with that workspace secret', async () => {
    const env = await twoTenants();
    await setCred(forBrand(env, 'b2'), 'b2', 'line_channel_secret', 'b'.repeat(32));
    await setCred(forBrand(env, 'b2'), 'b2', 'line_channel_access_token', 't'.repeat(60));
    const m = mockFetch(() => jres({})); restore = m.restore;
    const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'e1', replyToken: 'r', source: { userId: 'U1' }, message: { type: 'text', text: '你好' } }] });
    const send = async (path: string, secret: string) => worker.fetch(new Request(`https://app.dev${path}`, { method: 'POST', body, headers: { 'x-line-signature': await hmacBase64(secret, body) } }), env);
    expect((await send('/line/webhook/beta', 'a'.repeat(32))).status).toBe(401); // 用錯的密鑰
    expect((await send('/line/webhook', 'b'.repeat(32))).status).toBe(404);      // 共用架構下沒有預設工作區
    expect((await send('/line/webhook/nope', 'b'.repeat(32))).status).toBe(404);
    expect((await send('/line/webhook/beta', 'b'.repeat(32))).status).toBe(200);
    expect(((await env.DB.prepare("SELECT brand_id FROM contacts").first()) as any).brand_id).toBe('b2');
  });
});

describe('operator console', () => {
  const opEnv = async () => {
    const env = await twoTenants();
    await env.DB.prepare("INSERT INTO operators(username,password_hash,created_at) VALUES('ops',?,'x')").bind(await hashPassword('operator-pass-1')).run();
    const r = await call(env, 'POST', '/api/op/login', { username: 'ops', password: 'operator-pass-1' });
    return { env, op: (r.headers.get('set-cookie') ?? '').split(';')[0] };
  };

  it('creates a workspace whose admin can log in, and lists health/usage without customer content', async () => {
    const { env, op } = await opEnv();
    expect((await call(env, 'GET', '/api/op/tenants')).status).toBe(401);
    const tenantAdmin = (await loginTo(env, undefined, 'boss', 'correct-horse-1')).cookie.replace('sid=', 'osid=');
    expect((await call(env, 'GET', '/api/op/tenants', undefined, tenantAdmin)).status).toBe(401); // 客戶管理員不是營運人員
    const c = await call(env, 'POST', '/api/op/tenants', { slug: 'gamma', name: 'Gamma' }, op);
    const made = await c.json() as any;
    expect(c.status).toBe(201); expect(made.login_url).toBe('https://app.dev'); expect(made.admin_username).toBe('gamma-admin');
    expect((await call(env, 'POST', '/api/op/tenants', { slug: 'gamma', name: 'dup' }, op)).status).toBe(409);
    expect((await loginTo(env, undefined, 'gamma-admin', made.password)).status).toBe(200);
    await env.DB.prepare("INSERT INTO contacts(brand_id,line_user_id,created_at) VALUES('b1','U','x')").run();
    await env.DB.prepare(`INSERT INTO inquiries(brand_id,contact_id,flow_id,answers,created_at) VALUES('b1',1,'f','{"name":"王小明"}',?)`).bind(new Date().toISOString()).run();
    const list = await (await call(env, 'GET', '/api/op/tenants', undefined, op)).json() as any;
    expect(list.tenants.map((t: any) => t.slug)).toEqual(['acme', 'beta', 'gamma']);
    expect(list.tenants[0].leads).toBe(1);
    expect(list.tenants[2].issues).toContain('未設定 LINE 加好友連結');
    expect(JSON.stringify(list)).not.toContain('王小明');
  });

  it('suspending a workspace blocks its logins, webhook and cron, but not others', async () => {
    const { env, op } = await opEnv();
    const a = (await loginTo(env, undefined, 'boss', 'correct-horse-1')).cookie;
    expect((await call(env, 'PATCH', '/api/op/tenants/acme', { status: 'suspended' }, op)).status).toBe(200);
    expect((await loginTo(env, undefined, 'boss', 'correct-horse-1')).status).toBe(403);
    expect((await call(env, 'GET', '/api/dashboard', undefined, a)).status).toBe(403); // 既有登入也立即失效
    const res = await runAllTenants(env);
    expect(res.processed).toEqual(['b2']);
    expect((await loginTo(env, undefined, 'beta-boss', 'beta-password-1')).status).toBe(200);
  });

  it('cron rotates workspaces fairly when there are more than one batch', async () => {
    const { env } = await opEnv();
    env.CRON_BATCH = '1';
    expect((await runAllTenants(env, new Date('2026-11-08T00:00:00Z'))).processed).toEqual(['b1']);
    expect((await runAllTenants(env, new Date('2026-11-08T00:05:00Z'))).processed).toEqual(['b2']);
    expect((await runAllTenants(env, new Date('2026-11-08T00:10:00Z'))).processed).toEqual(['b1']);
  });
});

describe('login without a workspace code', () => {
  it('operator onboarding rejects a taken admin username and defaults to <slug>-admin', async () => {
    const env = await twoTenants();
    await env.DB.prepare("INSERT INTO operators(username,password_hash,created_at) VALUES('ops',?,'x')").bind(await hashPassword('operator-pass-1')).run();
    const op = ((await call(env, 'POST', '/api/op/login', { username: 'ops', password: 'operator-pass-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const dup = await call(env, 'POST', '/api/op/tenants', { slug: 'delta', name: 'Delta', admin_username: 'BOSS' }, op);
    expect(dup.status).toBe(409);
    const ok = await (await call(env, 'POST', '/api/op/tenants', { slug: 'delta', name: 'Delta' }, op)).json() as any;
    expect(ok.admin_username).toBe('delta-admin');
    expect((await loginTo(env, undefined, 'delta-admin', ok.password)).status).toBe(200);
  });

  it('a suspended workspace is only revealed after a correct password; failures are throttled per username', async () => {
    const env = await twoTenants();
    await env.DB.prepare("UPDATE brands SET status='suspended' WHERE id='b2'").run();
    expect((await loginTo(env, undefined, 'beta-boss', 'wrong-password')).status).toBe(401); // 不洩漏停用狀態
    expect((await loginTo(env, undefined, 'beta-boss', 'beta-password-1')).status).toBe(403);
    for (let i = 0; i < 5; i++) await loginTo(env, undefined, 'boss', 'bad-password');
    expect((await loginTo(env, undefined, 'boss', 'correct-horse-1')).status).toBe(429);
  });
});
