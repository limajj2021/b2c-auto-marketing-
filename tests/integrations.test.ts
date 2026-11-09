import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { credStatus, setCred, withCreds } from '../src/integrations';
import { buildAuthorizeUrl, handleCallback, handleMetaCallback, refreshIfNeeded } from '../src/threads/oauth';
import { decryptText, encryptText } from '../src/util/secrets';
import { hmacBase64, signToken } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());

async function api(env: any, method: string, path: string, body?: unknown, cookie?: string) {
  return handleApi(env, new Request(`https://x.dev${path}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) },
  }));
}
async function loginAs(env: any, u = 'boss', p = 'correct-horse-1') {
  const r = await api(env, 'POST', '/api/login', { username: u, password: p });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

describe('secrets & creds overlay', () => {
  it('round-trips AES-GCM and rejects wrong key', async () => {
    const c = await encryptText('k1', 'hello');
    expect(c).not.toContain('hello');
    expect(await decryptText('k1', c)).toBe('hello');
    await expect(decryptText('k2', c)).rejects.toBeTruthy();
  });

  it('DB credentials override env and are never returned in status', async () => {
    const env = await makeEnv();
    await setCred(env, 'b1', 'gemini_api_key', 'db-key-value');
    expect((await withCreds(env)).GEMINI_API_KEY).toBe('db-key-value');
    const st = await credStatus(env);
    expect(JSON.stringify(st)).not.toContain('db-key-value');
    expect(st.gemini_api_key.source).toBe('db');
  });
});

describe('integration endpoints', () => {
  it('is admin-only', async () => {
    const env = await makeEnv();
    const staff = await loginAs(env, 'cs', 'staff-password-1');
    expect((await api(env, 'GET', '/api/integrations', undefined, staff)).status).toBe(403);
    expect((await api(env, 'GET', '/api/users', undefined, staff)).status).toBe(403);
  });

  it('LINE setup validates token, sets webhook, verifies via LINE test', async () => {
    const env = await makeEnv();
    const admin = await loginAs(env);
    const m = mockFetch((u) => u.endsWith('/bot/info') ? jres({ displayName: 'Bot', basicId: '@x' })
      : u.endsWith('/webhook/test') ? jres({ success: true }) : jres({})); restore = m.restore;
    const r = await api(env, 'POST', '/api/integrations/line', { channel_secret: 'a'.repeat(32), channel_access_token: 't'.repeat(60) }, admin);
    expect(await r.json()).toMatchObject({ ok: true, bot: 'Bot', webhook_set: true, webhook_verified: true });
    expect((await withCreds(env)).LINE_CHANNEL_SECRET).toBe('a'.repeat(32));
    expect(m.calls.find((c) => c.url.endsWith('/webhook/endpoint'))?.init?.body).toContain('https://x.dev/line/webhook');
  });

  it('rejects invalid LINE token without storing', async () => {
    const env = await makeEnv();
    const admin = await loginAs(env);
    const m = mockFetch(() => jres({}, 401)); restore = m.restore;
    expect((await api(env, 'POST', '/api/integrations/line', { channel_secret: 'a'.repeat(32), channel_access_token: 't'.repeat(60) }, admin)).status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM integrations').first<any>()).c).toBe(0);
  });

  it('user management: create staff, cannot disable self, duplicate rejected', async () => {
    const env = await makeEnv();
    const admin = await loginAs(env);
    expect((await api(env, 'POST', '/api/users', { username: 'newcs', password: 'longpassword1', role: 'staff' }, admin)).status).toBe(200);
    expect((await api(env, 'POST', '/api/users', { username: 'newcs', password: 'longpassword1', role: 'staff' }, admin)).status).toBe(409);
    expect((await api(env, 'POST', '/api/users', { username: 'x', password: 'short', role: 'staff' }, admin)).status).toBe(400);
    expect((await api(env, 'PATCH', '/api/users/1', { enabled: false }, admin)).status).toBe(400);
    const ok = await loginAs(env, 'newcs', 'longpassword1');
    expect(ok).toContain('sid=');
    await api(env, 'PATCH', '/api/users/3', { enabled: false }, admin);
    expect(await loginAs(env, 'newcs', 'longpassword1')).toBe('');
  });
});

describe('Threads OAuth', () => {
  it('callback exchanges code, stores encrypted token, rejects bad state', async () => {
    const env = await makeEnv();
    const good = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    const m = mockFetch((u) => u.includes('/oauth/access_token') ? jres({ access_token: 'short' })
      : u.includes('th_exchange_token') ? jres({ access_token: 'LONGTOKEN', expires_in: 5184000 })
      : jres({ id: '999', username: 'vuca' })); restore = m.restore;
    const bad = await handleCallback(env, new Request('https://x.dev/threads/callback?code=c&state=bogus'));
    expect(bad.headers.get('location')).toContain('threads=error');
    expect(m.calls.length).toBe(0);
    const ok = await handleCallback(env, new Request(`https://x.dev/threads/callback?code=abc%23_&state=${encodeURIComponent(good)}`));
    expect(ok.headers.get('location')).toBe('/?threads=connected');
    const e2 = await withCreds(env);
    expect(e2.THREADS_ACCESS_TOKEN).toBe('LONGTOKEN'); expect(e2.THREADS_USER_ID).toBe('999');
    const raw = await env.DB.prepare('SELECT value_enc FROM integrations WHERE name=?').bind('threads_access_token').first<any>();
    expect(raw.value_enc).not.toContain('LONGTOKEN');
  });

  it('refreshes tokens close to expiry but not fresh ones', async () => {
    const env = await makeEnv();
    const now = new Date('2026-11-08T00:00:00Z');
    await setCred(env, 'b1', 'threads_access_token', 'old', { expires_at: '2027-01-01T00:00:00Z' });
    const m = mockFetch(() => jres({ access_token: 'new', expires_in: 5184000 })); restore = m.restore;
    await refreshIfNeeded(await withCreds(env), now);
    expect(m.calls.length).toBe(0);
    await setCred(env, 'b1', 'threads_access_token', 'old', { expires_at: '2026-11-12T00:00:00Z' });
    await refreshIfNeeded(await withCreds(env), now);
    expect(m.calls.length).toBe(1);
    expect((await withCreds(env)).THREADS_ACCESS_TOKEN).toBe('new');
  });

  it('Meta delete callback requires valid signed_request and removes tokens', async () => {
    const env = await makeEnv();
    await setCred(env, 'b1', 'threads_access_token', 'T', {});
    await setCred(env, 'b1', 'threads_user_id', '42', {});
    const e2 = await withCreds(env);
    const payload = btoa(JSON.stringify({ user_id: '42' })).replace(/=+$/, '');
    const sig = (await hmacBase64('appsecret', payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const post = (sr: string) => new Request('https://x.dev/threads/delete', { method: 'POST', body: new URLSearchParams({ signed_request: sr }) });
    expect((await handleMetaCallback(e2, post(`bad.${payload}`), 'delete')).status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM integrations').first<any>()).c).toBe(2);
    const r = await handleMetaCallback(e2, post(`${sig}.${payload}`), 'delete');
    expect(await r.json()).toHaveProperty('confirmation_code');
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM integrations').first<any>()).c).toBe(0);
  });
});
void signToken;
