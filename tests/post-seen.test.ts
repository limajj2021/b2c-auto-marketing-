// 新文章標示：還沒有人點開過的貼文 seen_at 是空的（後台顯示紅色 NEW），點開後記下時間
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));

describe('NEW badge for unseen posts', () => {
  it('new posts start unseen; opening one marks it seen; posts of another brand cannot be touched', async () => {
    const env: any = await makeEnv();
    const login = await handleApi(env, new Request('https://x.dev/api/login', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'correct-horse-1' }), headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui' } }));
    const c = (login.headers.get('set-cookie') ?? '').split(';')[0];
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1','新的','["新的"]','draft','x','x')`).run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b2','別人的','["別人的"]','draft','x','x')`).run();
    let list = (await (await call(env, 'GET', '/api/posts', c)).json()) as any[];
    expect(list.find((p) => p.id === 1).seen_at).toBeNull();
    expect((await call(env, 'POST', '/api/posts/1/seen', c)).status).toBe(200);
    list = (await (await call(env, 'GET', '/api/posts', c)).json()) as any[];
    expect(list.find((p) => p.id === 1).seen_at).toBeTruthy();
    await call(env, 'POST', '/api/posts/2/seen', c);
    expect(((await env.DB.prepare('SELECT seen_at FROM posts WHERE id=2').first()) as any).seen_at).toBeNull();
  });
});
