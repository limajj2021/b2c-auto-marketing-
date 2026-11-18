// 立即發布：草稿（先過內容檢查並核准）或已排程的貼文，不等排程，直接在這次請求發出去。
// 後台「立即發布」按鈕與 AI 連接器共用；用和排程相同的額度保護，串文太長時其餘交給下一輪排程接續。
import { BudgetError, budgeted } from '../budget';
import { audit, getBrand, getSettings, jsonArr } from '../db';
import { checkParts } from '../ai/compliance';
import { iso } from '../util/time';
import { getAccount, resolveCred } from './accounts';
import { partsOf, publishOne } from './scheduler';
import type { Env } from '../types';

export type PublishNowResult =
  | { ok: true; status: 'published' | 'partial'; sent: number; total: number; message?: string }
  | { error: string; status: number };

export async function publishNow(env: Env, brandId: string, actorName: string, id: number): Promise<PublishNowResult> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brandId);
  const post = await env.DB.prepare(`SELECT status,content,parts,account_id FROM posts WHERE id=? AND brand_id=? AND status IN ('draft','scheduled')`).bind(id, brandId).first<any>();
  if (!post) return { status: 409, error: '這則貼文目前不能發布（可能已發出或已刪除）' };
  const issues = checkParts(partsOf(post), { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
  if (issues.length) return { status: 422, error: `內容檢查未通過，請先修改：${issues.join('；')}` };
  const acct = post.account_id && !(await getAccount(env, post.account_id)) ? null : post.account_id;
  if (!(await resolveCred(env, acct))) return { status: 409, error: '這個品牌還沒有可發文的 Threads 帳號（或授權已失效）。請先連結帳號，或改用「手動發到 Threads」。' };
  const now = new Date();
  const r = await env.DB.prepare(`UPDATE posts SET status='scheduled',approved_by=COALESCE(approved_by,?),scheduled_at=?,account_id=?,error_message=NULL,updated_at=? WHERE id=? AND status IN ('draft','scheduled')`)
    .bind(actorName, iso(now), acct, iso(now), id).run();
  if (r.meta.changes !== 1) return { status: 409, error: '這則貼文剛剛被其他動作更新了，請重新整理' };
  await audit(env, brandId, actorName, 'post_publish_now', String(id));
  try { await publishOne(budgeted(env, 38), id, now); } catch (e) { if (!(e instanceof BudgetError)) throw e; }
  const after = await env.DB.prepare('SELECT status,error_message,part_ids,parts FROM posts WHERE id=?').bind(id).first<any>();
  const sent = after?.part_ids ? JSON.parse(after.part_ids).length : 0, total = partsOf(after).length;
  if (after?.status === 'published') return { ok: true, status: 'published', sent, total };
  if (after?.status === 'scheduled' && sent > 0) return { ok: true, status: 'partial', sent, total, message: `已發出 ${sent}/${total} 則，其餘會在 5 分鐘內自動接續` };
  const why = after?.error_message || '發布沒有完成，請到「系統紀錄」查看原因';
  return { status: 502, error: after?.status === 'scheduled' ? `發布失敗：${why}（系統會在 5 分鐘內自動重試）` : `發布失敗：${why}` };
}
