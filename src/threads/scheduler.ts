import { QuotaError, generateThread } from '../ai/gemini';
import { getBrand, getSettings } from '../db';
import type { Env, Post, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { addDays, iso, localDate, zonedToUtc } from '../util/time';
import { effective, listAccounts, markAccount, resolveCred, type Account } from './accounts';
import { ThreadsApiError, ThreadsUnknownError, createContainer, listRecent, notReady, postInsights, publishContainer, timing } from './api';
import { BudgetError, canAfford, reserveDb } from '../budget';
import { trackedParts } from '../links';
import { autoTag, effectiveTag } from './topic';
import { renewLineTokenIfNeeded } from '../line/token';
import { syncLineFollowers } from '../line/insights';
import { logEvent } from '../log';
import { collectHistory, ideate } from '../ai/ideate';

const MAX_PUBLISH_ATTEMPTS = 3;
/** 發一則大約要用的請求數（建立＋發布＋2 次寫入，再加重試的餘裕） */
const PER_PART = 6;
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
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { if (e instanceof BudgetError) throw e; await logEvent(env, brand.id, 'error', 'cron', `排程步驟「${name}」發生錯誤：${(e as Error).message}`); }
  };
  // 每個工作區每小時清理一次（各自計時；工作區很多、輪替處理時也不會漏掉）
  const lastHk = brand.last_housekeeping_at ? new Date(brand.last_housekeeping_at).getTime() : 0;
  if (now.getTime() - lastHk >= 3600_000) await step('housekeeping', () => housekeeping(env, now));
  // 額度有限時的優先順序：先核對與發布，再生成新草稿。
  // 自動發文關閉時：仍然發布「有人核准」的貼文（那是明確的發布意圖），只停止 AI 生成與 AI 自動核准的貼文
  const auto = !!(s.auto_post_enabled || s.auto_fresh_enabled);
  const pending = auto || !!(await env.DB.prepare(`SELECT 1 FROM posts WHERE brand_id=? AND status IN ('scheduled','publishing','unknown') LIMIT 1`).bind(brand.id).first());
  if (pending) {
    await step('reconcile', () => reconcile(env, now));
    await step('publish', () => publishDue(env, now, !auto));
  }
  if (auto) await step('generate', () => ensureSlots(env, now));
  await step('insights', () => refreshInsights(env, now));
}

async function housekeeping(env: Env, now: Date) {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  await env.DB.prepare('DELETE FROM inquiries WHERE brand_id=? AND created_at<?').bind(brand.id, new Date(now.getTime() - s.retention_days * 86400000).toISOString()).run();
  await env.DB.prepare('DELETE FROM processed_events WHERE brand_id=? AND processed_at<?').bind(brand.id, new Date(now.getTime() - 7 * 86400000).toISOString()).run();
  await env.DB.prepare(`UPDATE posts SET status='gen_failed', updated_at=? WHERE brand_id=? AND status='generating' AND updated_at<?`).bind(iso(now), brand.id, new Date(now.getTime() - STALE_MS).toISOString()).run();
  await env.DB.prepare('UPDATE brands SET last_housekeeping_at=? WHERE id=?').bind(iso(now), brand.id).run();
  await syncLineFollowers(env, now).catch(async (e) => { if (e instanceof BudgetError) throw e; await logEvent(env, brand.id, 'error', 'line_insights', `取得 LINE 好友數失敗：${(e as Error).message}`); });
  // LINE token（系統自動申請者）到期前更新；失敗不影響其他清理，下一小時再試
  await renewLineTokenIfNeeded(env, now).catch(async (e) => {
    if (e instanceof BudgetError) throw e;
    await logEvent(env, brand.id, 'error', 'line_token', `LINE 發訊憑證自動更新失敗，下一小時再試：${(e as Error).message}`);
  });
}

/** 為每個啟用中的帳號，在今天與明天的每個時段確保有一串貼文（slot_key 唯一約束防重複）。 */
export async function ensureSlots(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const accts = (await listAccounts(env)).filter((a) => a.status === 'ok' && a.auto_post_enabled);
  const targets: (Account | null)[] = accts.length ? accts : [null]; // 無帳號表時沿用舊版單帳號
  // 全自動發文：每個帳號每天 1 篇、先找沒寫過的題材、寫完直接排程（受監管產業與內容檢查沒過的仍留草稿）
  const fresh = !!s.auto_fresh_enabled;
  const review = fresh ? REGULATED_INDUSTRIES.includes(brand.industry) : needsReview(brand.industry, s);
  const today = localDate(now, brand.timezone);
  let shared = 0;
  for (const a of targets) {
    const e = effective(a, s);
    const offset = a && !a.publishing_times ? (shared++) * STAGGER_MIN * 60000 : 0;
    const times = e.times.slice(0, fresh ? 1 : e.postsPerDay);
    for (const day of [today, addDays(today, 1)]) {
      for (let i = 0; i < times.length; i++) {
        const at = new Date(zonedToUtc(day, times[i], brand.timezone).getTime() + offset);
        if (at.getTime() < now.getTime() - 3600_000) continue;
        const slot = `${day}#${i}${a ? `@a${a.id}` : ''}`;
        // 先確認額度再佔位：佔位後才發現額度不足，會留下沒人處理的「生成中」貼文
        if (!canAfford(env, fresh ? 16 : 10)) return; // 生成一串約需 8～10 次請求，不夠就留到下一輪
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
          let idea: string | null = null;
          if (fresh) {
            const found = await ideate(env, brand, s, a, await collectHistory(env, brand.id, a), now);
            if (!found) throw new Error('這次找不到跟過去不重複的題材，稍後再試');
            idea = `${found.topic}｜${found.angle}`;
          }
          const topic = idea ? `${idea}（這是這個帳號從沒寫過的題材／觀點，整串都圍繞這個核心觀點，不要寫成老生常談）` : s.posting_mode === 'C' ? s.weekly_topic : '';
          const g = await generateThread(env, { topic, account: a }, now);
          const status = g.issues.length || review ? 'draft' : 'scheduled';
          await env.DB.prepare(`UPDATE posts SET content=?,parts=?,status=?,topic_tag=?,generation_id=?,approved_by=?,error_message=?,idea=?,updated_at=? WHERE id=?`)
            .bind(g.parts[0], JSON.stringify(g.parts), status, s.topic_tag ? null : g.tag || null, g.generationId, status === 'scheduled' ? 'auto' : null,
              g.issues.length ? `內容檢查未通過：${g.issues.join('；')}` : null, idea, iso(now), postId).run();
        } catch (err) {
          if (err instanceof BudgetError) {
            // 額度在生成途中用完：把佔位還原成可重試狀態（用保留額度寫入），下一輪再生成
            await reserveDb(env).prepare(`UPDATE posts SET status='gen_failed',updated_at=? WHERE id=? AND status='generating'`).bind(iso(now), postId).run().catch(() => {});
            throw err;
          }
          if (err instanceof QuotaError) {
            await env.DB.prepare(`DELETE FROM posts WHERE id=? AND status='generating'`).bind(postId).run();
            await logEvent(env, brand.id, 'warn', 'threads_generate', `AI 生成額度已達上限，暫停生成：${err.message}`, undefined, { throttleMinutes: 360 });
            return; // 額度不足：停止本輪，保留既有草稿
          }
          await env.DB.prepare(`UPDATE posts SET status='gen_failed',gen_attempts=gen_attempts+1,error_message=?,updated_at=? WHERE id=?`)
            .bind(String((err as Error).message).slice(0, 300), iso(now), postId).run();
          await logEvent(env, brand.id, 'error', 'threads_generate', `AI 生成失敗（貼文 #${postId}）：${(err as Error).message}`, { account: a?.username ?? null });
        }
      }
    }
  }
}

export async function publishDue(env: Env, now: Date, humanOnly = false): Promise<void> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  const accts = await listAccounts(env);
  if (!accts.length && s.threads_status === 'token_invalid') return;
  const due = await env.DB.prepare(
    `SELECT p.id,p.parts,p.part_ids,p.content FROM posts p LEFT JOIN threads_accounts a ON a.id=p.account_id
     WHERE p.brand_id=? AND p.status='scheduled' AND p.scheduled_at<=? AND (p.account_id IS NULL OR a.status='ok')
       AND (?=0 OR COALESCE(p.approved_by,'auto')<>'auto')
     ORDER BY p.scheduled_at LIMIT 3`,
  ).bind(brand.id, iso(now), humanOnly ? 1 : 0).all<{ id: number; parts: string | null; part_ids: string | null; content: string }>();
  for (const r of due.results) {
    // 每則 = 建立 + 發布 2 次對外呼叫 + 2 次寫入；另有搶佔、讀取、追蹤連結、憑證、收尾約 12 次。額度不夠就留到下一輪，不會發到一半
    // 長串文一輪的額度可能不夠：至少夠發幾則就開始，發不完的下一輪從斷點接續（每則都會記錄，不會重複發）
    const need = (partsOf(r).length - idsOf(r).length) * 4 + 12;
    if (!canAfford(env, Math.min(need, PER_PART + 12))) return;
    await publishOne(env, r.id, now);
  }
}

/** 發布一則或一整串；每發出一則就記錄 ID，中斷後從下一則接續，不會重複發已發出的部分。 */
export async function publishOne(env: Env, id: number, now: Date): Promise<void> {
  const claim = await env.DB.prepare(
    `UPDATE posts SET status='publishing',attempts=attempts+1,updated_at=? WHERE id=? AND status='scheduled' AND approved_by IS NOT NULL AND content<>''`,
  ).bind(iso(now), id).run();
  if (claim.meta.changes !== 1) return;
  const post = (await env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(id).first<Post>())!;
  const ids = idsOf(post);
  const parts = await trackedParts(env, post, partsOf(post)); // LINE 連結換成追蹤短連結
  const setErr = (status: string, msg: string) => env.DB.prepare('UPDATE posts SET status=?,error_message=?,updated_at=? WHERE id=?').bind(status, msg.slice(0, 300), iso(now), id).run();
  const cred = await resolveCred(env, post.account_id);
  if (!cred) {
    await setErr('failed', '發文帳號未連結或授權已失效，請到「設定 → Threads」重新連結後重試');
    await logEvent(env, post.brand_id, 'error', 'threads_publish', `貼文 #${id} 無法發布：發文帳號未連結或授權已失效`);
    return;
  }

  try {
    for (let i = ids.length; i < parts.length; i++) {
      // 這一輪的額度不夠再發一則：已發出的都記下了，退回排程，下一輪從這一則接續（不算失敗）
      if (i > 0 && !canAfford(env, PER_PART + 4)) {
        await reserveDb(env).prepare(`UPDATE posts SET status='scheduled',attempts=MAX(attempts-1,0),error_message=?,updated_at=? WHERE id=? AND status='publishing'`)
          .bind(`已發出 ${ids.length}/${parts.length} 則，其餘會在下一輪排程（5 分鐘內）接續`, iso(now), id).run();
        return;
      }
      let creation = i === ids.length ? post.threads_creation_id : null;
      if (!creation) {
        // 主題標籤只放在第 1 則（每篇最多 1 個）
        const bs = i === 0 ? await getSettings(env, post.brand_id) : null;
        const tag = bs ? effectiveTag(post.topic_tag, bs.topic_tag, autoTag((await getBrand(env)).name)) : '';
        creation = await createContainer(cred, parts[i], i > 0 ? ids[i - 1] : undefined, tag || undefined);
        await env.DB.prepare('UPDATE posts SET threads_creation_id=? WHERE id=?').bind(creation, id).run();
      }
      // 剛建立的 container 偶爾還沒準備好：等一下再發，最多再試 2 次；還是不行就丟掉這個 container，下一輪重新建立
      let pubId: string | undefined;
      for (let t = 0; ; t++) {
        try { pubId = await publishContainer(cred, creation); break; } catch (e) {
          if (notReady(e) && t < 2) { await timing.sleep(t ? 3000 : 1500); continue; }
          if (notReady(e)) await env.DB.prepare('UPDATE posts SET threads_creation_id=NULL WHERE id=?').bind(id).run();
          throw e;
        }
      }
      ids.push(pubId!);
      // 已發出的 ID 一定要記下（即使額度剛好用完），否則下次會重複發同一則
      await reserveDb(env).prepare('UPDATE posts SET part_ids=?,threads_post_id=?,threads_creation_id=NULL WHERE id=?').bind(JSON.stringify(ids), ids[0], id).run();
    }
    await env.DB.prepare(`UPDATE posts SET status='published',published_at=?,error_message=NULL,updated_at=? WHERE id=?`).bind(iso(now), iso(now), id).run();
    await logEvent(env, post.brand_id, 'info', 'threads_publish', `貼文 #${id} 已發布（${parts.length} 則）${cred.username ? ` @${cred.username}` : ''}`, { threads_post_id: ids[0] });
  } catch (e) {
    if (e instanceof BudgetError) {
      // 額度檢查已事先預留，理論上不會發生；若發生，已發出的部分都已記錄，退回排程讓下一輪接續
      await reserveDb(env).prepare(`UPDATE posts SET status='scheduled',updated_at=? WHERE id=? AND status='publishing'`).bind(iso(now), id).run().catch(() => {});
      throw e;
    }
    const n = ids.length + 1, chain = parts.length > 1;
    await logEvent(env, post.brand_id, e instanceof ThreadsUnknownError ? 'warn' : 'error', 'threads_publish',
      `貼文 #${id} 第 ${n} 則發布失敗${cred.username ? `（@${cred.username}）` : ''}：${(e as Error).message}`,
      { kind: e instanceof ThreadsUnknownError ? 'unknown' : e instanceof ThreadsApiError ? (e.tokenInvalid ? 'token_invalid' : e.permission ? 'permission' : 'api') : 'other', published_parts: ids.length, total_parts: parts.length });
    if (e instanceof ThreadsUnknownError) {
      // 第一則結果未知 → 交給 reconcile 核對；串文中途未知 → 請人工確認，避免重複
      if (!ids.length) await setErr('unknown', `結果未知，待核對：${e.message}`);
      else await setErr('failed', `第 ${n} 則結果未知，請到 Threads 確認是否已發出；未發出可按「重試」從第 ${n} 則接續`);
    } else if (e instanceof ThreadsApiError) {
      if (e.tokenInvalid) { await markAccount(env, cred.accountId, 'token_invalid'); await setErr('scheduled', `Threads 授權失效，請重新連結：${e.message}`); }
      else if (notReady(e)) await setErr(post.attempts >= MAX_PUBLISH_ATTEMPTS ? 'failed' : 'scheduled', `${chain ? `第 ${n} 則` : '貼文'}：Threads 暫時還沒準備好（${e.message}），${post.attempts >= MAX_PUBLISH_ATTEMPTS ? `請按「從第 ${n} 則接續發布」` : '系統會在 5 分鐘內自動接續'}`);
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
    const ids = idsOf(p), parts = await trackedParts(env, p, partsOf(p));
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
    await logEvent(env, brand.id, 'info', 'threads_reconcile', hit ? `貼文 #${p.id} 核對結果：已在 Threads 上，標記為已發出` : `貼文 #${p.id} 核對結果：Threads 上找不到，${p.attempts >= MAX_PUBLISH_ATTEMPTS ? '標記失敗' : '重新排入'}`);
  }
}

/** 補抓近 14 天已發布貼文的成效數據（每 6 小時更新一次）。沒有權限的帳號會被標記，重新連結後再試。 */
export async function refreshInsights(env: Env, now: Date): Promise<void> {
  const brand = await getBrand(env);
  const rows = (await env.DB.prepare(
    `SELECT p.id,p.account_id,p.threads_post_id FROM posts p
       LEFT JOIN post_metrics m ON m.post_id=p.id LEFT JOIN threads_accounts a ON a.id=p.account_id
     WHERE p.brand_id=? AND p.status='published' AND p.threads_post_id IS NOT NULL AND p.published_at>=?
       AND (m.fetched_at IS NULL OR m.fetched_at<?) AND (p.account_id IS NULL OR (a.status='ok' AND a.insights_status<>'no_permission'))
     ORDER BY COALESCE(m.fetched_at,'') LIMIT 5`,
  ).bind(brand.id, new Date(now.getTime() - 14 * 86400000).toISOString(), new Date(now.getTime() - 6 * 3600000).toISOString())
    .all<{ id: number; account_id: number | null; threads_post_id: string }>()).results;
  for (const r of rows) {
    if (!canAfford(env, 4)) return;
    const cred = await resolveCred(env, r.account_id);
    if (!cred) continue;
    const m = await postInsights(cred, r.threads_post_id);
    if (m === null) {
      if (cred.accountId) await env.DB.prepare(`UPDATE threads_accounts SET insights_status='no_permission' WHERE id=?`).bind(cred.accountId).run();
      await logEvent(env, brand.id, 'warn', 'threads_insights', `@${cred.username ?? ''} 沒有成效數據權限：請在 Meta App 加入 threads_manage_insights 後重新連結`, undefined, { throttleMinutes: 360 });
      continue;
    }
    if (cred.accountId) await env.DB.prepare(`UPDATE threads_accounts SET insights_status='ok' WHERE id=? AND insights_status<>'ok'`).bind(cred.accountId).run();
    await env.DB.prepare(
      `INSERT INTO post_metrics(post_id,brand_id,views,likes,replies,reposts,quotes,shares,fetched_at) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(post_id) DO UPDATE SET views=excluded.views,likes=excluded.likes,replies=excluded.replies,reposts=excluded.reposts,quotes=excluded.quotes,shares=excluded.shares,fetched_at=excluded.fetched_at`,
    ).bind(r.id, brand.id, m.views ?? 0, m.likes ?? 0, m.replies ?? 0, m.reposts ?? 0, m.quotes ?? 0, m.shares ?? 0, iso(now)).run();
  }
}
