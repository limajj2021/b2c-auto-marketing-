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
