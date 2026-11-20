// 一位客戶多個品牌：同一組登入帳號，在自己的品牌之間切換；每個品牌的資料互相獨立
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { hashPassword, signToken } from '../src/util/crypto';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const ck = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];
const json = async (r: Response) => (await r.json()) as any;

async function setup() {
  const env: any = await makeEnv();
  env.MULTI_TENANT = '1';
  await env.DB.prepare("UPDATE brands SET name='品牌甲' WHERE id='b1'").run();
  await env.DB.prepare("INSERT INTO operators(username,password_hash,role,created_at) VALUES('ops',?,'admin','x')").bind(await hashPassword('operator-pass-1')).run();
  const op = ck(await call(env, 'POST', '/api/op/login', { username: 'ops', password: 'operator-pass-1' }));
  return { env, op };
}
const login = async (env: any, u = 'boss', p = 'correct-horse-1') => { const r = await call(env, 'POST', '/api/login', { username: u, password: p }); return { status: r.status, cookie: ck(r) }; };

describe('multiple brands for one customer', () => {
  it('operator adds a brand that shares the customer’s login (no new account or password), and the customer can switch', async () => {
    const { env, op } = await setup();
    const made = await json(await call(env, 'POST', '/api/op/tenants', { name: '品牌乙', share_with: 'BOSS' }, op));
    expect(made).toMatchObject({ name: '品牌乙', shared_with: 'boss' }); expect(made.password).toBeUndefined();
    expect((await call(env, 'POST', '/api/op/tenants', { name: 'X', share_with: 'nobody' }, op)).status).toBe(404);
    const c = (await login(env)).cookie;
    expect(await json(await call(env, 'GET', '/api/me', undefined, c))).toMatchObject({ brandId: 'b1', brands: 2, brand_name: '品牌甲' });
    const list = await json(await call(env, 'GET', '/api/brands', undefined, c));
    expect(list.current).toBe('b1'); expect(list.brands.map((b: any) => b.name)).toEqual(['品牌甲', '品牌乙']);
    const sw = await call(env, 'POST', '/api/brand/switch', { brand_id: made.slug }, c);
    expect(sw.status).toBe(200);
    const c2 = ck(sw);
    expect(await json(await call(env, 'GET', '/api/me', undefined, c2))).toMatchObject({ brandId: made.slug, brand_name: '品牌乙' });
    expect((await json(await call(env, 'GET', '/api/settings', undefined, c2))).brand.name).toBe('品牌乙');
  });

  it('data stays separate between brands, and a brand the user has no access to is refused', async () => {
    const { env, op } = await setup();
    const b = await json(await call(env, 'POST', '/api/op/tenants', { name: '品牌乙', share_with: 'boss' }, op));
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES('b1','甲的草稿','draft','x','x')").run();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES(?,'乙的草稿','draft','x','x')").bind(b.slug).run();
    const a = (await login(env)).cookie;
    expect((await json(await call(env, 'GET', '/api/posts', undefined, a))).map((p: any) => p.content)).toEqual(['甲的草稿']);
    const c2 = ck(await call(env, 'POST', '/api/brand/switch', { brand_id: b.slug }, a));
    expect((await json(await call(env, 'GET', '/api/posts', undefined, c2))).map((p: any) => p.content)).toEqual(['乙的草稿']);
    expect((await call(env, 'PUT', '/api/posts/1', { parts: ['改別人的'] }, c2)).status).toBe(409); // 品牌乙不能改品牌甲的貼文
    // 清單顯示各品牌待審核數
    expect((await json(await call(env, 'GET', '/api/brands', undefined, a))).brands.map((x: any) => x.drafts)).toEqual([1, 1]);
    // 沒有權限的品牌：另一位客戶的品牌
    await env.DB.prepare("INSERT INTO brands(id,slug,name,industry,description,timezone,created_at) VALUES('other','other','別人家','general','','Asia/Taipei','x')").run();
    expect((await call(env, 'POST', '/api/brand/switch', { brand_id: 'other' }, a)).status).toBe(403);
    expect((await call(env, 'POST', '/api/brand/switch', { brand_id: 'nope' }, a)).status).toBe(403);
    // 就算 token 有正確簽章，指定沒有權限的品牌也沒用：每次請求都會重新檢查存取清單
    const forged = `sid=${await signToken(env.SESSION_SECRET, { uid: 1, b: 'other', exp: Math.floor(Date.now() / 1000) + 600 })}`;
    expect((await json(await call(env, 'GET', '/api/me', undefined, forged))).brandId).toBe('b1');
    expect(await json(await call(env, 'GET', '/api/posts', undefined, forged))).toMatchObject([{ content: '甲的草稿' }]);
  });

  it('revoking access takes effect immediately; the session falls back to the primary brand', async () => {
    const { env, op } = await setup();
    const b = await json(await call(env, 'POST', '/api/op/tenants', { name: '品牌乙', share_with: 'boss' }, op));
    const c2 = ck(await call(env, 'POST', '/api/brand/switch', { brand_id: b.slug }, (await login(env)).cookie));
    expect((await json(await call(env, 'GET', '/api/me', undefined, c2))).brandId).toBe(b.slug);
    const access = await json(await call(env, 'GET', `/api/op/tenants/${b.slug}/access`, undefined, op));
    expect(access).toMatchObject([{ username: 'boss', owner: 0 }]);
    expect((await call(env, 'DELETE', `/api/op/tenants/${b.slug}/access/${access[0].id}`, undefined, op)).status).toBe(200);
    expect((await json(await call(env, 'GET', '/api/me', undefined, c2))).brandId).toBe('b1');   // 立即退回主要品牌
    expect((await json(await call(env, 'GET', '/api/brands', undefined, c2))).brands.length).toBe(1);
    expect((await login(env)).status).toBe(200);
  });

  it('remembers the last brand at next login, with a per-brand role', async () => {
    const { env, op } = await setup();
    const b = await json(await call(env, 'POST', '/api/op/tenants', { name: '品牌乙', admin_username: 'yi-admin' }, op));
    // 讓客服帳號 cs 以「客服」身分加入品牌乙
    expect((await call(env, 'POST', `/api/op/tenants/${b.slug}/access`, { username: 'cs', role: 'staff' }, op)).status).toBe(200);
    expect((await call(env, 'POST', `/api/op/tenants/${b.slug}/access`, { username: 'yi-admin' }, op)).status).toBe(409); // 本來就屬於品牌乙
    const cs = (await login(env, 'cs', 'staff-password-1')).cookie;
    const c2 = ck(await call(env, 'POST', '/api/brand/switch', { brand_id: b.slug }, cs));
    expect((await json(await call(env, 'GET', '/api/me', undefined, c2))).role).toBe('staff');
    expect((await call(env, 'GET', '/api/settings', undefined, c2)).status).toBe(403); // 客服不能改設定
    // 下次登入直接回到上次用的品牌
    expect((await json(await call(env, 'GET', '/api/me', undefined, (await login(env, 'cs', 'staff-password-1')).cookie))).brandId).toBe(b.slug);
    // 品牌甲的管理員看得到共用帳號，但不能停用或改密碼
    const users = await json(await call(env, 'GET', '/api/users', undefined, (await login(env)).cookie));
    expect(users.filter((u: any) => u.shared).length).toBe(0);
    const yi = await json(await call(env, 'GET', '/api/users', undefined, ck(await call(env, 'POST', '/api/login', { username: 'yi-admin', password: made(b) }))));
    expect(yi.some((u: any) => u.username === 'cs' && u.shared === 1 && u.role === 'staff')).toBe(true);
  });

  it('a suspended brand cannot be entered, login skips it, and the user can still switch away from it', async () => {
    const { env, op } = await setup();
    const b = await json(await call(env, 'POST', '/api/op/tenants', { name: '品牌乙', share_with: 'boss' }, op));
    const c2 = ck(await call(env, 'POST', '/api/brand/switch', { brand_id: b.slug }, (await login(env)).cookie));
    await call(env, 'PATCH', `/api/op/tenants/${b.slug}`, { status: 'suspended' }, op);
    expect((await call(env, 'GET', '/api/posts', undefined, c2)).status).toBe(403);                // 目前品牌被暫停
    expect((await call(env, 'GET', '/api/brands', undefined, c2)).status).toBe(200);               // 但還能看清單
    expect((await call(env, 'POST', '/api/brand/switch', { brand_id: b.slug }, c2)).status).toBe(403);
    expect((await call(env, 'POST', '/api/brand/switch', { brand_id: 'b1' }, c2)).status).toBe(200); // 切回可用的品牌
    expect((await json(await call(env, 'GET', '/api/me', undefined, (await login(env)).cookie))).brandId).toBe('b1'); // 登入略過被暫停的
  });
});

// 品牌乙建立時回傳的一次性密碼
function made(b: any) { return b.password; }
