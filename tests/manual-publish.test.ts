// 手動發布（Threads Web Intent）：不需要授權，但合規檢查、追蹤短連結與防重複都照常
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { publishDue, refreshInsights } from '../src/threads/scheduler';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any) => ((await handleApi(env, new Request('https://x/api/login', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'correct-horse-1' }),
  headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui' } }))).headers.get('set-cookie') ?? '').split(';')[0];
const LINE = 'https://line.me/R/ti/p/@test';
const NOW = new Date('2026-11-08T01:00:00Z');

describe('manual publish without Threads authorization', () => {
  it('returns the parts with tracked short links, and marking it done publishes it exactly once', async () => {
    const env: any = await makeEnv(); env.PUBLIC_BASE_URL = 'https://app.dev';
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1','h',?,'draft','x','x')`).bind(JSON.stringify(['鉤子', `結尾 ${LINE}`])).run();
    const c = await login(env);
    const r = (await (await call(env, 'GET', '/api/posts/1/manual', c)).json()) as any;
    expect(r.parts[0]).toBe('鉤子');
    expect(r.parts[1]).toMatch(/^結尾 https:\/\/app\.dev\/go\/\w+$/); expect(r.parts[1]).not.toContain(LINE);
    const again = (await (await call(env, 'GET', '/api/posts/1/manual', c)).json()) as any;
    expect(again.parts[1]).toBe(r.parts[1]);                       // 重複開啟沿用同一個短連結，統計不會分裂
    expect((await call(env, 'POST', '/api/posts/1/manual-done', c)).status).toBe(200);
    const p: any = await env.DB.prepare('SELECT status,approved_by,published_at,threads_post_id FROM posts').first();
    expect(p).toMatchObject({ status: 'published', approved_by: 'boss', threads_post_id: null }); expect(p.published_at).toBeTruthy();
    expect((await call(env, 'POST', '/api/posts/1/manual-done', c)).status).toBe(409);   // 不能重複標記
    expect((await call(env, 'GET', '/api/posts/1/manual', c)).status).toBe(409);
    // 之後不會被排程再發一次，也不會拿去查成效（沒有 Threads 的貼文編號）
    const m = mockFetch(() => jres({ id: 'x' })); restore = m.restore;
    await publishDue(env, NOW); await refreshInsights(env, NOW);
    expect(m.calls.length).toBe(0);
  });

  it('applies the same compliance checks as approval (regulated industry numbers, placeholders)', async () => {
    const env: any = await makeEnv({ industry: 'lending' });
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1','x',?,'draft','x','x')`).bind(JSON.stringify(['保證核貸，年利率 1.5%'])).run();
    const c = await login(env);
    expect((await call(env, 'GET', '/api/posts/1/manual', c)).status).toBe(422);
  });

  it('only works on posts that are not yet published, and only within the own workspace', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES('b1','a','publishing','x','x')`).run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','b','scheduled','2026-11-09T00:00:00Z','boss','x','x')`).run();
    await env.DB.prepare("INSERT INTO brands(id,name,industry,description,timezone,created_at) VALUES('b9','其他','general','','Asia/Taipei','x')").run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES('b9','別人的','draft','x','x')`).run();
    const c = await login(env);
    expect((await call(env, 'POST', '/api/posts/1/manual-done', c)).status).toBe(409); // 正在自動發布中，避免重複
    expect((await call(env, 'POST', '/api/posts/3/manual-done', c)).status).toBe(409); // 別的工作區
    expect((await call(env, 'GET', '/api/posts/3/manual', c)).status).toBe(409);
    expect((await call(env, 'POST', '/api/posts/2/manual-done', c)).status).toBe(200);  // 已排程的也可以改成手動發
    await publishDue(env, new Date('2026-11-10T00:00:00Z'));                           // 到時間也不會再自動發
    expect(((await env.DB.prepare("SELECT status FROM posts WHERE id=2").first()) as any).status).toBe('published');
  });
});
