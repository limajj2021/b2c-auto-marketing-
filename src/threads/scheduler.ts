import { QuotaError, generatePost } from '../ai/gemini';
import { getBrand, getSettings, jsonArr } from '../db';
import type { Env, Post, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { addDays, iso, localDate, zonedToUtc } from '../util/time';
import { ThreadsApiError, ThreadsUnknownError, createContainer, listRecent, publishContainer } from './api';
import { checkContent } from '../ai/compliance';

const MAX_PUBLISH_ATTEMPTS = 3;
const MAX_GEN_ATTEMPTS = 3;
const STALE_MS = 10 * 60 * 1000;

export function needsReview(industry: string, s: Pick<Settings, 'posting_mode' | 'require_review'>): boolean {
  if (REGULATED_INDUSTRIES.includes(industry)) return true; // 受監管產業強制人工審核
  if (s.posting_mode === 'B') return true;
  if (s.posting_mode === 'C') return !!s.require_review;
  return false;
}

/** Cron 入口（每 5 分鐘）。每個步驟獨立 try/catch，單一失敗不影響其他。 */
export async function runCron(env: Env, now = new Date()): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { console.error(`cron:${name}`, (e as Error).message); }
  };
  await step('housekeeping', () => housekeeping(env, now));
  if (!s.auto_post_enabled) return; // 暫停：不生成、不發布
  await step('reconcile', () => reconcile(env, now));
  await step('generate', () => ensureSlots(env, now));
  await step('publish', () => publishDue(env, now));
}

async function housekeeping(env: Env, now: Date) {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const cutoff = new Date(now.getTime() - s.retention_days * 86400000).toISOString();
  await env.DB.prepare('DELETE FROM inquiries WHERE brand_id=? AND created_at<?').bind(brand.id, cutoff).run();
  await env.DB.prepare('DELETE FROM processed_events WHERE brand_id=? AND processed_at<?')
    .bind(brand.id, new Date(now.getTime() - 7 * 86400000).toISOString()).run();
  await env.DB.prepare(
    `UPDATE posts SET status='gen_failed', updated_at=? WHERE status='generating' AND updated_at<?`,
  ).bind(iso(now), new Date(now.getTime() - STALE_MS).toISOString()).run();
}

/** 為今天與明天的每個發文時段確保有一筆貼文（slot_key 唯一約束防重複）。 */
export async function ensureSlots(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const times = jsonArr(s.publishing_times).slice(0, s.posts_per_day);
  const today = localDate(now, brand.timezone);
  const review = needsReview(brand.industry, s);

  for (const day of [today, addDays(today, 1)]) {
    for (let i = 0; i < times.length; i++) {
      const at = zonedToUtc(day, times[i], brand.timezone);
      if (at.getTime() < now.getTime() - 3600_000) continue; // 已過期超過 1 小時的時段不補發
      const slot = `${day}#${i}`;
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO posts(brand_id,status,slot_key,scheduled_at,updated_at,created_at) VALUES(?,?,?,?,?,?)`,
      ).bind(brand.id, 'generating', slot, at.toISOString(), iso(now), iso(now)).run();
      let postId: number | null = ins.meta.changes === 1 ? (ins.meta.last_row_id as number) : null;
      if (postId === null) {
        // 既有 gen_failed 且未超過重試次數 → 原子性搶回
        const row = await env.DB.prepare(`SELECT id FROM posts WHERE brand_id=? AND slot_key=? AND status='gen_failed' AND gen_attempts<?`)
          .bind(brand.id, slot, MAX_GEN_ATTEMPTS).first<{ id: number }>();
        if (!row) continue;
        const c = await env.DB.prepare(`UPDATE posts SET status='generating',updated_at=? WHERE id=? AND status='gen_failed'`)
          .bind(iso(now), row.id).run();
        if (c.meta.changes !== 1) continue;
        postId = row.id;
      }
      try {
        const topic = s.posting_mode === 'C' ? s.weekly_topic : '';
        const g = await generatePost(env, topic, now);
        const issues = checkContent(g.text, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
        const status = issues.length || review ? 'draft' : 'scheduled';
        await env.DB.prepare(
          `UPDATE posts SET content=?,status=?,generation_id=?,approved_by=?,error_message=?,updated_at=? WHERE id=?`,
        ).bind(g.text, status, g.generationId, status === 'scheduled' ? 'auto' : null,
          issues.length ? `內容檢查未通過：${issues.join('；')}` : null, iso(now), postId).run();
      } catch (e) {
        if (e instanceof QuotaError) {
          // 額度不足：移除空白佔位並停止本輪，保留既有草稿
          await env.DB.prepare(`DELETE FROM posts WHERE id=? AND status='generating'`).bind(postId).run();
          console.warn('cron:quota', e.message);
          return;
        }
        await env.DB.prepare(
          `UPDATE posts SET status='gen_failed',gen_attempts=gen_attempts+1,error_message=?,updated_at=? WHERE id=?`,
        ).bind(String((e as Error).message).slice(0, 300), iso(now), postId).run();
      }
    }
  }
}

export async function publishDue(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  if (s.threads_status === 'token_invalid') return;
  const due = await env.DB.prepare(
    `SELECT id FROM posts WHERE brand_id=? AND status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 3`,
  ).bind(brand.id, iso(now)).all<{ id: number }>();
  for (const r of due.results) await publishOne(env, r.id, now);
}

export async function publishOne(env: Env, id: number, now: Date): Promise<void> {
  const brand = await getBrand(env);
  // 原子性搶佔：同時兩個 cron / 手動觸發只會有一個成功
  const claim = await env.DB.prepare(
    `UPDATE posts SET status='publishing',attempts=attempts+1,updated_at=?
     WHERE id=? AND status='scheduled' AND approved_by IS NOT NULL AND content<>''`,
  ).bind(iso(now), id).run();
  if (claim.meta.changes !== 1) return;
  const post = (await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first<Post>())!;
  const setErr = (status: string, msg: string) =>
    env.DB.prepare('UPDATE posts SET status=?,error_message=?,updated_at=? WHERE id=?').bind(status, msg.slice(0, 300), iso(now), id).run();

  try {
    let creation = post.threads_creation_id;
    if (!creation) {
      creation = await createContainer(env, post.content);
      await env.DB.prepare('UPDATE posts SET threads_creation_id=? WHERE id=?').bind(creation, id).run();
    }
    const threadsId = await publishContainer(env, creation);
    await env.DB.prepare(`UPDATE posts SET status='published',threads_post_id=?,published_at=?,error_message=NULL,updated_at=? WHERE id=?`)
      .bind(threadsId, iso(now), iso(now), id).run();
  } catch (e) {
    if (e instanceof ThreadsUnknownError) {
      // 請求可能已生效：不重試，交由 reconcile 先核對平台結果
      await setErr('unknown', `結果未知，待核對：${e.message}`);
    } else if (e instanceof ThreadsApiError) {
      if (e.tokenInvalid) {
        await env.DB.prepare(`UPDATE brand_settings SET threads_status='token_invalid' WHERE brand_id=?`).bind(brand.id).run();
        await setErr('scheduled', `Threads 憑證失效，請重新授權：${e.message}`);
      } else {
        await setErr(post.attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : 'scheduled', e.message);
      }
    } else {
      await setErr('failed', (e as Error).message);
    }
  }
}

/** 核對「結果未知」與卡在 publishing 的貼文：平台已有 → 標記已發布；否則允許重試。 */
export async function reconcile(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const rows = await env.DB.prepare(
    `SELECT * FROM posts WHERE brand_id=? AND (status='unknown' OR (status='publishing' AND updated_at<?))`,
  ).bind(brand.id, new Date(now.getTime() - STALE_MS).toISOString()).all<Post>();
  if (!rows.results.length) return;
  const recent = await listRecent(env); // 核對失敗則丟出，狀態維持不變，下輪再試
  for (const p of rows.results) {
    const hit = recent.find((r) => (r.text ?? '').trim() === p.content.trim());
    if (hit) {
      await env.DB.prepare(`UPDATE posts SET status='published',threads_post_id=?,published_at=?,error_message=NULL,updated_at=? WHERE id=?`)
        .bind(hit.id, hit.timestamp ?? iso(now), iso(now), p.id).run();
    } else {
      await env.DB.prepare(`UPDATE posts SET status=?,error_message=?,updated_at=? WHERE id=?`)
        .bind(p.attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : 'scheduled', '核對後平台無此貼文，重新排入', iso(now), p.id).run();
    }
  }
}
