// 貼文中的 LINE 加好友連結改經追蹤短連結 /go/<代碼>：只記點擊次數，不記任何訪客資訊。
import { forBrand, getSettings } from './db';
import { bump } from './metrics';
import type { Env, Post } from './types';
import { iso, localDate } from './util/time';
import { hmacBase64 } from './util/crypto';

const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHA[b % ALPHA.length]).join('');
// 社群平台的連結預覽爬蟲、指令列工具不算點擊
const BOT = /bot|crawler|spider|facebookexternalhit|meta-externalagent|facebot|preview|slurp|curl|wget|python|headless|fetch/i;

/** 發布前把貼文中的 LINE 連結換成追蹤短連結；同一串貼文固定使用同一個代碼（重試與核對時結果一致）。 */
export async function trackedParts(env: Env, post: Pick<Post, 'id' | 'brand_id' | 'account_id'>, parts: string[]): Promise<string[]> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (!base) return parts;
  const url = (await getSettings(env, post.brand_id)).line_add_url;
  if (!url || !parts.some((p) => p.includes(url))) return parts;
  let code = (await env.DB.prepare('SELECT code FROM post_links WHERE brand_id=? AND post_id=?').bind(post.brand_id, post.id).first<{ code: string }>())?.code;
  if (!code) {
    code = randomCode();
    await env.DB.prepare('INSERT INTO post_links(code,brand_id,post_id,account_id,target_url,created_at) VALUES(?,?,?,?,?,?)')
      .bind(code, post.brand_id, post.id, post.account_id ?? null, url, iso()).run();
  }
  const link = `${base}/go/${code}`;
  return parts.map((p) => p.split(url).join(link));
}

/**
 * 訪客去重代碼：網路位址＋裝置資訊，以「每天更換」的密鑰做 HMAC。只用來判斷同一天是否點過同一個連結，
 * 不存原始位址；隔天密鑰不同，無法跨日追蹤，2 天後連代碼都刪除。
 */
async function visitorHash(raw: Env, req: Request, day: string): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const ua = req.headers.get('user-agent') ?? '';
  return (await hmacBase64(`${raw.SESSION_SECRET}:click-visitor:${day}`, `${ip}|${ua}`)).slice(0, 22);
}

export async function handleGo(raw: Env, req: Request, code: string, now = new Date()): Promise<Response> {
  const row = await raw.DB.prepare('SELECT l.brand_id,l.post_id,l.target_url,b.timezone FROM post_links l JOIN brands b ON b.id=l.brand_id WHERE l.code=?')
    .bind(code).first<{ brand_id: string; post_id: number | null; target_url: string; timezone: string }>();
  if (!row || !/^https:\/\//.test(row.target_url)) return new Response('連結不存在或已失效', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const ua = req.headers.get('user-agent') ?? '';
  if (req.method === 'GET' && ua && !BOT.test(ua)) {
    const day = localDate(now, row.timezone || 'Asia/Taipei');
    // 同一位訪客同一天重複點同一個連結，次數照算，但人數只算一次
    const first = (await raw.DB.prepare('INSERT OR IGNORE INTO link_visitors(code,day,vh) VALUES(?,?,?)').bind(code, day, await visitorHash(raw, req, day)).run()).meta.changes === 1 ? 1 : 0;
    await raw.DB.prepare('UPDATE post_links SET clicks=clicks+1,uniques=uniques+? WHERE code=?').bind(first, code).run();
    if (row.post_id !== null) {
      await raw.DB.prepare(`INSERT INTO link_daily(brand_id,post_id,day,clicks,uniques) VALUES(?,?,?,1,?)
        ON CONFLICT(brand_id,post_id,day) DO UPDATE SET clicks=clicks+1,uniques=uniques+excluded.uniques`).bind(row.brand_id, row.post_id, day, first).run();
    }
    const benv = forBrand(raw, row.brand_id);
    await bump(benv, 'link_click', now).catch(() => {});
    if (first) await bump(benv, 'link_unique', now).catch(() => {});
  }
  return new Response(null, { status: 302, headers: { location: row.target_url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/** 訪客去重代碼只保留 2 天 */
export async function pruneVisitors(env: Env, now = new Date()): Promise<void> {
  await env.DB.prepare('DELETE FROM link_visitors WHERE day<?').bind(new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10)).run();
}
