// Threads 測試邀請：客戶自己申請，或營運人員開通客戶時代為建立（同時在 Meta 送出邀請，客戶就不用等）。
import { listAccounts } from './accounts';
import { logEvent } from '../log';
import type { Env } from '../types';
import { iso } from '../util/time';

export type InviteStatus = 'requested' | 'invited' | 'accepted';

/** 接受 @name、threads 網址、大小寫不拘；格式不正確回傳 null */
export function normUsername(v: unknown): string | null {
  const u = String(v ?? '').trim().replace(/^https?:\/\/(www\.)?threads\.(net|com)\/@?/i, '').replace(/^@/, '').split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(u) ? u : null;
}

/**
 * 建立（或沿用）一筆邀請。已存在進行中的申請時，只會往前推進狀態（requested → invited → accepted），不會倒退。
 * 回傳 'connected' 代表這個帳號已經連結，不需要邀請。
 */
export async function requestInvite(env: Env, brandId: string, username: string, status: InviteStatus, by: string): Promise<{ id: number; status: string } | 'connected'> {
  if ((await listAccounts(env)).some((a) => (a.username ?? '').toLowerCase() === username)) return 'connected';
  const rank: Record<string, number> = { requested: 0, invited: 1, accepted: 2 };
  const now = iso();
  const cur = await env.DB.prepare('SELECT id,status FROM threads_invites WHERE brand_id=? AND lower(username)=?').bind(brandId, username).first<{ id: number; status: string }>();
  if (cur && cur.status in rank) {
    if (rank[status] > rank[cur.status]) await env.DB.prepare('UPDATE threads_invites SET status=?,updated_at=? WHERE id=?').bind(status, now, cur.id).run();
    return { id: cur.id, status: rank[status] > rank[cur.status] ? status : cur.status };
  }
  if (cur) await env.DB.prepare(`UPDATE threads_invites SET status=?,requested_by=?,authorize_started_at=NULL,updated_at=? WHERE id=?`).bind(status, by, now, cur.id).run();
  else await env.DB.prepare('INSERT INTO threads_invites(brand_id,username,status,requested_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(brandId, username, status, by, now, now).run();
  await logEvent(env, brandId, 'info', 'threads_oauth', status === 'requested'
    ? `${by} 申請連結 Threads @${username}：等待服務商在 Meta 送出測試邀請`
    : `${by} 為 @${username} 建立連結申請${status === 'invited' ? '（Meta 邀請已送出，等對方接受）' : '（對方已是測試人員，可直接授權）'}`);
  const row = await env.DB.prepare('SELECT id,status FROM threads_invites WHERE brand_id=? AND lower(username)=?').bind(brandId, username).first<{ id: number; status: string }>();
  return { id: row!.id, status: row!.status };
}
