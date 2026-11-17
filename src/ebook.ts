// 電子書閱讀器：頁面圖片只發給「在 LINE 裡打開、而且是官方帳號好友」的讀者。
// 流程：LIFF 頁面拿 LINE 的 access token → /line/ebook-token 向 LINE 驗證（必須是我們的 LIFF channel 發的）→ 確認是好友 →
// 發一張 30 分鐘的閱讀證 → 圖片網址 /ebook/... 帶閱讀證才拿得到。沒有 PDF 可下載；圖片網址外流也會在 30 分鐘後失效。
// 註：網頁無法禁止截圖，浮水印（讀者的 LINE 名稱）在前端畫上，用來嚇阻與追查外流。
import { signToken, verifyToken } from './util/crypto';
import type { Env } from './types';

const TTL = 30 * 60;
const secret = (env: Env) => `${env.SESSION_SECRET}:ebook`;
const PAGE = /^\/ebook\/b\d{1,2}\/p-\d{2,3}\.jpg$/;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function handleEbookToken(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const channel = env.EBOOK_LIFF_CHANNEL;
  if (!channel) return json({ error: '電子書尚未設定' }, 503);
  const b: any = await req.json().catch(() => ({}));
  const at = String(b?.access_token ?? '');
  if (!at || at.length > 2000) return json({ error: '請在 LINE 裡打開' }, 401);
  // 1. 這個 token 是不是我們的 LIFF（LINE Login channel）發的、還有效
  const v = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(at)}`);
  const vj: any = await v.json().catch(() => ({}));
  if (!v.ok || String(vj.client_id) !== String(channel) || !(Number(vj.expires_in) > 0)) return json({ error: '請在 LINE 裡重新打開' }, 401);
  // 2. 是不是官方帳號好友（LINE Login channel 有連結官方帳號時才查得到；查不到就不擋）
  const f = await fetch('https://api.line.me/friendship/v1/status', { headers: { authorization: `Bearer ${at}` } }).catch(() => null);
  if (f?.ok) { const fj: any = await f.json().catch(() => ({})); if (fj.friendFlag === false) return json({ error: '加入好友後即可閱讀', need_friend: true }, 403); }
  const token = await signToken(secret(env), { uid: 0, p: 'ebook', exp: Math.floor(now / 1000) + TTL });
  return json({ token, ttl: TTL });
}

export async function handleEbookAsset(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  if (!PAGE.test(url.pathname)) return new Response('not found', { status: 404 });
  const v = await verifyToken(secret(env), url.searchParams.get('t') ?? '', Math.floor(now / 1000));
  if (!v || v.p !== 'ebook') return new Response('forbidden', { status: 403, headers: { 'cache-control': 'no-store' } });
  const r = await env.ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
  if (!r.ok) return new Response('not found', { status: 404 });
  return new Response(r.body, { status: 200, headers: {
    'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'content-disposition': 'inline',
    'cross-origin-resource-policy': 'same-origin',
  } });
}
