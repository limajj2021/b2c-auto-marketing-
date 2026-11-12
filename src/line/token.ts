// LINE 發訊用 token：客戶只需提供 Channel ID + Channel secret，系統自行向 LINE 申請（有效 30 天），到期前自動更新。
import { audit, getBrand } from '../db';
import { xfetch } from '../budget';
import { getMeta, setCred } from '../integrations';
import type { Env } from '../types';

const RENEW_BEFORE_MS = 7 * 86400000;

export class LineCredError extends Error {}

/** 以 Channel ID + secret 申請 token（client_credentials）。憑證錯誤時丟出 LineCredError。 */
export async function issueLineToken(channelId: string, secret: string, f: typeof fetch = fetch): Promise<{ token: string; expiresAt: string }> {
  const r = await f('https://api.line.me/v2/oauth/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: channelId, client_secret: secret }).toString(),
  });
  const b: any = await r.json().catch(() => ({}));
  if (!r.ok || !b.access_token) {
    if (r.status === 400 || r.status === 401) throw new LineCredError('Channel ID 或 Channel secret 不正確');
    throw new Error(`LINE 暫時無法回應（HTTP ${r.status}），請稍後再試`);
  }
  return { token: b.access_token, expiresAt: new Date(Date.now() + (Number(b.expires_in) || 2592000) * 1000).toISOString() };
}

/** 排程呼叫：自動申請的 token 在到期前 7 天換新。客戶自行貼上的 long-lived token 不處理。 */
export async function renewLineTokenIfNeeded(env: Env, now = new Date()): Promise<void> {
  // 到期時間已由 withCreds 一併載入，未到更新時間時不另外查詢資料庫
  if (env.LINE_TOKEN_AUTO_EXPIRES === undefined || !env.LINE_CHANNEL_ID || !env.LINE_CHANNEL_SECRET) return;
  const exp = env.LINE_TOKEN_AUTO_EXPIRES ? new Date(env.LINE_TOKEN_AUTO_EXPIRES).getTime() : 0;
  if (exp - now.getTime() > RENEW_BEFORE_MS) return;
  const meta = (await getMeta(env, 'line_channel_access_token')) ?? {};
  const brand = await getBrand(env);
  const t = await issueLineToken(env.LINE_CHANNEL_ID, env.LINE_CHANNEL_SECRET, xfetch(env));
  await setCred(env, brand.id, 'line_channel_access_token', t.token, { ...meta, expires_at: t.expiresAt });
  env.LINE_CHANNEL_ACCESS_TOKEN = t.token; env.LINE_TOKEN_AUTO_EXPIRES = t.expiresAt;
  await audit(env, brand.id, null, 'line_token_renewed');
}
