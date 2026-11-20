import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { credStatus, setCred, withCreds } from '../src/integrations';
import { buildAuthorizeUrl, handleCallback, handleMetaCallback, refreshIfNeeded } from '../src/threads/oauth';
import { credFor, listAccounts, upsertAccount } from '../src/threads/accounts';
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

describe('Threads OAuth (matrix accounts)', () => {
  it('callback adds an account (encrypted), a second login adds another, bad state rejected', async () => {
    const env = await makeEnv();
    const good = new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('state')!;
    let n = 0;
    const m = mockFetch((u) => u.includes('/oauth/access_token') ? jres({ access_token: 'short' })
      : u.includes('th_exchange_token') ? jres({ access_token: `LONG${n}`, expires_in: 5184000 })
      : jres({ id: `99${n}`, username: `acct${n}` })); restore = m.restore;
    const bad = await handleCallback(env, new Request('https://x.dev/threads/callback?code=c&state=bogus'));
    expect(bad.headers.get('location')).toContain('threads=error');
    expect(m.calls.length).toBe(0);
    expect((await handleCallback(env, new Request(`https://x.dev/threads/callback?code=abc%23_&state=${encodeURIComponent(good)}`))).headers.get('location')).toBe('/?threads=connected');
    n = 1;
    await handleCallback(env, new Request(`https://x.dev/threads/callback?code=def&state=${encodeURIComponent(good)}`));
    const accts = await listAccounts(env);
    expect(accts.map((a) => a.username)).toEqual(['acct0', 'acct1']);
    expect(accts[0].token_enc).not.toContain('LONG0');
    expect((await credFor(env, accts[1])).token).toBe('LONG1');
    expect(new URL(await buildAuthorizeUrl(env, 'https://x.dev', 1)).searchParams.get('scope')).toContain('threads_manage_replies');
  });

  it('migrates a legacy single-account credential into threads_accounts once', async () => {
    const env = await makeEnv();
    await setCred(env, 'b1', 'threads_access_token', 'OLD', { username: 'legacy', expires_at: '2027-01-01T00:00:00Z' });
    await setCred(env, 'b1', 'threads_user_id', '555', { username: 'legacy' });
    const a = await listAccounts(env); await listAccounts(env);
    expect(a.length).toBe(1); expect(a[0].username).toBe('legacy');
    expect((await credFor(env, a[0])).token).toBe('OLD');
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM integrations').first<any>()).c).toBe(0);
  });

  it('refreshes only accounts close to expiry', async () => {
    const env = await makeEnv();
    const now = new Date('2026-11-08T00:00:00Z');
    await upsertAccount(env, 'b1', { userId: '1', username: 'fresh', token: 'f', expiresAt: '2027-01-01T00:00:00Z' });
    await upsertAccount(env, 'b1', { userId: '2', username: 'old', token: 'o', expiresAt: '2026-11-12T00:00:00Z' });
    const m = mockFetch(() => jres({ access_token: 'new', expires_in: 5184000 })); restore = m.restore;
    await refreshIfNeeded(env, now);
    expect(m.calls.length).toBe(1);
    const a = await listAccounts(env);
    expect((await credFor(env, a[1])).token).toBe('new'); expect((await credFor(env, a[0])).token).toBe('f');
  });

  it('Meta delete callback requires valid signed_request and removes only that account', async () => {
    const env = await makeEnv();
    await upsertAccount(env, 'b1', { userId: '42', username: 'gone', token: 'T', expiresAt: null });
    await upsertAccount(env, 'b1', { userId: '43', username: 'stay', token: 'T', expiresAt: null });
    const payload = btoa(JSON.stringify({ user_id: '42' })).replace(/=+$/, '');
    const sig = (await hmacBase64('appsecret', payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const post = (sr: string) => new Request('https://x.dev/threads/delete', { method: 'POST', body: new URLSearchParams({ signed_request: sr }) });
    expect((await handleMetaCallback(env, post(`bad.${payload}`), 'delete')).status).toBe(400);
    expect((await listAccounts(env)).length).toBe(2);
    expect(await (await handleMetaCallback(env, post(`${sig}.${payload}`), 'delete')).json()).toHaveProperty('confirmation_code');
    expect((await listAccounts(env)).map((a) => a.username)).toEqual(['stay']);
  });
});
void signToken;

describe('Threads own-posts export', () => {
  it('pages through /me/threads and is admin-only', async () => {
    const env = await makeEnv();
    const admin = await loginAs(env);
    const staff = await loginAs(env, 'cs', 'staff-password-1');
    expect((await api(env, 'GET', '/api/integrations/threads/posts', undefined, staff)).status).toBe(403);
    const m = mockFetch((u) => u.includes('after=p2') ? jres({ data: [{ id: '2', text: 'b' }] })
      : jres({ data: [{ id: '1', text: 'a' }], paging: { next: 'https://graph.threads.net/v1.0/me/threads?after=p2' } })); restore = m.restore;
    const r = await api(env, 'GET', '/api/integrations/threads/posts', undefined, admin);
    expect(await r.json()).toEqual([{ id: '1', text: 'a' }, { id: '2', text: 'b' }]);
  });
});
