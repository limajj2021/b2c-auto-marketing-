// 貼文中的 LINE 加好友連結改經追蹤短連結 /go/<代碼>：只記點擊次數，不記任何訪客資訊。
import { forBrand, getSettings } from './db';
import { bump } from './metrics';
import type { Env, Post } from './types';
import { iso } from './util/time';

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

export async function handleGo(raw: Env, req: Request, code: string): Promise<Response> {
  const row = await raw.DB.prepare('SELECT brand_id,target_url FROM post_links WHERE code=?').bind(code).first<{ brand_id: string; target_url: string }>();
  if (!row || !/^https:\/\//.test(row.target_url)) return new Response('連結不存在或已失效', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const ua = req.headers.get('user-agent') ?? '';
  if (req.method === 'GET' && ua && !BOT.test(ua)) {
    await raw.DB.prepare('UPDATE post_links SET clicks=clicks+1 WHERE code=?').bind(code).run();
    await bump(forBrand(raw, row.brand_id), 'link_click').catch(() => {});
  }
  return new Response(null, { status: 302, headers: { location: row.target_url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
