import { audit, forBrand, getBrand } from '../db';
import { credFor, listAccounts, markAccount, removeAccounts, setAccountToken, upsertAccount } from './accounts';
import type { Env } from '../types';
import { logEvent } from '../log';
import { hmacBase64, signToken, timingSafeEqual, verifyToken } from '../util/crypto';

const OAUTH = 'https://graph.threads.net';
// threads_manage_replies：串文（回覆自己上一則）需要；threads_manage_insights：曝光／互動數據
export const SCOPES = 'threads_basic,threads_content_publish,threads_manage_replies,threads_manage_insights';
const STATE_TTL = 600;
const REFRESH_BEFORE_DAYS = 10;

// state 會出現在網址列與 Referer，必須用與登入 Session 不同的金鑰簽章，否則可被當成登入憑證重放
const stateSecret = (env: Env) => `${env.SESSION_SECRET}:threads-oauth-state`;
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

export function oauthConfigured(env: Env): boolean {
  return !!(env.THREADS_APP_ID && env.THREADS_APP_SECRET);
}

export async function buildAuthorizeUrl(env: Env, origin: string, adminId: number, now = Date.now()): Promise<string> {
  const state = await signToken(stateSecret(env), { uid: adminId, p: 'threads_oauth', exp: Math.floor(now / 1000) + STATE_TTL });
  const q = new URLSearchParams({
    client_id: env.THREADS_APP_ID!, redirect_uri: `${origin}/threads/callback`,
    scope: env.THREADS_SCOPES?.trim() || SCOPES, response_type: 'code', state,
  });
  return `https://threads.net/oauth/authorize?${q}`;
}

async function jget(url: string, init?: RequestInit, f: typeof fetch = fetch) {
  const r = await f(url, init);
  const b: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.error?.message ?? `HTTP ${r.status}`);
  return b;
}

/** Meta 授權完成後的跳轉：換短效 → 長效 token、查帳號、加密存入。 */
export async function handleCallback(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const fail = (reason: string) => redirect(`/?threads=error&reason=${encodeURIComponent(reason)}`);
  const code = (url.searchParams.get('code') ?? '').replace(/#_$/, '');
  const state = url.searchParams.get('state') ?? '';
  const st = await verifyToken(stateSecret(env), state, Math.floor(now / 1000));
  const owner = st && st.p === 'threads_oauth'
    ? await env.DB.prepare('SELECT brand_id FROM admin_users WHERE id=? AND enabled=1').bind(st.uid).first<{ brand_id: string }>() : null;
  // 每一步的結果寫入操作紀錄（不含任何憑證），授權卡住時可判斷停在哪一步
  const bid = owner?.brand_id ?? null;
  if (url.searchParams.get('error')) {
    await logEvent(env, bid, 'warn', 'threads_oauth', '使用者在 Threads 取消或拒絕授權', {
      error: url.searchParams.get('error'), reason: url.searchParams.get('error_reason'), description: url.searchParams.get('error_description'),
    });
    return fail('已取消授權');
  }
  if (!code || !owner) {
    await logEvent(env, bid, 'warn', 'threads_oauth', code ? '授權回到系統，但驗證碼無效或已逾時（超過 10 分鐘，或從別的瀏覽器開啟）' : '授權回到系統，但沒有帶授權碼');
    return fail('授權已逾時，請重新操作');
  }
  // 授權結果歸屬於發起連結的管理員所在的工作區（固定一個回呼網址即可服務所有工作區）
  env = forBrand(env, owner.brand_id);
  if (!oauthConfigured(env)) return fail('系統尚未設定 Threads App');
  let stage = 'exchange_code';
  try {
    const short = await jget(`${OAUTH}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.THREADS_APP_ID!, client_secret: env.THREADS_APP_SECRET!, grant_type: 'authorization_code',
        redirect_uri: `${url.origin}/threads/callback`, code,
      }).toString(),
    });
    stage = 'long_lived_token';
    const long = await jget(`${OAUTH}/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(env.THREADS_APP_SECRET!)}&access_token=${encodeURIComponent(short.access_token)}`);
    stage = 'read_profile';
    const me = await jget(`${OAUTH}/v1.0/me?fields=id,username&access_token=${encodeURIComponent(long.access_token)}`);
    const brand = await getBrand(env);
    const expiresAt = new Date(now + (long.expires_in ?? 5184000) * 1000).toISOString();
    await upsertAccount(env, brand.id, { userId: String(me.id), username: me.username ?? null, token: long.access_token, expiresAt });
    await env.DB.prepare(`UPDATE brand_settings SET threads_status='ok' WHERE brand_id=?`).bind(brand.id).run();
    await audit(env, brand.id, null, 'threads_connected', me.username ?? '');
    await logEvent(env, brand.id, 'info', 'threads_oauth', `已連結 @${me.username ?? me.id}`);
    return redirect('/?threads=connected');
  } catch (e) {
    const STAGE: Record<string, string> = { exchange_code: '以授權碼換取憑證', long_lived_token: '換成長效憑證', read_profile: '讀取帳號資料' };
    await logEvent(env, bid, 'error', 'threads_oauth', `授權失敗：${STAGE[stage] ?? stage}時 Meta 回傳錯誤`, { stage, meta_error: (e as Error).message });
    return fail(`授權失敗（${stage}）：${(e as Error).message}`.slice(0, 200));
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
      const r = await jget(`${OAUTH}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(c.token)}`, undefined, c.f);
      await setAccountToken(env, a.id, r.access_token, new Date(now.getTime() + (r.expires_in ?? 5184000) * 1000).toISOString());
      await audit(env, brand.id, null, 'threads_token_refreshed', a.username ?? '');
      await logEvent(env, brand.id, 'info', 'threads_token', `@${a.username} 憑證已自動續期`);
    } catch (e) {
      await logEvent(env, brand.id, left <= 0 ? 'error' : 'warn', 'threads_token',
        left <= 0 ? `@${a.username} 憑證已過期且續期失敗，請重新連結` : `@${a.username} 憑證續期失敗，稍後會再試`, { error: (e as Error).message });
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
  if (data.user_id) {
    // 使用者在 Threads 撤銷授權：從所有工作區移除這個帳號
    const rows = (await env.DB.prepare('SELECT id,brand_id FROM threads_accounts WHERE threads_user_id=?').bind(String(data.user_id)).all<{ id: number; brand_id: string }>()).results;
    for (const r of rows) {
      await removeAccounts(forBrand(env, r.brand_id), { brandId: r.brand_id, id: r.id });
      await logEvent(env, r.brand_id, 'warn', 'threads_oauth', kind === 'delete' ? '使用者在 Threads 要求刪除資料，帳號已移除' : '使用者在 Threads 撤銷授權，帳號已移除');
      await audit(env, r.brand_id, null, `threads_${kind}`);
    }
  }
  const code = crypto.randomUUID();
  return kind === 'delete'
    ? new Response(JSON.stringify({ url: `${new URL(req.url).origin}/data-deletion.html?code=${code}`, confirmation_code: code }), { headers: { 'content-type': 'application/json' } })
    : new Response('ok');
}
