import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { makeEnv } from './helpers';

async function api(env: any, method: string, path: string, body?: unknown, cookie?: string) {
  return handleApi(env, new Request(`https://x${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
  }));
}
async function login(env: any, u: string, p: string) {
  const r = await api(env, 'POST', '/api/login', { username: u, password: p });
  return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}

describe('admin auth & roles', () => {
  it('rejects anonymous and wrong password', async () => {
    const env = await makeEnv();
    expect((await api(env, 'GET', '/api/dashboard')).status).toBe(401);
    expect((await login(env, 'boss', 'nope')).r.status).toBe(401);
  });

  it('locks out after repeated failures', async () => {
    const env = await makeEnv();
    for (let i = 0; i < 5; i++) await login(env, 'boss', 'bad');
    expect((await login(env, 'boss', 'correct-horse-1')).r.status).toBe(429);
  });

  it('staff cannot reach settings/posts, can handle inquiries but not see LINE user id', async () => {
    const env = await makeEnv();
    const staff = (await login(env, 'cs', 'staff-password-1')).cookie;
    expect((await api(env, 'GET', '/api/settings', undefined, staff)).status).toBe(403);
    expect((await api(env, 'GET', '/api/posts', undefined, staff)).status).toBe(403);
    await env.DB.prepare("INSERT INTO contacts(brand_id,line_user_id,created_at) VALUES('b1','Uxyz','x')").run();
    await env.DB.prepare("INSERT INTO inquiries(brand_id,contact_id,flow_id,answers,created_at) VALUES('b1',1,'f1','{}','2026-11-08T00:00:00Z')").run();
    const list: any[] = await (await api(env, 'GET', '/api/inquiries', undefined, staff)).json();
    expect(list.length).toBe(1); expect(list[0].line_user_id).toBeUndefined();
    expect((await api(env, 'PATCH', '/api/inquiries/1', { handling_status: 'done' }, staff)).status).toBe(200);
    const admin = (await login(env, 'boss', 'correct-horse-1')).cookie;
    const l2: any[] = await (await api(env, 'GET', '/api/inquiries?status=done', undefined, admin)).json();
    expect(l2[0].line_user_id).toBe('Uxyz');
  });

  it('requires CSRF header on mutations, validates settings, writes audit log', async () => {
    const env = await makeEnv();
    const admin = (await login(env, 'boss', 'correct-horse-1')).cookie;
    const noHdr = await handleApi(env, new Request('https://x/api/settings', { method: 'PUT', body: '{}', headers: { cookie: admin } }));
    expect(noHdr.status).toBe(403);
    expect((await api(env, 'PUT', '/api/settings', { posts_per_day: 9 }, admin)).status).toBe(400);
    expect((await api(env, 'PUT', '/api/settings', { posting_mode: 'C', posts_per_day: 3, weekly_topic: '本週主題' }, admin)).status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='settings_update'").first<any>()).c).toBe(1);
  });

  it('cannot approve a non-compliant draft', async () => {
    const env = await makeEnv();
    const admin = (await login(env, 'boss', 'correct-horse-1')).cookie;
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,updated_at,created_at) VALUES('b1','保證核貸','draft','x','x')").run();
    expect((await api(env, 'POST', '/api/posts/1/approve', {}, admin)).status).toBe(422);
    await api(env, 'PUT', '/api/posts/1', { content: '歡迎諮詢' }, admin);
    expect((await api(env, 'POST', '/api/posts/1/approve', {}, admin)).status).toBe(200);
    expect((await env.DB.prepare('SELECT status,approved_by FROM posts').first<any>())).toMatchObject({ status: 'scheduled', approved_by: 'boss' });
  });
});

describe('foolproof guards', () => {
  it('refuses to enable auto-post / auto-reply without required connections', async () => {
    const env = await makeEnv();
    const admin = (await login(env, 'boss', 'correct-horse-1')).cookie;
    const noThreads = { ...env, THREADS_ACCESS_TOKEN: '', GEMINI_API_KEY: '', LINE_CHANNEL_SECRET: '' } as any;
    const r = await api(noThreads, 'POST', '/api/pause', { auto_post_enabled: true }, admin);
    expect(r.status).toBe(409);
    expect((await r.json() as any).error).toContain('Gemini');
    expect((await api(noThreads, 'POST', '/api/pause', { line_auto_reply_enabled: true }, admin)).status).toBe(409);
    // turning things OFF is always allowed
    expect((await api(noThreads, 'POST', '/api/pause', { auto_post_enabled: false }, admin)).status).toBe(200);
    // with connections present it succeeds
    expect((await api(env, 'POST', '/api/pause', { auto_post_enabled: true }, admin)).status).toBe(200);
  });

  it('refuses auto-post when Threads authorization is flagged invalid', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET threads_status='token_invalid'").run();
    const admin = (await login(env, 'boss', 'correct-horse-1')).cookie;
    expect((await api(env, 'POST', '/api/pause', { auto_post_enabled: true }, admin)).status).toBe(409);
  });
});

describe('scheduling controls', () => {
  it('cancelling a schedule returns the post to review; reschedule validates time', async () => {
    const env = await makeEnv();
    const c = (await login(env, 'boss', 'correct-horse-1')).cookie;
    const future = new Date(Date.now() + 3 * 3600000).toISOString();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','歡迎諮詢','scheduled',?,'boss','x','x')`).bind(future).run();
    const later = new Date(Date.now() + 26 * 3600000).toISOString();
    const r = await api(env, 'PUT', '/api/posts/1/schedule', { scheduled_at: later }, c);
    expect(r.status).toBe(200);
    expect(((await env.DB.prepare('SELECT scheduled_at FROM posts').first()) as any).scheduled_at).toBe(later);
    expect((await api(env, 'PUT', '/api/posts/1/schedule', { scheduled_at: '2020-01-01T00:00:00Z' }, c)).status).toBe(400);
    expect((await api(env, 'PUT', '/api/posts/1/schedule', { scheduled_at: new Date(Date.now() + 100 * 86400000).toISOString() }, c)).status).toBe(400);
    expect((await api(env, 'POST', '/api/posts/1/unschedule', {}, c)).status).toBe(200);
    expect(await env.DB.prepare('SELECT status,approved_by,scheduled_at FROM posts').first()).toEqual({ status: 'draft', approved_by: null, scheduled_at: later });
    // 退回後可以用指定時間重新核准；過去的時間會被拒絕
    expect((await api(env, 'POST', '/api/posts/1/approve', { scheduled_at: '2020-01-01T00:00:00Z' }, c)).status).toBe(400);
    expect((await api(env, 'POST', '/api/posts/1/approve', { scheduled_at: later }, c)).status).toBe(200);
    await env.DB.prepare("UPDATE posts SET status='published'").run();
    expect((await api(env, 'POST', '/api/posts/1/unschedule', {}, c)).status).toBe(409);
    expect((await api(env, 'PUT', '/api/posts/1/schedule', { scheduled_at: later }, c)).status).toBe(409);
  });
});
