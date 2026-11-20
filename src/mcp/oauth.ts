// AI 連接器的登入授權（OAuth 2.1 + PKCE + 動態註冊）。
// 客戶在 ChatGPT / Codex / Claude 加入連接器 → 跳到這裡登入後台帳號、選品牌、按「允許」→ AI 拿到只對應那一個品牌的通行證。
// 授權頁自己要求登入：後台的登入 Cookie 是 SameSite=Strict，從 ChatGPT 跳過來時瀏覽器不會帶，所以這裡不靠 Cookie。
// 通行證與授權碼只存雜湊；通行證每次使用都重新檢查帳號是否啟用、是否仍有該品牌的權限、品牌是否被暫停。
import { accessibleBrands } from '../admin/routes';
import { audit } from '../db';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../util/crypto';
import { iso } from '../util/time';
import type { Env } from '../types';

export const ACCESS_TTL = 3600;
export const REFRESH_TTL = 30 * 86400;
export const PERSONAL_TTL = 90 * 86400;
const CODE_TTL = 600;
const consentSecret = (env: Env) => `${env.SESSION_SECRET}:oauth-consent`;

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS, DELETE' };
export const cors = CORS;
const json = (o: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra } });
const oauthErr = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['posts'],
  };
}
export const resourceMetadata = (origin: string) => ({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['posts'], bearer_methods_supported: ['header'], resource_name: '異構資本 貼文助理' });

/** redirect_uri 只接受 https，或本機（Codex、Claude Desktop 這類本機程式） */
const okRedirect = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; } };

export async function handleRegister(env: Env, req: Request): Promise<Response> {
  const b: any = await req.json().catch(() => null);
  const uris: string[] = Array.isArray(b?.redirect_uris) ? b.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every(okRedirect)) return oauthErr('invalid_redirect_uri', 'redirect_uris 必須是 https 網址（或本機網址），最多 5 個');
  const name = String(b?.client_name ?? '').trim().slice(0, 60) || 'AI 助理';
  const id = 'c_' + randomToken(16);
  await env.DB.prepare('INSERT INTO oauth_clients(id,name,redirect_uris,created_at) VALUES(?,?,?,?)').bind(id, name, JSON.stringify(uris), iso()).run();
  return json({ client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
}

// ---------- 授權頁 ----------
interface AuthParams { client_id: string; redirect_uri: string; state: string; code_challenge: string; code_challenge_method: string; scope: string }
const PARAM_KEYS: (keyof AuthParams)[] = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope'];
const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const page = (status: number, title: string, body: string) => new Response(
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css">
<style>.opt{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid var(--line);border-radius:12px;margin-top:8px;cursor:pointer}.opt input{width:18px;height:18px;min-height:0}.perm li{margin:4px 0}</style></head>
<body><div class="login"><div class="mark">AI</div>${body}</div></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'no-referrer' } });
const hidden = (p: AuthParams) => PARAM_KEYS.map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] ?? '')}">`).join('');
const bindHash = async (p: AuthParams) => (await sha256(`${p.client_id}|${p.redirect_uri}|${p.code_challenge}`)).slice(0, 32);

async function readParams(env: Env, src: URLSearchParams | FormData): Promise<{ p: AuthParams; client: { name: string } } | { error: string }> {
  const p = Object.fromEntries(PARAM_KEYS.map((k) => [k, String(src.get(k) ?? '')])) as unknown as AuthParams;
  const c = await env.DB.prepare('SELECT name,redirect_uris FROM oauth_clients WHERE id=?').bind(p.client_id).first<{ name: string; redirect_uris: string }>();
  if (!c) return { error: '找不到這個 AI 應用程式，請回到 ChatGPT／Codex 重新加入連接器。' };
  if (!(JSON.parse(c.redirect_uris) as string[]).includes(p.redirect_uri)) return { error: '回傳網址不符，請回到 ChatGPT／Codex 重新加入連接器。' };
  if (!p.code_challenge || p.code_challenge_method !== 'S256') return { error: '這個 AI 應用程式的授權方式不支援（需要 PKCE S256）。' };
  return { p, client: c };
}
const back = (p: AuthParams, q: Record<string, string>) => {
  const u = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  if (p.state) u.searchParams.set('state', p.state);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
};

const loginView = (p: AuthParams, clientName: string, msg = '') => page(200, '連接 AI 助理', `<h1 class="t-page">連接「${esc(clientName)}」</h1>
  <p class="t-sub" style="margin:8px 0 20px">登入你的後台帳號，讓 AI 助理幫你寫貼文、存成草稿。</p>
  ${msg ? `<div class="note warn" style="margin-bottom:12px">${esc(msg)}</div>` : ''}
  <form method="post" action="/oauth/authorize">${hidden(p)}<input type="hidden" name="step" value="login">
    <div class="f"><label for="u">帳號</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required></div>
    <div class="f"><label for="pw">密碼</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn block" style="margin-top:16px">登入</button></form>`);

async function consentView(env: Env, p: AuthParams, clientName: string, uid: number): Promise<Response> {
  const brands = (await accessibleBrands(env, uid)).filter((b) => b.status !== 'suspended');
  if (!brands.length) return page(403, '無法連接', '<h1 class="t-page">無法連接</h1><p class="t-sub">這個帳號沒有可以使用的品牌。</p>');
  const ticket = await signToken(consentSecret(env), { uid, p: 'oauth_consent', x: await bindHash(p), exp: Math.floor(Date.now() / 1000) + CODE_TTL });
  return page(200, '允許 AI 助理存取？', `<h1 class="t-page">允許「${esc(clientName)}」？</h1>
    <form method="post" action="/oauth/authorize">${hidden(p)}<input type="hidden" name="ticket" value="${esc(ticket)}">
      <p class="t-sub" style="margin:10px 0 4px">要連接哪個品牌？AI 只能存取你選的這一個。</p>
      ${brands.map((b, i) => `<label class="opt"><input type="radio" name="brand_id" value="${esc(b.id)}" ${i === 0 ? 'checked' : ''}><span>${esc(b.name)}${b.role === 'staff' ? '<span class="t-sub">（只能讀取）</span>' : ''}</span></label>`).join('')}
      <div class="note" style="margin-top:16px"><b>AI 助理可以：</b><ul class="perm" style="margin:6px 0 0 18px"><li>讀取品牌資料與寫作規則</li><li>查看、新增、修改貼文草稿</li><li>在你明確確認後立即發布貼文</li></ul>
      <b style="display:block;margin-top:8px">不能：</b><ul class="perm" style="margin:6px 0 0 18px"><li>看到其他品牌或其他客戶的資料</li><li>看到 Threads、LINE 授權或你的密碼</li></ul></div>
      <div class="actions" style="margin-top:20px"><button class="btn sec" name="step" value="deny">取消</button><button class="btn" name="step" value="approve">允許</button></div>
      <p class="t-sub" style="margin-top:12px">之後可以在後台「設定 → AI 連接器」隨時中斷。</p></form>`);
}

export async function handleAuthorize(env: Env, req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const r = await readParams(env, new URL(req.url).searchParams);
    if ('error' in r) return page(400, '無法連接', `<h1 class="t-page">無法連接</h1><p class="t-sub">${esc(r.error)}</p>`);
    if (new URL(req.url).searchParams.get('response_type') !== 'code') return back(r.p, { error: 'unsupported_response_type' });
    return loginView(r.p, r.client.name);
  }
  const f = await req.formData().catch(() => null);
  if (!f) return page(400, '無法連接', '<h1 class="t-page">無法連接</h1>');
  const r = await readParams(env, f);
  if ('error' in r) return page(400, '無法連接', `<h1 class="t-page">無法連接</h1><p class="t-sub">${esc(r.error)}</p>`);
  const { p, client } = r, step = String(f.get('step') ?? '');

  if (step === 'login') {
    const username = String(f.get('username') ?? '').trim().slice(0, 64).toLowerCase();
    const since = new Date(Date.now() - 15 * 60000).toISOString();
    const fails = await env.DB.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE action='login_fail' AND detail=? AND created_at>?`).bind(username, since).first<{ c: number }>();
    if ((fails?.c ?? 0) >= 5) return loginView(p, client.name, '嘗試次數過多，請 15 分鐘後再試');
    const u = await env.DB.prepare('SELECT id,password_hash,brand_id FROM admin_users WHERE lower(authentication_id)=? AND enabled=1').bind(username).first<any>();
    const ok = u ? await verifyPassword(String(f.get('password') ?? ''), u.password_hash) : (await hashPassword('x'), false);
    if (!ok) { await audit(env, u?.brand_id ?? '_platform', null, 'login_fail', username); return loginView(p, client.name, '帳號或密碼錯誤'); }
    return consentView(env, p, client.name, u.id);
  }

  const t = await verifyToken(consentSecret(env), String(f.get('ticket') ?? ''), Math.floor(Date.now() / 1000));
  if (!t || t.p !== 'oauth_consent' || t.x !== (await bindHash(p))) return loginView(p, client.name, '登入逾時，請重新登入');
  if (step === 'deny') return back(p, { error: 'access_denied' });
  if (step !== 'approve') return loginView(p, client.name);
  const brandId = String(f.get('brand_id') ?? '');
  const b = (await accessibleBrands(env, t.uid)).find((x) => x.id === brandId && x.status !== 'suspended');
  if (!b) return consentView(env, p, client.name, t.uid);
  const code = randomToken(24);
  await env.DB.prepare('INSERT INTO oauth_codes(code_hash,client_id,user_id,brand_id,redirect_uri,challenge,expires_at) VALUES(?,?,?,?,?,?,?)')
    .bind(await sha256(code), p.client_id, t.uid, brandId, p.redirect_uri, p.code_challenge, new Date(Date.now() + CODE_TTL * 1000).toISOString()).run();
  const user = await env.DB.prepare('SELECT authentication_id FROM admin_users WHERE id=?').bind(t.uid).first<{ authentication_id: string }>();
  await audit(env, brandId, user?.authentication_id ?? null, 'mcp_authorize', client.name);
  return back(p, { code });
}

// ---------- 通行證 ----------
export async function issueTokens(env: Env, clientId: string, clientName: string, userId: number, brandId: string) {
  const access = randomToken(), refresh = randomToken(), now = Date.now();
  const ins = 'INSERT INTO oauth_tokens(token_hash,kind,client_id,client_name,user_id,brand_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)';
  await env.DB.prepare(ins).bind(await sha256(access), 'access', clientId, clientName, userId, brandId, new Date(now + ACCESS_TTL * 1000).toISOString(), iso()).run();
  await env.DB.prepare(ins).bind(await sha256(refresh), 'refresh', clientId, clientName, userId, brandId, new Date(now + REFRESH_TTL * 1000).toISOString(), iso()).run();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'posts' };
}

export async function handleToken(env: Env, req: Request): Promise<Response> {
  const ct = req.headers.get('content-type') ?? '';
  const raw: Record<string, string> = ct.includes('json') ? ((await req.json().catch(() => ({}))) as Record<string, string>) : Object.fromEntries(new URLSearchParams(await req.text()));
  const g = String(raw.grant_type ?? '');
  if (g === 'authorization_code') {
    const row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').bind(await sha256(String(raw.code ?? ''))).first<any>();
    if (!row || row.used || row.expires_at < iso()) return oauthErr('invalid_grant', '授權碼無效或已過期');
    if (row.client_id !== raw.client_id || row.redirect_uri !== raw.redirect_uri) return oauthErr('invalid_grant', '授權碼與應用程式不符');
    if ((await sha256(String(raw.code_verifier ?? ''))) !== row.challenge) return oauthErr('invalid_grant', 'PKCE 驗證失敗');
    const used = await env.DB.prepare('UPDATE oauth_codes SET used=1 WHERE code_hash=? AND used=0').bind(row.code_hash).run();
    if (used.meta.changes !== 1) return oauthErr('invalid_grant', '授權碼已使用過');
    const c = await env.DB.prepare('SELECT name FROM oauth_clients WHERE id=?').bind(row.client_id).first<{ name: string }>();
    return json(await issueTokens(env, row.client_id, c?.name ?? 'AI 助理', row.user_id, row.brand_id));
  }
  if (g === 'refresh_token') {
    const h = await sha256(String(raw.refresh_token ?? ''));
    const row = await env.DB.prepare(`SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'`).bind(h).first<any>();
    if (!row || row.revoked || row.expires_at < iso() || (raw.client_id && raw.client_id !== row.client_id)) return oauthErr('invalid_grant', '請重新連接');
    // 換新：舊的 refresh token 立即作廢（被偷用時能及早發現）
    const r = await env.DB.prepare('UPDATE oauth_tokens SET revoked=1 WHERE token_hash=? AND revoked=0').bind(h).run();
    if (r.meta.changes !== 1) return oauthErr('invalid_grant', '請重新連接');
    if (!(await grantStillValid(env, row.user_id, row.brand_id))) return oauthErr('invalid_grant', '帳號或品牌權限已變更，請重新連接');
    return json(await issueTokens(env, row.client_id, row.client_name, row.user_id, row.brand_id));
  }
  return oauthErr('unsupported_grant_type', '只支援 authorization_code 與 refresh_token');
}

async function grantStillValid(env: Env, userId: number, brandId: string) {
  const u = await env.DB.prepare('SELECT id FROM admin_users WHERE id=? AND enabled=1').bind(userId).first();
  if (!u) return null;
  return (await accessibleBrands(env, userId)).find((b) => b.id === brandId && b.status !== 'suspended') ?? null;
}

export interface McpActor { userId: number; name: string; role: 'admin' | 'staff'; brandId: string; brandName: string; client: string }
/** 檢查 Bearer 通行證；每次都重新確認帳號與品牌權限 */
export async function verifyBearer(env: Env, req: Request): Promise<McpActor | null> {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const row = await env.DB.prepare(`SELECT * FROM oauth_tokens WHERE token_hash=? AND kind IN ('access','personal') AND revoked=0`).bind(await sha256(m[1])).first<any>();
  if (!row || row.expires_at < iso()) return null;
  const b = await grantStillValid(env, row.user_id, row.brand_id);
  if (!b) return null;
  const u = await env.DB.prepare('SELECT authentication_id FROM admin_users WHERE id=?').bind(row.user_id).first<{ authentication_id: string }>();
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 10 * 60000) await env.DB.prepare('UPDATE oauth_tokens SET last_used_at=? WHERE token_hash=?').bind(iso(), row.token_hash).run();
  return { userId: row.user_id, name: u?.authentication_id ?? '', role: b.role, brandId: row.brand_id, brandName: b.name, client: row.client_name };
}
