import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { logEvent, pruneLogs, redact } from '../src/log';
import { buildAuthorizeUrl, handleCallback } from '../src/threads/oauth';
import { publishDue } from '../src/threads/scheduler';
import { hashPassword } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
  body: undefined,
}));
const post = (env: any, path: string, body: unknown) => handleApi(env, new Request(`https://x${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui' },
}));
const logs = async (env: any) => (await env.DB.prepare('SELECT * FROM event_logs ORDER BY id').all()).results as any[];

describe('system event logs', () => {
  it('never stores credentials', () => {
    expect(redact('GET https://graph.threads.net/x?access_token=SECRET123&a=1')).not.toContain('SECRET123');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***');
  });

  it('records where a Threads connection failed, with Meta’s error', async () => {
    const env = await makeEnv();
    const state = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    const m = mockFetch(() => jres({ error: { message: 'Invalid redirect_uri' } }, 400)); restore = m.restore;
    const r = await handleCallback(env, new Request(`https://x.dev/threads/callback?code=c&state=${encodeURIComponent(state)}`));
    expect(decodeURIComponent(r.headers.get('location')!)).toContain('Invalid redirect_uri');
    const l = (await logs(env)).at(-1);
    expect(l).toMatchObject({ brand_id: 'b1', level: 'error', source: 'threads_oauth' });
    expect(l.message).toContain('以授權碼換取憑證');
    expect(l.detail).toContain('Invalid redirect_uri');
    expect(l.detail).not.toContain('appsecret');
  });

  it('records a denied authorization and a publish failure', async () => {
    const env = await makeEnv();
    const state = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    await handleCallback(env, new Request(`https://x.dev/threads/callback?error=access_denied&error_reason=user_denied&state=${encodeURIComponent(state)}`));
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','hi','scheduled','2026-11-08T00:00:00Z','auto','x','x')").run();
    const m = mockFetch(() => jres({ error: { message: 'Rate limited', code: 4 } }, 400)); restore = m.restore;
    await publishDue(env, new Date('2026-11-08T01:00:00Z'));
    const l = await logs(env);
    expect(l[0]).toMatchObject({ level: 'warn', source: 'threads_oauth' });
    expect(l[0].detail).toContain('user_denied');
    expect(l.at(-1)).toMatchObject({ level: 'error', source: 'threads_publish' });
    expect(l.at(-1).message).toContain('Rate limited');
  });

  it('throttles noisy events and prunes after 30 days', async () => {
    const env = await makeEnv();
    for (let i = 0; i < 3; i++) await logEvent(env, 'b1', 'warn', 'line_webhook', 'sig', undefined, { throttleMinutes: 30 });
    expect((await logs(env)).length).toBe(1);
    await env.DB.prepare("INSERT INTO event_logs(brand_id,level,source,message,created_at) VALUES('b1','info','cron','old','2020-01-01T00:00:00Z')").run();
    await pruneLogs(env);
    expect((await logs(env)).map((x) => x.message)).toEqual(['sig']);
  });

  it('customers see only their own workspace; operators see all and can filter', async () => {
    const env = await makeEnv();
    env.MULTI_TENANT = '1';
    await env.DB.prepare("INSERT INTO brands(id,slug,name,industry,description,timezone,created_at) VALUES('b2','beta','Beta','general','','Asia/Taipei','x')").run();
    await env.DB.prepare("UPDATE brands SET slug='acme' WHERE id='b1'").run();
    await logEvent(env, 'b1', 'error', 'threads_oauth', 'A 的錯誤');
    await logEvent(env, 'b2', 'info', 'threads_publish', 'B 的紀錄');
    await logEvent(env, null, 'warn', 'cron', '平台警告');
    const tenant = ((await post(env, '/api/login', { workspace: 'acme', username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const mine = (await (await call(env, 'GET', '/api/logs', tenant)).json() as any).rows;
    expect(mine.map((x: any) => x.message)).toEqual(['A 的錯誤']);
    await env.DB.prepare("INSERT INTO operators(username,password_hash,role,created_at) VALUES('sup',?,'support','x')").bind(await hashPassword('operator-pass-1')).run();
    const op = ((await post(env, '/api/op/login', { username: 'sup', password: 'operator-pass-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const all = await (await call(env, 'GET', '/api/op/logs', op)).json() as any;
    expect(all.rows.length).toBe(3);
    expect(all.last24h).toEqual({ error: 1, warn: 1 });
    const errs = await (await call(env, 'GET', '/api/op/logs?level=error', op)).json() as any;
    expect(errs.rows.map((x: any) => x.slug)).toEqual(['acme']);
    const plat = await (await call(env, 'GET', '/api/op/logs?workspace=_platform', op)).json() as any;
    expect(plat.rows.map((x: any) => x.message)).toEqual(['平台警告']);
    expect((await call(env, 'GET', '/api/op/logs', tenant.replace('sid=', 'osid='))).status).toBe(401);
  });
});
