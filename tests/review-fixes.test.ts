// 2026-11-12 程式審查修正的回歸測試
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { budgeted } from '../src/budget';
import { handleLineWebhook } from '../src/line/webhook';
import { buildAuthorizeUrl, handleCallback, SCOPES } from '../src/threads/oauth';
import { ensureSlots, runCron } from '../src/threads/scheduler';
import { listAccounts, upsertAccount } from '../src/threads/accounts';
import { runAllTenants } from '../src/tenants';
import { hmacBase64 } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());

const NOW = new Date('2026-11-08T01:00:00Z');
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) =>
  handleApi(env, new Request(`https://x${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
  }));
const login = async (env: any) =>
  ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const gemini = () => jres({ candidates: [{ content: { parts: [{ text: JSON.stringify({ parts: ['鉤子', '內容', '加 LINE'] }) }] } }], usageMetadata: { totalTokenCount: 10 } });

describe('#1 OAuth state is not a login token (and vice versa)', () => {
  it('state from the authorize URL cannot be used as a session cookie', async () => {
    const env = await makeEnv();
    const state = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    expect((await api(env, 'GET', '/api/me', undefined, `sid=${state}`)).status).toBe(401);
  });
  it('a session cookie cannot be used as OAuth state', async () => {
    const env = await makeEnv();
    const sid = (await login(env)).replace('sid=', '');
    const m = mockFetch(() => jres({ access_token: 'x', id: '1' })); restore = m.restore;
    const r = await handleCallback(env, new Request(`https://x.dev/threads/callback?code=c&state=${encodeURIComponent(sid)}`));
    expect(r.headers.get('location')).toContain('threads=error');
    expect(m.calls.length).toBe(0);
  });
});

describe('#7 insights permission is requested', () => {
  it('scope includes threads_manage_insights', () => expect(SCOPES).toContain('threads_manage_insights'));
});

describe('#3 housekeeping runs per workspace, not only at minute 0', () => {
  it('runs on first pass, then waits an hour', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,status,slot_key,updated_at,created_at) VALUES('b1','generating','s','2026-11-08T00:00:00Z','x')").run();
    await runCron(env, new Date('2026-11-08T00:37:00Z')); // 不在整點
    expect((await env.DB.prepare('SELECT status FROM posts').first<any>()).status).toBe('gen_failed');
    expect((await env.DB.prepare('SELECT last_housekeeping_at t FROM brands').first<any>()).t).toBe('2026-11-08T00:37:00.000Z');
  });
});

describe('#4 generation never leaves an orphaned placeholder when the budget is tight', () => {
  it('does not insert a generating row it cannot afford to fill', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET auto_post_enabled=1, posts_per_day=1").run();
    const m = mockFetch(() => gemini()); restore = m.restore;
    const benv = budgeted(env, 12);
    await ensureSlots(benv, NOW).catch(() => {});
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE status='generating'").first<any>()).c).toBe(0);
  });
});

describe('#5/#6 account removal and unschedule', () => {
  it('disconnecting all accounts sends their scheduled posts back to review on the default account', async () => {
    const env = await makeEnv();
    const id = await upsertAccount(env, 'b1', { userId: '9', username: 'a', token: 'T', expiresAt: null });
    await env.DB.prepare("INSERT INTO posts(brand_id,account_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1',?,'hi','scheduled','2026-11-09T00:00:00Z','boss','x','x')").bind(id).run();
    await env.DB.prepare("INSERT INTO posts(brand_id,account_id,status,slot_key,updated_at,created_at) VALUES('b1',?,'gen_failed','k','x','x')").bind(id).run();
    const c = await login(env);
    expect((await api(env, 'DELETE', '/api/integrations/threads', undefined, c)).status).toBe(200);
    expect(await listAccounts(env)).toEqual([]);
    const rows = (await env.DB.prepare('SELECT status,account_id,approved_by FROM posts ORDER BY id').all<any>()).results;
    expect(rows[0]).toEqual({ status: 'draft', account_id: null, approved_by: null });
    expect(rows[1].status).toBe('deleted');
  });

  it('unschedule clears the prepared container and refuses a half-published chain', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,threads_creation_id,updated_at,created_at) VALUES('b1','hi','scheduled','2026-11-09T00:00:00Z','boss','C1','x','x')").run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,part_ids,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','a','["a","b"]','["P1"]','scheduled','2026-11-09T00:00:00Z','boss','x','x')`).run();
    const c = await login(env);
    expect((await api(env, 'POST', '/api/posts/1/unschedule', undefined, c)).status).toBe(200);
    expect((await env.DB.prepare('SELECT status,threads_creation_id c FROM posts WHERE id=1').first<any>())).toEqual({ status: 'draft', c: null });
    const r = await api(env, 'POST', '/api/posts/2/unschedule', undefined, c);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toContain('已經發出前幾則');
  });
});

describe('#8 cron reuses brand/settings within a workspace pass', () => {
  it('a full idle pass stays well under the free-plan request limit', async () => {
    const env = await makeEnv();
    env.MULTI_TENANT = '1';
    let peak = 0;
    const m = mockFetch(() => jres({})); restore = m.restore;
    const orig = env.DB.prepare.bind(env.DB);
    (env.DB as any).prepare = (sql: string) => { peak++; return orig(sql); };
    await runAllTenants(env, new Date('2026-11-08T01:07:00Z')); // 非整點：不含每小時一次的紀錄清理
    expect(peak).toBeLessThanOrEqual(12);
  });
});

describe('#9 operator console validates timezone', () => {
  it('rejects an invalid timezone', async () => {
    const env = await makeEnv();
    env.MULTI_TENANT = '1';
    const { hashPassword } = await import('../src/util/crypto');
    await env.DB.prepare("INSERT INTO operators(username,password_hash,created_at) VALUES('ops',?,'x')").bind(await hashPassword('operator-pass-1')).run();
    const call = (method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
    }));
    const op = ((await call('POST', '/api/op/login', { username: 'ops', password: 'operator-pass-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await call('POST', '/api/op/tenants', { slug: 'zz', name: 'Z', timezone: 'Mars/Base' }, op)).status).toBe(400);
  });
});

describe('#10 LINE: a failed reply after state was saved is not redelivered', () => {
  it('returns 200 and keeps the dedup claim so the message is not processed twice', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({ message: 'down' }, 500)); restore = m.restore;
    const body = JSON.stringify({ events: [{ type: 'message', webhookEventId: 'E1', replyToken: 'r', source: { userId: 'U1' }, message: { type: 'text', text: '你好' } }] });
    const send = async () => handleLineWebhook(env, new Request('https://x/line/webhook', { method: 'POST', body, headers: { 'x-line-signature': await hmacBase64(env.LINE_CHANNEL_SECRET, body) } }));
    expect((await send()).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM processed_events WHERE external_event_id='E1'").first<any>()).c).toBe(1);
  });
});
