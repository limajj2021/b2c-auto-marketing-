// 立即發布：不等排程，直接在這次請求把草稿或已排程的貼文發到 Threads
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const admin = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const draft = (env: any, parts: string[]) => env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1',?,?,'draft','x','x')`).bind(parts[0], JSON.stringify(parts)).run();
const threads = () => { let n = 0; return mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: `C${n}` })); };

describe('publish now', () => {
  it('approves and publishes a whole draft thread in one go, replies chained', async () => {
    const env: any = await makeEnv(); const c = await admin(env);
    await draft(env, ['p1', 'p2', 'p3']);
    const m = threads(); restore = m.restore;
    const r = await api(env, 'POST', '/api/posts/1/publish-now', {}, c);
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ status: 'published', sent: 3, total: 3 });
    const p: any = await env.DB.prepare('SELECT * FROM posts').first();
    expect(p.status).toBe('published'); expect(p.approved_by).toBeTruthy(); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2', 'T3']);
    const creates = m.calls.filter((x) => x.url.endsWith('/threads')).map((x) => new URLSearchParams(String(x.init?.body)).get('reply_to_id'));
    expect(creates).toEqual([null, 'T1', 'T2']);
    expect((await env.DB.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='post_publish_now'`).first()).n).toBe(1);
  });

  it('refuses content that fails checks, posts already published, and brands without a Threads account', async () => {
    const env: any = await makeEnv(); const c = await admin(env);
    await draft(env, ['鉤子', '有【待補數據：平均金額】的人']);
    expect((await api(env, 'POST', '/api/posts/1/publish-now', {}, c)).status).toBe(422);
    await env.DB.prepare(`UPDATE posts SET status='published' WHERE id=1`).run();
    expect((await api(env, 'POST', '/api/posts/1/publish-now', {}, c)).status).toBe(409);
    const bare: any = await makeEnv(); bare.THREADS_ACCESS_TOKEN = ''; bare.THREADS_USER_ID = '';
    const c2 = await admin(bare); await draft(bare, ['hello']);
    const r = await api(bare, 'POST', '/api/posts/1/publish-now', {}, c2);
    expect(r.status).toBe(409); expect(((await r.json()) as any).error).toContain('手動發到 Threads');
    expect((await bare.DB.prepare('SELECT status FROM posts').first()).status).toBe('draft'); // 沒帳號時不動狀態
  });

  it('reports a Threads error instead of pretending it worked; staff cannot publish', async () => {
    const env: any = await makeEnv(); const c = await admin(env);
    await draft(env, ['hello']);
    const m = mockFetch(() => jres({ error: { code: 1, message: 'Threads is down' } }, 500)); restore = m.restore;
    const r = await api(env, 'POST', '/api/posts/1/publish-now', {}, c);
    expect(r.status).toBe(502); expect(((await r.json()) as any).error).toContain('Threads is down');
    const staff = ((await api(env, 'POST', '/api/login', { username: 'cs', password: 'staff-password-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await api(env, 'POST', '/api/posts/1/publish-now', {}, staff)).status).toBe(403);
  });
});
