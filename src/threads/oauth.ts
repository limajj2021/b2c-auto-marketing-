import { audit, getBrand } from '../db';
import { credFor, listAccounts, markAccount, setAccountToken, upsertAccount } from './accounts';
import type { Env } from '../types';
import { hmacBase64, signToken, timingSafeEqual, verifyToken } from '../util/crypto';

const OAUTH = 'https://graph.threads.net';
// threads_manage_replies：串文（回覆自己上一則）需要
export const SCOPES = 'threads_basic,threads_content_publish,threads_manage_replies';
const STATE_TTL = 600;
const REFRESH_BEFORE_DAYS = 10;

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

export function oauthConfigured(env: Env): boolean {
  return !!(env.THREADS_APP_ID && env.THREADS_APP_SECRET);
}

export async function buildAuthorizeUrl(env: Env, origin: string, adminId: number, now = Date.now()): Promise<string> {
  const state = await signToken(env.SESSION_SECRET, { uid: adminId, exp: Math.floor(now / 1000) + STATE_TTL });
  const q = new URLSearchParams({
    client_id: env.THREADS_APP_ID!, redirect_uri: `${origin}/threads/callback`,
    scope: SCOPES, response_type: 'code', state,
  });
  return `https://threads.net/oauth/authorize?${q}`;
}

async function jget(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const b: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.error?.message ?? `HTTP ${r.status}`);
  return b;
}

/** Meta 授權完成後的跳轉：換短效 → 長效 token、查帳號、加密存入。 */
export async function handleCallback(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const fail = (reason: string) => redirect(`/?threads=error&reason=${encodeURIComponent(reason)}`);
  if (url.searchParams.get('error')) return fail('已取消授權');
  const code = (url.searchParams.get('code') ?? '').replace(/#_$/, '');
  const state = url.searchParams.get('state') ?? '';
  if (!code || !(await verifyToken(env.SESSION_SECRET, state, Math.floor(now / 1000)))) return fail('授權已逾時，請重新操作');
  if (!oauthConfigured(env)) return fail('系統尚未設定 Threads App');
  try {
    const short = await jget(`${OAUTH}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.THREADS_APP_ID!, client_secret: env.THREADS_APP_SECRET!, grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/threads/callback`, code,
      }).toString(),
    });
    const long = await jget(`${OAUTH}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET!)}&access_token=${encodeURIComponent(short.access_token)}`);
    const me = await jget(`${OAUTH}/v1.0/me?fields=id,username&access_token=${encodeURIComponent(long.access_token)}`);
    const brand = await getBrand(env);
    const expiresAt = new Date(now + (long.expires_in ?? 5184000) * 1000).toISOString();
    await upsertAccount(env, brand.id, { userId: String(me.id), username: me.username ?? null, token: long.access_token, expiresAt });
    await env.DB.prepare(`UPDATE brand_settings SET threads_status='ok' WHERE brand_id=?`).bind(brand.id).run();
    await audit(env, brand.id, null, 'threads_connected', me.username ?? '');
    return redirect('/?threads=connected');
  } catch (e) {
    console.error('threads:callback', (e as Error).message);
    return fail('授權失敗，請重試');
  }
}

/** 每個帳號到期前自動續期（長效 token 約 60 天，需存活 24 小時以上才可續期）。 */
export async function refreshIfNeeded(env: Env, now = new Date()): Promise<void> {
  const brand = await getBrand(env);
  for (const a of await listAccounts(env)) {
    if (!a.expires_at) continue;
    const left = new Date(a.expires_at).getTime() - now.getTime();
    if (left > REFRESH_BEFORE_DAYS * 86400000) continue;
    try {
      const c = await credFor(env, a);
      const r = await jget(`${OAUTH}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(c.token)}`);
      await setAccountToken(env, a.id, r.access_token, new Date(now.getTime() + (r.expires_in ?? 5184000) * 1000).toISOString());
      await audit(env, brand.id, null, 'threads_token_refreshed', a.username ?? '');
    } catch (e) {
      console.error('threads:refresh', (e as Error).message);
      if (left <= 0) await markAccount(env, a.id, 'token_invalid');
    }
  }
}

// ---- Meta 的解除安裝／資料刪除回呼（signed_request 以 App secret 簽章）----
async function parseSignedRequest(env: Env, req: Request): Promise<{ user_id?: string } | null> {
  if (!env.THREADS_APP_SECRET) return null;
  const sr = (await req.formData().catch(() => null))?.get('signed_request');
  if (typeof sr !== 'string') return null;
  const [sig, payload] = sr.split('.');
  if (!sig || !payload) return null;
  const expect = (await hmacBase64(env.THREADS_APP_SECRET, payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!timingSafeEqual(expect, sig)) return null;
  try { return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

export async function handleMetaCallback(env: Env, req: Request, kind: 'deauthorize' | 'delete'): Promise<Response> {
  const data = await parseSignedRequest(env, req);
  if (!data) return new Response('invalid', { status: 400 });
  const brand = await getBrand(env);
  if (data.user_id) {
    const r = await env.DB.prepare('DELETE FROM threads_accounts WHERE brand_id=? AND threads_user_id=?').bind(brand.id, String(data.user_id)).run();
    if (r.meta.changes) await audit(env, brand.id, null, `threads_${kind}`);
  }
  const code = crypto.randomUUID();
  return kind === 'delete'
    ? new Response(JSON.stringify({ url: `${new URL(req.url).origin}/data-deletion.html?code=${code}`, confirmation_code: code }), { headers: { 'content-type': 'application/json' } })
    : new Response('ok');
}
