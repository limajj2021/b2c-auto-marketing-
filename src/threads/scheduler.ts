import { QuotaError, generateThread } from '../ai/gemini';
import { getBrand, getSettings } from '../db';
import type { Env, Post, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { addDays, iso, localDate, zonedToUtc } from '../util/time';
import { effective, listAccounts, markAccount, resolveCred, type Account } from './accounts';
import { ThreadsApiError, ThreadsUnknownError, createContainer, listRecent, publishContainer } from './api';

const MAX_PUBLISH_ATTEMPTS = 3;
const MAX_GEN_ATTEMPTS = 3;
const STALE_MS = 10 * 60 * 1000;
const STAGGER_MIN = 20; // 多帳號共用預設時段時，依序錯開分鐘數，避免同時發文

export function needsReview(industry: string, s: Pick<Settings, 'posting_mode' | 'require_review'>): boolean {
  if (REGULATED_INDUSTRIES.includes(industry)) return true; // 受監管產業強制人工審核
  if (s.posting_mode === 'B') return true;
  if (s.posting_mode === 'C') return !!s.require_review;
  return false;
}

export const partsOf = (p: Pick<Post, 'parts' | 'content'>): string[] => {
  try { const a = JSON.parse(p.parts ?? 'null'); if (Array.isArray(a) && a.length) return a.map(String); } catch { /* legacy */ }
  return [p.content];
};
const idsOf = (p: Pick<Post, 'part_ids'>): string[] => { try { const a = JSON.parse(p.part_ids ?? '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

/** Cron 入口（每 5 分鐘）。每個步驟獨立 try/catch，單一失敗不影響其他。 */
export async function runCron(env: Env, now = new Date()): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error(`cron:${name}`, (e as Error).message); } };
  await step('housekeeping', () => housekeeping(env, now));
  if (!s.auto_post_enabled) return; // 暫停：不生成、不發布
  await step('reconcile', () => reconcile(env, now));
  await step('generate', () => ensureSlots(env, now));
  await step('publish', () => publishDue(env, now));
}

async function housekeeping(env: Env, now: Date) {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  await env.DB.prepare('DELETE FROM inquiries WHERE brand_id=? AND created_at<?').bind(brand.id, new Date(now.getTime() - s.retention_days * 86400000).toISOString()).run();
  await env.DB.prepare('DELETE FROM processed_events WHERE brand_id=? AND processed_at<?').bind(brand.id, new Date(now.getTime() - 7 * 86400000).toISOString()).run();
  await env.DB.prepare(`UPDATE posts SET status='gen_failed', updated_at=? WHERE status='generating' AND updated_at<?`).bind(iso(now), new Date(now.getTime() - STALE_MS).toISOString()).run();
}

/** 為每個啟用中的帳號，在今天與明天的每個時段確保有一串貼文（slot_key 唯一約束防重複）。 */
export async function ensureSlots(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const accts = (await listAccounts(env)).filter((a) => a.status === 'ok' && a.auto_post_enabled);
  const targets: (Account | null)[] = accts.length ? accts : [null]; // 無帳號表時沿用舊版單帳號
  const review = needsReview(brand.industry, s);
  const today = localDate(now, brand.timezone);
  let shared = 0;
  for (const a of targets) {
    const e = effective(a, s);
    const offset = a && !a.publishing_times ? (shared++) * STAGGER_MIN * 60000 : 0;
    const times = e.times.slice(0, e.postsPerDay);
    for (const day of [today, addDays(today, 1)]) {
      for (let i = 0; i < times.length; i++) {
        const at = new Date(zonedToUtc(day, times[i], brand.timezone).getTime() + offset);
        if (at.getTime() < now.getTime() - 3600_000) continue;
        const slot = `${day}#${i}${a ? `@a${a.id}` : ''}`;
        const ins = await env.DB.prepare(`INSERT OR IGNORE INTO posts(brand_id,account_id,status,slot_key,scheduled_at,updated_at,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind(brand.id, a?.id ?? null, 'generating', slot, at.toISOString(), iso(now), iso(now)).run();
        let postId: number | null = ins.meta.changes === 1 ? (ins.meta.last_row_id as number) : null;
        if (postId === null) {
          const row = await env.DB.prepare(`SELECT id FROM posts WHERE brand_id=? AND slot_key=? AND status='gen_failed' AND gen_attempts<?`).bind(brand.id, slot, MAX_GEN_ATTEMPTS).first<{ id: number }>();
          if (!row) continue;
          const c = await env.DB.prepare(`UPDATE posts SET status='generating',updated_at=? WHERE id=? AND status='gen_failed'`).bind(iso(now), row.id).run();
          if (c.meta.changes !== 1) continue;
          postId = row.id;
        }
        try {
          const g = await generateThread(env, { topic: s.posting_mode === 'C' ? s.weekly_topic : '', account: a }, now);
          const status = g.issues.length || review ? 'draft' : 'scheduled';
          await env.DB.prepare(`UPDATE posts SET content=?,parts=?,status=?,generation_id=?,approved_by=?,error_message=?,updated_at=? WHERE id=?`)
            .bind(g.parts[0], JSON.stringify(g.parts), status, g.generationId, status === 'scheduled' ? 'auto' : null,
              g.issues.length ? `內容檢查未通過：${g.issues.join('；')}` : null, iso(now), postId).run();
        } catch (err) {
          if (err instanceof QuotaError) {
            await env.DB.prepare(`DELETE FROM posts WHERE id=? AND status='generating'`).bind(postId).run();
            console.warn('cron:quota', err.message);
            return; // 額度不足：停止本輪，保留既有草稿
          }
          await env.DB.prepare(`UPDATE posts SET status='gen_failed',gen_attempts=gen_attempts+1,error_message=?,updated_at=? WHERE id=?`)
            .bind(String((err as Error).message).slice(0, 300), iso(now), postId).run();
        }
      }
    }
  }
}

export async function publishDue(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const accts = await listAccounts(env);
  if (!accts.length && s.threads_status === 'token_invalid') return;
  const due = await env.DB.prepare(
    `SELECT p.id FROM posts p LEFT JOIN threads_accounts a ON a.id=p.account_id
     WHERE p.brand_id=? AND p.status='scheduled' AND p.scheduled_at<=? AND (p.account_id IS NULL OR a.status='ok')
     ORDER BY p.scheduled_at LIMIT 3`,
  ).bind(brand.id, iso(now)).all<{ id: number }>();
  for (const r of due.results) await publishOne(env, r.id, now);
}

/** 發布一則或一整串；每發出一則就記錄 ID，中斷後從下一則接續，不會重複發已發出的部分。 */
export async function publishOne(env: Env, id: number, now: Date): Promise<void> {
  const claim = await env.DB.prepare(
    `UPDATE posts SET status='publishing',attempts=attempts+1,updated_at=? WHERE id=? AND status='scheduled' AND approved_by IS NOT NULL AND content<>''`,
  ).bind(iso(now), id).run();
  if (claim.meta.changes !== 1) return;
  const post = (await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first<Post>())!;
  const parts = partsOf(post), ids = idsOf(post);
  const setErr = (status: string, msg: string) => env.DB.prepare('UPDATE posts SET status=?,error_message=?,updated_at=? WHERE id=?').bind(status, msg.slice(0, 300), iso(now), id).run();
  const cred = await resolveCred(env, post.account_id);
  if (!cred) { await setErr('failed', '發文帳號未連結或授權已失效，請到「設定 → Threads」重新連結後重試'); return; }

  try {
    for (let i = ids.length; i < parts.length; i++) {
      let creation = i === ids.length ? post.threads_creation_id : null;
      if (!creation) {
        creation = await createContainer(cred, parts[i], i > 0 ? ids[i - 1] : undefined);
        await env.DB.prepare('UPDATE posts SET threads_creation_id=? WHERE id=?').bind(creation, id).run();
      }
      ids.push(await publishContainer(cred, creation));
      await env.DB.prepare('UPDATE posts SET part_ids=?,threads_post_id=?,threads_creation_id=NULL WHERE id=?').bind(JSON.stringify(ids), ids[0], id).run();
    }
    await env.DB.prepare(`UPDATE posts SET status='published',published_at=?,error_message=NULL,updated_at=? WHERE id=?`).bind(iso(now), iso(now), id).run();
  } catch (e) {
    const n = ids.length + 1, chain = parts.length > 1;
    if (e instanceof ThreadsUnknownError) {
      // 第一則結果未知 → 交給 reconcile 核對；串文中途未知 → 請人工確認，避免重複
      if (!ids.length) await setErr('unknown', `結果未知，待核對：${e.message}`);
      else await setErr('failed', `第 ${n} 則結果未知，請到 Threads 確認是否已發出；未發出可按「重試」從第 ${n} 則接續`);
    } else if (e instanceof ThreadsApiError) {
      if (e.tokenInvalid) { await markAccount(env, cred.accountId, 'token_invalid'); await setErr('scheduled', `Threads 授權失效，請重新連結：${e.message}`); }
      else if (chain && ids.length && e.permission) await setErr('failed', `串文需要 threads_manage_replies 權限：請在 Meta App 加入此權限並重新連結，再按「重試」從第 ${n} 則接續`);
      else await setErr(post.attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : 'scheduled', chain ? `第 ${n} 則：${e.message}` : e.message);
    } else await setErr('failed', (e as Error).message);
  }
}

/** 核對「結果未知」與卡在 publishing 的貼文。 */
export async function reconcile(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const rows = await env.DB.prepare(`SELECT * FROM posts WHERE brand_id=? AND (status='unknown' OR (status='publishing' AND updated_at<?))`)
    .bind(brand.id, new Date(now.getTime() - STALE_MS).toISOString()).all<Post>();
  for (const p of rows.results) {
    const parts = partsOf(p), ids = idsOf(p);
    const upd = (status: string, msg: string | null) => env.DB.prepare('UPDATE posts SET status=?,error_message=?,updated_at=? WHERE id=?').bind(status, msg, iso(now), p.id).run();
    if (ids.length) { await upd('failed', `第 ${ids.length + 1} 則狀態不明，請到 Threads 確認；未發出可按「重試」接續`); continue; }
    const cred = await resolveCred(env, p.account_id);
    if (!cred) continue;
    const recent = await listRecent(cred); // 失敗則丟出，狀態不變，下輪再試
    const hit = recent.find((r) => (r.text ?? '').trim() === parts[0].trim());
    if (hit) {
      await env.DB.prepare('UPDATE posts SET part_ids=?,threads_post_id=?,threads_creation_id=NULL,updated_at=? WHERE id=?').bind(JSON.stringify([hit.id]), hit.id, iso(now), p.id).run();
      if (parts.length > 1) await upd('scheduled', null); // 首則已發出，繼續發後面的串文
      else await env.DB.prepare(`UPDATE posts SET status='published',published_at=?,error_message=NULL WHERE id=?`).bind(hit.timestamp ?? iso(now), p.id).run();
    } else await upd(p.attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : 'scheduled', '核對後平台無此貼文，重新排入');
  }
}
