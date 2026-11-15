// 授權連結：傳給 Threads 帳號的擁有者，他點開、按「繼續授權」、在 Threads 按「允許」就完成，不用登入這個後台。
// 連結只能把帳號連到「產生連結的那個品牌」，7 天內有效；可選擇指定預期的帳號（授權回來時核對）。
import { buildAuthorizeUrl, oauthConfigured } from './oauth';
import { signToken, verifyToken } from '../util/crypto';
import type { Env } from '../types';

const LINK_TTL = 7 * 86400;
const linkSecret = (env: Env) => `${env.SESSION_SECRET}:threads-link`;
export const LINK_DAYS = LINK_TTL / 86400;

export async function makeConnectLink(env: Env, origin: string, brandId: string, expect?: string, now = Date.now()): Promise<string> {
  const t = await signToken(linkSecret(env), { uid: 0, p: 'threads_link', b: brandId, x: expect?.toLowerCase(), exp: Math.floor(now / 1000) + LINK_TTL });
  return `${origin}/threads/connect?t=${encodeURIComponent(t)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const page = (status: number, title: string, body: string) => new Response(
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/app.css"></head>
<body><div class="login"><div class="mark">T</div>${body}</div></body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const invalid = (msg: string) => page(400, '連結無效', `<h1 class="t-page">這個連結不能用</h1><p class="t-sub" style="margin:8px 0 0">${esc(msg)}</p>`);

export async function handleConnectLink(env: Env, req: Request, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const v = await verifyToken(linkSecret(env), url.searchParams.get('t') ?? '', Math.floor(now / 1000));
  if (!v || v.p !== 'threads_link' || !v.b) return invalid('連結已過期或不完整，請向傳給你連結的人索取新的連結。');
  const brand = await env.DB.prepare('SELECT name,COALESCE(status,\'active\') status FROM brands WHERE id=?').bind(v.b).first<{ name: string; status: string }>();
  if (!brand || brand.status === 'suspended') return invalid('這個品牌目前無法連結，請聯絡傳給你連結的人。');
  if (!oauthConfigured(env)) return invalid('系統尚未完成設定，請聯絡傳給你連結的人。');
  // 第二步：真的前往 Threads 授權
  if (url.searchParams.get('go') === '1') {
    const to = await buildAuthorizeUrl(env, url.origin, 0, now, { brandId: v.b, expect: v.x, magic: true });
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  // 第一步：先說明這是什麼、要連結哪個帳號，避免對方不知道為什麼收到這個連結
  const who = v.x ? `<b>@${esc(v.x)}</b>` : '你的 Threads 帳號';
  return page(200, '連結 Threads 帳號', `<h1 class="t-page">${esc(brand.name)}</h1>
    <p class="t-sub" style="margin:8px 0 20px">請你授權 ${who}，讓 ${esc(brand.name)} 可以代你發佈貼文。</p>
    <div class="note" style="margin-bottom:20px">按下面的按鈕後，Threads 會顯示一個授權頁，按「Continue」就完成。${v.x ? `請確認授權頁寫的是 <b>@${esc(v.x)}</b>；如果不是，按 Cancel，改用無痕分頁開啟這個連結，再用 @${esc(v.x)} 登入。` : '授權頁會顯示目前登入的帳號，請確認是你要連結的那個。'}</div>
    <a class="btn block" style="text-decoration:none" href="${esc(`${url.pathname}?t=${encodeURIComponent(url.searchParams.get('t') ?? '')}&go=1`)}">繼續授權</a>
    <p class="t-sub" style="margin-top:16px">授權只會讓對方發佈貼文與讀取成效，你隨時可以在 Threads 設定中撤銷。</p>`);
}
