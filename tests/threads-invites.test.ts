// Threads 連結流程：觸發（客戶提出）→ 同意（客戶接受邀請）→ 授權
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { listAccounts } from '../src/threads/accounts';
import { buildAuthorizeUrl, handleCallback } from '../src/threads/oauth';
import { hashPassword } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const ck = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const customer = async (env: any) => ck(await call(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' }));
const operator = async (env: any, role: 'admin' | 'support') => {
  await env.DB.prepare('INSERT INTO operators(username,password_hash,role,created_at) VALUES(?,?,?,?)').bind(`op-${role}`, await hashPassword('operator-pass-1'), role, 'x').run();
  return ck(await call(env, 'POST', '/api/op/login', { username: `op-${role}`, password: 'operator-pass-1' }));
};
const invites = async (env: any, c: string) => ((await (await call(env, 'GET', '/api/integrations', undefined, c)).json()) as any).threads;

describe('three-step Threads connection', () => {
  it('request → operator sends invite → customer accepts → authorize; each step is enforced in order', async () => {
    const env: any = await makeEnv();
    env.THREADS_APP_ID = 'app'; env.THREADS_APP_SECRET = 's';
    const c = await customer(env);
    // 1 觸發
    expect((await call(env, 'POST', '/api/threads/invites', { username: 'not valid!' }, c)).status).toBe(400);
    const made = (await (await call(env, 'POST', '/api/threads/invites', { username: '@Acme.Shop' }, c)).json()) as any;
    expect(made).toMatchObject({ status: 'requested', username: 'acme.shop' });
    expect(((await (await call(env, 'POST', '/api/threads/invites', { username: 'https://www.threads.com/@acme.shop' }, c)).json()) as any).id).toBe(made.id); // 重複申請不會新增
    expect((await invites(env, c))).toMatchObject({ requires_invite: true, invites: [{ username: 'acme.shop', status: 'requested' }] });
    // 還沒送出邀請：不能說已接受，也不能授權
    expect((await call(env, 'POST', `/api/threads/invites/${made.id}/accepted`, undefined, c)).status).toBe(409);
    expect((await call(env, 'GET', `/api/integrations/threads/connect?invite=${made.id}`, undefined, c)).status).toBe(409);
    // 營運人員（維護人員也可以）送出邀請後標記
    const sup = await operator(env, 'support');
    const list = (await (await call(env, 'GET', '/api/op/invites', undefined, sup)).json()) as any;
    expect(list.rows).toMatchObject([{ id: made.id, username: 'acme.shop', status: 'requested' }]);
    expect((await call(env, 'PATCH', `/api/op/invites/${made.id}`, { status: 'bogus' }, sup)).status).toBe(400);
    expect((await call(env, 'PATCH', `/api/op/invites/${made.id}`, { status: 'invited' }, sup)).status).toBe(200);
    // 2 同意
    expect((await invites(env, c)).invites[0].status).toBe('invited');
    expect((await call(env, 'GET', `/api/integrations/threads/connect?invite=${made.id}`, undefined, c)).status).toBe(409); // 還沒接受
    expect((await call(env, 'POST', `/api/threads/invites/${made.id}/accepted`, undefined, c)).status).toBe(200);
    // 3 授權
    const r = await call(env, 'GET', `/api/integrations/threads/connect?invite=${made.id}`, undefined, c);
    expect(r.status).toBe(200); expect(((await r.json()) as any).url).toContain('threads.net/oauth/authorize');
    expect((await invites(env, c)).invites[0].authorize_started_at).toBeTruthy();
    // 授權成功 → 邀請標為已連結，不再出現在進行中清單
    const state = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    const m = mockFetch((u) => u.includes('/oauth/access_token') ? jres({ access_token: 's' }) : u.includes('th_exchange_token') ? jres({ access_token: 'L', expires_in: 5184000 }) : jres({ id: '7', username: 'Acme.Shop' }));
    restore = m.restore;
    expect((await handleCallback(env, new Request(`https://x.dev/threads/callback?code=c&state=${encodeURIComponent(state)}`))).headers.get('location')).toBe('/?threads=connected');
    expect((await listAccounts(env)).map((a) => a.username)).toEqual(['Acme.Shop']);
    expect((await invites(env, c)).invites).toEqual([]);
    expect(((await env.DB.prepare('SELECT status FROM threads_invites').first()) as any).status).toBe('connected');
    expect((await call(env, 'POST', '/api/threads/invites', { username: 'acme.shop' }, c)).status).toBe(409); // 已連結的帳號不必再申請
  });

  it('operator can mark an existing tester as accepted, or cancel; other workspaces cannot touch the request', async () => {
    const env: any = await makeEnv();
    const c = await customer(env);
    const a = (await (await call(env, 'POST', '/api/threads/invites', { username: 'tester1' }, c)).json()) as any;
    const b = (await (await call(env, 'POST', '/api/threads/invites', { username: 'tester2' }, c)).json()) as any;
    const op = await operator(env, 'admin');
    expect((await call(env, 'PATCH', `/api/op/invites/${a.id}`, { status: 'accepted' }, op)).status).toBe(200); // 對方早就是測試人員
    expect((await call(env, 'PATCH', `/api/op/invites/${a.id}`, { status: 'invited' }, op)).status).toBe(409);   // 已處理過
    expect((await call(env, 'PATCH', `/api/op/invites/${b.id}`, { status: 'cancelled' }, op)).status).toBe(200);
    expect(((await (await call(env, 'GET', '/api/op/invites', undefined, op)).json()) as any).rows).toEqual([]);
    expect((await invites(env, c)).invites.map((i: any) => i.status)).toEqual(['accepted']);
    // 另一個工作區的管理員不能代為接受或取消
    await env.DB.prepare("INSERT INTO brands(id,slug,name,industry,description,timezone,created_at) VALUES('b2','beta','Beta','general','','Asia/Taipei','x')").run();
    await env.DB.prepare("INSERT INTO brand_settings(brand_id,updated_at) VALUES('b2','x')").run();
    await env.DB.prepare("INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES('b2','admin','beta-boss',?)").bind(await hashPassword('beta-password-1')).run();
    const c2 = ck(await call(env, 'POST', '/api/login', { username: 'beta-boss', password: 'beta-password-1' }));
    expect((await call(env, 'GET', `/api/integrations/threads/connect?invite=${a.id}`, undefined, c2)).status).toBe(404);
    await call(env, 'DELETE', `/api/threads/invites/${a.id}`, undefined, c2);
    expect((await invites(env, c)).invites.length).toBe(1);
    // 客戶自己可以取消
    await call(env, 'DELETE', `/api/threads/invites/${a.id}`, undefined, c);
    expect((await invites(env, c)).invites).toEqual([]);
  });

  it('once the Meta app is live (no invites needed), authorization is allowed straight away', async () => {
    const env: any = await makeEnv();
    env.THREADS_APP_ID = 'app'; env.THREADS_APP_SECRET = 's'; env.THREADS_APP_MODE = 'live';
    const c = await customer(env);
    expect((await invites(env, c)).requires_invite).toBe(false);
    const made = (await (await call(env, 'POST', '/api/threads/invites', { username: 'newcomer' }, c)).json()) as any;
    expect((await call(env, 'GET', `/api/integrations/threads/connect?invite=${made.id}`, undefined, c)).status).toBe(200);
  });
});
