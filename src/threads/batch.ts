// 批量排程（多帳號共用貼文池）：後台與 MCP 共用。
// assign：每篇只發一次，輪流分給選的帳號；copy：每篇發到每個選的帳號（同一段文字，可能被 Threads 視為重複內容）。
// 時間：從 start（或現在）開始，每篇間隔 intervalMin 分鐘；0 代表全部同一時間。
import { checkParts } from '../ai/compliance';
import { audit, getBrand, getSettings, jsonArr } from '../db';
import { listAccounts } from './accounts';
import { partsOf } from './scheduler';
import { iso } from '../util/time';
import type { Env } from '../types';

export const BATCH_MAX = 50;

export interface BatchInput { postIds: unknown; accountIds: number[]; mode?: unknown; intervalMin?: unknown; start?: Date | null }
export type BatchResult =
  | { ok: true; scheduled: number; per_account: Record<string, number>; first_at: string; last_at: string; skipped: { id: number; reason: string }[]; plan: { post_id: number; account: string; at: string; copy: boolean }[] }
  | { ok: false; status: number; error: string };

export function checkStart(v: unknown): Date | string {
  const at = v instanceof Date ? v : new Date(String(v));
  if (isNaN(at.getTime())) return '時間格式不合法';
  if (at.getTime() < Date.now() - 60_000) return '發布時間已經過去，請選擇之後的時間';
  if (at.getTime() > Date.now() + 90 * 86400000) return '發布時間最多只能排到 90 天後';
  return at;
}

export async function batchSchedule(env: Env, brandId: string, actorName: string, b: BatchInput): Promise<BatchResult> {
  const fail = (status: number, error: string): BatchResult => ({ ok: false, status, error });
  const postIds = [...new Set((Array.isArray(b.postIds) ? b.postIds : []).map(Number).filter((x: number) => Number.isInteger(x) && x > 0))] as number[];
  if (!postIds.length) return fail(400, '請至少選一篇草稿');
  if (postIds.length > BATCH_MAX) return fail(400, `一次最多 ${BATCH_MAX} 篇`);
  const mode = b.mode === 'copy' ? 'copy' : 'assign';
  const interval = Number(b.intervalMin ?? 30);
  if (!Number.isInteger(interval) || interval < 0 || interval > 1440) return fail(400, '間隔需為 0 到 1440 分鐘');
  let start = new Date();
  if (b.start) { const t = checkStart(b.start); if (typeof t === 'string') return fail(400, t); start = t; }
  const all = await listAccounts(env);
  const want = new Set(b.accountIds);
  const accts = all.filter((a) => want.has(a.id) && a.status === 'ok');
  if (!accts.length) return fail(400, all.length ? '請至少選一個可以發文的 Threads 帳號' : '這個品牌還沒有連結 Threads 帳號');
  const brand = await getBrand(env), s = await getSettings(env, brandId);
  const rows = (await env.DB.prepare(`SELECT * FROM posts WHERE brand_id=? AND status='draft' AND id IN (${postIds.map(() => '?').join(',')})`).bind(brandId, ...postIds).all<any>()).results;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skipped: { id: number; reason: string }[] = [];
  const ready: any[] = [];
  for (const id of postIds) {
    const r = byId.get(id);
    if (!r) { skipped.push({ id, reason: '不是待審核的草稿' }); continue; }
    const issues = checkParts(partsOf(r), { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
    if (issues.length) { skipped.push({ id, reason: issues.join('；') }); continue; }
    ready.push(r);
  }
  if (!ready.length) return fail(422, `沒有可以排程的草稿：${skipped.map((x) => `#${x.id} ${x.reason}`).join('；')}`);
  const plan: { post: any; acct: typeof accts[number]; copy: boolean }[] = [];
  ready.forEach((p, i) => {
    if (mode === 'assign') plan.push({ post: p, acct: accts[i % accts.length], copy: false });
    else accts.forEach((a, j) => plan.push({ post: p, acct: a, copy: j > 0 }));
  });
  const at = (k: number) => new Date(start.getTime() + k * interval * 60000).toISOString();
  const per: Record<string, number> = {};
  const out: { post_id: number; account: string; at: string; copy: boolean }[] = [];
  for (const [k, x] of plan.entries()) {
    let id = x.post.id as number;
    if (x.copy) {
      const r = await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,source_post_id,content,parts,status,topic_tag,scheduled_at,approved_by,seen_at,updated_at,created_at) VALUES(?,?,?,?,?,'scheduled',?,?,?,?,?,?)`)
        .bind(brandId, x.acct.id, x.post.id, x.post.content, x.post.parts, x.post.topic_tag, at(k), actorName, iso(), iso(), iso()).run();
      id = r.meta.last_row_id as number;
    } else {
      await env.DB.prepare(`UPDATE posts SET status='scheduled',account_id=?,scheduled_at=?,approved_by=?,error_message=NULL,seen_at=COALESCE(seen_at,?),updated_at=? WHERE id=? AND status='draft'`)
        .bind(x.acct.id, at(k), actorName, iso(), iso(), x.post.id).run();
    }
    per['@' + x.acct.username] = (per['@' + x.acct.username] ?? 0) + 1;
    out.push({ post_id: id, account: '@' + x.acct.username, at: at(k), copy: x.copy });
  }
  await audit(env, brandId, actorName, 'post_batch_schedule', `${mode}:${ready.map((r) => r.id).join(',')}→${accts.map((a) => a.id).join(',')}`);
  return { ok: true, scheduled: plan.length, per_account: per, first_at: at(0), last_at: at(plan.length - 1), skipped, plan: out };
}
