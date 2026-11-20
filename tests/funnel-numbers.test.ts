// 導流成效的數字要跟首頁一致：曝光用帳號每日瀏覽數；回覆扣掉串文自己接的下一則
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { upsertAccount } from '../src/threads/accounts';
import { makeEnv } from './helpers';

const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));

describe('funnel numbers', () => {
  it('views come from account daily views; replies exclude the thread’s own chained parts', async () => {
    const env: any = await makeEnv();
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO posts(id,brand_id,account_id,content,parts,status,published_at,updated_at,created_at) VALUES(1,'b1',?,'a','["a","b","c","d","e","f","g"]','published',?,'x','x')`).bind(a, now).run();
    await env.DB.prepare(`INSERT INTO post_metrics(post_id,brand_id,views,likes,replies,reposts,quotes,shares,fetched_at) VALUES(1,'b1',40,1,8,0,0,0,'x')`).run();
    await env.DB.prepare(`INSERT INTO account_daily(account_id,brand_id,day,views,fetched_at) VALUES(?,?,?,?,?)`).bind(a, 'b1', today, 1426, now).run();
    const c = ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const f: any = await (await api(env, 'GET', '/api/funnel', undefined, c)).json();
    expect(f.totals.views).toBe(1426); expect(f.totals.post_views).toBe(40);
    expect(f.totals.replies).toBe(2); // 8 則回覆 − 自己接的 6 則
    const posts: any[] = await (await api(env, 'GET', '/api/posts', undefined, c)).json() as any;
    expect((Array.isArray(posts) ? posts : (posts as any).posts).find((p: any) => p.id === 1).replies).toBe(2);
  });
});
