// LINE 好友數（只讀取，不接管訊息）：用 LINE 官方統計 API 每天取得「累計加好友次數」，相減得到每日新好友。
// 沒開「LINE 自動接待」加購的客戶用這個；開了加購的客戶由 Webhook 的加好友事件即時計算，兩者不同時使用以免重複。
import { xfetch } from '../budget';
import { getBrand, getSettings } from '../db';
import { logEvent } from '../log';
import type { Env } from '../types';

const DAY = 86400000;
/** LINE 統計以日本時間（UTC+9）切日 */
const jstDay = (ms: number) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);

export class LineInsightError extends Error {}

/** 取得指定日（YYYY-MM-DD，日本時間）為止的累計加好友次數；資料還沒準備好時回傳 null。 */
export async function followersAt(env: Env, day: string): Promise<number | null> {
  const r = await xfetch(env)(`https://api.line.me/v2/bot/insight/followers?date=${day.replace(/-/g, '')}`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  const b: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new LineInsightError(`LINE 統計 API 回應 HTTP ${r.status}${b?.message ? `：${b.message}` : ''}`);
  if (b.status !== 'ready' || typeof b.followers !== 'number') return null; // unready：隔天才會有資料，下一小時再試
  return b.followers;
}

/** 每小時呼叫一次：補上「昨天」的新好友數（已有就不再查）。 */
export async function syncLineFollowers(env: Env, now = new Date()): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const brand = await getBrand(env);
  if ((await getSettings(env, brand.id)).leads_enabled) return; // 加購客戶由 Webhook 即時計算
  const d1 = jstDay(now.getTime() - DAY), d0 = jstDay(now.getTime() - 2 * DAY);
  const have = new Map((await env.DB.prepare(`SELECT day,count FROM metrics_daily WHERE brand_id=? AND name='line_followers' AND day IN (?,?)`)
    .bind(brand.id, d0, d1).all<{ day: string; count: number }>()).results.map((r) => [r.day, r.count]));
  if (have.has(d1)) return;
  const save = (day: string, n: number) => env.DB.prepare(`INSERT INTO metrics_daily(brand_id,day,name,count) VALUES(?,?,'line_followers',?)
    ON CONFLICT(brand_id,day,name) DO UPDATE SET count=excluded.count`).bind(brand.id, day, n).run();
  try {
    const c1 = await followersAt(env, d1);
    if (c1 === null) return;
    let c0 = have.get(d0);
    if (c0 === undefined) { const v = await followersAt(env, d0); if (v !== null) { c0 = v; await save(d0, v); } }
    await save(d1, c1);
    if (c0 !== undefined) {
      // 累計加好友次數只增不減（封鎖不會扣），相減即當天新加入的好友數
      await env.DB.prepare(`INSERT INTO metrics_daily(brand_id,day,name,count) VALUES(?,?,'friend_add',?)
        ON CONFLICT(brand_id,day,name) DO UPDATE SET count=excluded.count`).bind(brand.id, d1, Math.max(0, c1 - c0)).run();
    }
  } catch (e) {
    if (!(e instanceof LineInsightError)) throw e;
    await logEvent(env, brand.id, 'warn', 'line_insights', `無法取得 LINE 好友數：${e.message}`, undefined, { throttleMinutes: 720 });
  }
}
