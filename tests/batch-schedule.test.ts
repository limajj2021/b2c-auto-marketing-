// 批量排程（多帳號共用貼文池）：輪流分配或每個帳號都發，依間隔排時間；內容檢查不過的跳過
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any, u = 'boss', p = 'correct-horse-1') => ((await call(env, 'POST', '/api/login', { username: u, password: p })).headers.get('set-cookie') ?? '').split(';')[0];

async function setup() {
  const env: any = await makeEnv();
  for (const [id, u, st] of [[11, 'a.tw', 'ok'], [12, 'b.tw', 'ok'], [13, 'dead.tw', 'token_invalid']] as const)
    await env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,status,created_at,updated_at) VALUES(?,'b1',?,?,'x',?,'x','x')`).bind(id, 'u' + id, u, st).run();
  for (const t of ['一', '二', '三', '四']) await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1',?,?,'draft','x','x')`).bind(t, JSON.stringify([t])).run();
  return { env, c: await login(env) };
}
const rows = async (env: any) => (await env.DB.prepare(`SELECT id,source_post_id,account_id,status,scheduled_at,approved_by,content FROM posts ORDER BY id`).all()).results as any[];

describe('batch scheduling from the shared pool', () => {
  it('assign: each post once, round-robin across accounts, spaced by the interval', async () => {
    const { env, c } = await setup();
    const start = new Date(Date.now() + 3600000).toISOString();
    const r = (await (await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [1, 2, 3, 4], account_ids: [11, 12], mode: 'assign', start_at: start, interval_min: 30 }, c)).json()) as any;
    expect(r.scheduled).toBe(4); expect(r.per_account).toEqual({ '@a.tw': 2, '@b.tw': 2 });
    const rs = await rows(env);
    expect(rs.map((x) => x.account_id)).toEqual([11, 12, 11, 12]);
    expect(rs.every((x) => x.status === 'scheduled' && x.approved_by === 'boss')).toBe(true);
    const t = rs.map((x) => Date.parse(x.scheduled_at));
    expect(t[1] - t[0]).toBe(30 * 60000); expect(t[3] - t[0]).toBe(90 * 60000); expect(new Date(t[0]).toISOString()).toBe(new Date(start).toISOString());
  });

  it('copy: every selected account gets the post; interval 0 schedules them all at the same time', async () => {
    const { env, c } = await setup();
    const r = (await (await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [1, 2], account_ids: [11, 12], mode: 'copy', interval_min: 0 }, c)).json()) as any;
    expect(r.scheduled).toBe(4);
    const rs = (await rows(env)).filter((x) => x.status === 'scheduled');
    expect(rs.map((x) => [x.content, x.account_id, x.source_post_id])).toEqual([['一', 11, null], ['二', 11, null], ['一', 12, 1], ['二', 12, 2]]);
    expect(new Set(rs.map((x) => x.scheduled_at)).size).toBe(1);
  });

  it('skips drafts that fail checks or are not drafts, ignores broken or foreign accounts, and staff cannot do it', async () => {
    const { env, c } = await setup();
    await env.DB.prepare(`UPDATE posts SET parts='["有【待補數據：金額】"]',content='有【待補數據：金額】' WHERE id=2`).run();
    await env.DB.prepare(`UPDATE posts SET status='published' WHERE id=3`).run();
    const r = (await (await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [1, 2, 3], account_ids: [11, 13, 999], mode: 'assign', interval_min: 15 }, c)).json()) as any;
    expect(r.scheduled).toBe(1); expect(r.per_account).toEqual({ '@a.tw': 1 });
    expect(r.skipped.map((x: any) => x.id)).toEqual([2, 3]);
    expect((await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [4], account_ids: [13], mode: 'assign' }, c)).status).toBe(400);
    expect((await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [4], account_ids: [11], start_at: '2020-01-01T00:00:00Z' }, c)).status).toBe(400);
    const staff = await login(env, 'cs', 'staff-password-1');
    expect((await call(env, 'POST', '/api/posts/batch-schedule', { post_ids: [4], account_ids: [11] }, staff)).status).toBe(403);
  });
});
