import { generateThread, QuotaError } from '../ai/gemini';
import { checkParts } from '../ai/compliance';
import { getAccount, listAccounts } from '../threads/accounts';
import { lineAddUrl, lineIdFromUrl } from '../line/links';
import { buildTraffic } from '../attribution';
import { audit, brandBySlug, forBrand, getBrand, getSettings, isMulti, jsonArr } from '../db';
import { withCreds } from '../integrations';
import { handleOps } from './ops';
import { validateLineConfig, parseLineConfig } from '../line/config';
import { needsReview, partsOf, publishOne } from '../threads/scheduler';
import type { Env } from '../types';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../util/crypto';
import { addDays, isValidTimezone, iso, localDate, zonedToUtc } from '../util/time';
import { registerExtra } from './extra';
import { metricSum } from '../metrics';

export interface Actor { id: number; name: string; role: 'admin' | 'staff'; brandId: string }
const SESSION_SEC = 8 * 3600;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const err = (status: number, message: string) => json({ error: message }, status);

function cookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export async function authenticate(env: Env, req: Request, now = Date.now()): Promise<Actor | null> {
  const tok = cookie(req, 'sid');
  if (!tok) return null;
  const v = await verifyToken(env.SESSION_SECRET, tok, Math.floor(now / 1000));
  if (!v || v.p) return null; // 只接受登入 Session（不帶用途標記）
  const u = await env.DB.prepare('SELECT id,authentication_id,role,brand_id FROM admin_users WHERE id=? AND enabled=1').bind(v.uid).first<any>();
  return u ? { id: u.id, name: u.authentication_id, role: u.role, brandId: u.brand_id } : null;
}

type Handler = (c: { env: Env; req: Request; actor: Actor; m: RegExpMatchArray; url: URL; brandId: string }) => Promise<Response>;
const routes: { method: string; re: RegExp; role: 'admin' | 'staff'; h: Handler }[] = [];
const add = (method: string, path: string, role: 'admin' | 'staff', h: Handler) =>
  routes.push({ method, re: new RegExp(`^/api${path}$`), role, h });

/** 依工作區代號找工作區；單一企業部署時可省略代號。 */
async function resolveWorkspace(env: Env, slug: string | null | undefined) {
  if (slug) return brandBySlug(env, slug.trim().toLowerCase());
  return isMulti(env) ? null : getBrand(env).catch(() => null);
}

export async function handleApi(rawEnv: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === '/api/health') {
    const ok = await rawEnv.DB.prepare('SELECT 1 x').first();
    return json({ ok: !!ok });
  }
  if (url.pathname.startsWith('/api/op/')) return handleOps(rawEnv, req);
  if (url.pathname === '/api/public' && req.method === 'GET') {
    const me = await authenticate(rawEnv, req);
    const b = me ? await getBrand(forBrand(rawEnv, me.brandId)) : await resolveWorkspace(rawEnv, url.searchParams.get('w'));
    return json({ name: b?.name ?? null, multi: isMulti(rawEnv) });
  }

  // 變更型請求必須帶自訂標頭（搭配 SameSite=Strict 作 CSRF 防護）
  if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'admin-ui') return err(403, 'forbidden');

  if (url.pathname === '/api/login' && req.method === 'POST') {
    const b: any = await req.json().catch(() => ({}));
    const ws = await resolveWorkspace(rawEnv, b.workspace);
    if (!ws) return err(401, isMulti(rawEnv) && !b.workspace ? '請輸入工作區代號' : '工作區、帳號或密碼錯誤');
    if (ws.status === 'suspended') return err(403, '此工作區已暫停使用，請聯絡服務商');
    return login(forBrand(rawEnv, ws.id), b, ws.id);
  }

  const actor = await authenticate(rawEnv, req);
  if (!actor) return err(401, 'unauthorized');
  // 之後的每個操作都只作用在登入者所屬的工作區
  const env = await withCreds(forBrand(rawEnv, actor.brandId));
  const brand = await getBrand(env);
  if (brand.status === 'suspended') return err(403, '此工作區已暫停使用，請聯絡服務商');
  if (url.pathname === '/api/logout') {
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
  }

  // 留資為加購項目：未開通時，伺服器端直接拒絕所有留資相關操作（不只是隱藏按鈕）
  if (url.pathname.startsWith('/api/inquiries') && !(await getSettings(env, brand.id)).leads_enabled) {
    return err(403, '留資功能尚未開通（加購項目），請聯絡服務商');
  }

  for (const r of routes) {
    const m = url.pathname.match(r.re);
    if (m && r.method === req.method) {
      if (r.role === 'admin' && actor.role !== 'admin') return err(403, 'admin only'); // 伺服器端權限檢查
      return r.h({ env, req, actor, m, url, brandId: brand.id });
    }
  }
  return err(404, 'not found');
}

async function login(env: Env, b: any, brandId: string): Promise<Response> {
  const username = String(b.username ?? '').slice(0, 64);
  const since = new Date(Date.now() - 15 * 60000).toISOString();
  const fails = await env.DB.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE brand_id=? AND action='login_fail' AND detail=? AND created_at>?`)
    .bind(brandId, username, since).first<{ c: number }>();
  if ((fails?.c ?? 0) >= 5) return err(429, '嘗試次數過多，請 15 分鐘後再試');
  const u = await env.DB.prepare('SELECT id,password_hash FROM admin_users WHERE brand_id=? AND authentication_id=? AND enabled=1')
    .bind(brandId, username).first<any>();
  // 帳號不存在時仍做一次雜湊，降低帳號探測
  const ok = u ? await verifyPassword(String(b.password ?? ''), u.password_hash) : (await hashPassword('x'), false);
  if (!ok) { await audit(env, brandId, null, 'login_fail', username); return err(401, isMulti(env) ? '工作區、帳號或密碼錯誤' : '帳號或密碼錯誤'); }
  const tok = await signToken(env.SESSION_SECRET, { uid: u.id, exp: Math.floor(Date.now() / 1000) + SESSION_SEC });
  return json({ ok: true }, 200, { 'set-cookie': `sid=${tok}; Path=/; Max-Age=${SESSION_SEC}; HttpOnly; Secure; SameSite=Strict` });
}

// ---------- 通用 ----------
add('GET', '/me', 'staff', async ({ env, actor, brandId }) => json({ ...actor, leads_enabled: !!(await getSettings(env, brandId)).leads_enabled }));

// 帳號與密碼：改自己的帳號名稱及／或密碼，需輸入目前密碼
add('POST', '/account', 'staff', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id=?').bind(actor.id).first<any>();
  if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) return err(400, '目前密碼錯誤');
  const username = typeof b.username === 'string' ? b.username.trim() : actor.name;
  const next = typeof b.next === 'string' && b.next ? b.next : null;
  if (username === actor.name && !next) return err(400, '沒有需要變更的內容');
  if (username !== actor.name) {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return err(400, '帳號需為 3–32 字英數（可含 . _ -）');
    if (await env.DB.prepare('SELECT 1 FROM admin_users WHERE brand_id=? AND authentication_id=? AND id<>?').bind(brandId, username, actor.id).first()) return err(409, '這個帳號名稱已被使用');
  }
  if (next && next.length < 10) return err(400, '新密碼至少 10 字元');
  if (next && next === String(b.current)) return err(400, '新密碼不能和目前密碼相同');
  await env.DB.prepare('UPDATE admin_users SET authentication_id=?, password_hash=COALESCE(?,password_hash) WHERE id=?')
    .bind(username, next ? await hashPassword(next) : null, actor.id).run();
  await audit(env, brandId, actor.name, 'account_update', username !== actor.name ? `rename:${actor.name}->${username}${next ? ',password' : ''}` : 'password');
  return json({ ok: true, username });
});

add('POST', '/password', 'staff', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id=?').bind(actor.id).first<any>();
  if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) return err(400, '目前密碼錯誤');
  if (String(b.next ?? '').length < 10) return err(400, '新密碼至少 10 字元');
  await env.DB.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').bind(await hashPassword(b.next), actor.id).run();
  await audit(env, brandId, actor.name, 'password_change');
  return json({ ok: true });
});

add('GET', '/dashboard', 'admin', async ({ env, brandId }) => {
  const brand = await getBrand(env);
  const s = await getSettings(env, brandId);
  const dayStart = zonedToUtc(localDate(new Date(), brand.timezone), '00:00', brand.timezone).toISOString();
  const n = async (sql: string, ...a: unknown[]) => (await env.DB.prepare(sql).bind(...a).first<{ c: number }>())?.c ?? 0;
  const accts = await listAccounts(env);
  const invalid = accts.some((a) => a.status !== 'ok') || (!accts.length && s.threads_status !== 'ok');
  return json({
    healthy: !invalid,
    threads_status: invalid ? 'token_invalid' : 'ok',
    threads_accounts: accts.map((a) => ({ id: a.id, username: a.username, status: a.status })),
    configured: {
      threads: accts.length > 0 || !!(env.THREADS_ACCESS_TOKEN && env.THREADS_USER_ID),
      threads_username: accts[0]?.username ?? null,
      line: !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN),
      gemini: !!env.GEMINI_API_KEY,
    },
    posted_today: await n(`SELECT COUNT(*) c FROM posts WHERE brand_id=? AND status='published' AND published_at>=?`, brandId, dayStart),
    pending_drafts: await n(`SELECT COUNT(*) c FROM posts WHERE brand_id=? AND status='draft'`, brandId),
    inquiries_today: await n(`SELECT COUNT(*) c FROM inquiries WHERE brand_id=? AND created_at>=?`, brandId, dayStart),
    inquiries_pending: await n(`SELECT COUNT(*) c FROM inquiries WHERE brand_id=? AND handling_status='pending'`, brandId),
    leads_enabled: !!s.leads_enabled,
    friends_today: await metricSum(env, brandId, 'friend_add', localDate(new Date(), brand.timezone)),
    // 未開通自動接待：好友數來自 LINE 每日統計（隔天才有），首頁改顯示昨天的新好友與今天的點擊
    friends_yesterday: await metricSum(env, brandId, 'friend_add', addDays(localDate(new Date(), brand.timezone), -1), localDate(new Date(), brand.timezone)),
    clicks_today: await metricSum(env, brandId, 'link_click', localDate(new Date(), brand.timezone)),
    line_data: !!env.LINE_CHANNEL_ACCESS_TOKEN,
    handoffs_today: await metricSum(env, brandId, 'handoff', localDate(new Date(), brand.timezone)),
    auto_post_enabled: !!s.auto_post_enabled,
    line_auto_reply_enabled: !!s.line_auto_reply_enabled,
    gen_today: await n('SELECT COUNT(*) c FROM ai_generations WHERE brand_id=? AND created_at>=?', brandId, dayStart),
    gen_limit: s.daily_gen_limit,
  });
});

add('POST', '/pause', 'admin', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const sets: string[] = []; const vals: unknown[] = [];
  if (typeof b.auto_post_enabled === 'boolean') { sets.push('auto_post_enabled=?'); vals.push(b.auto_post_enabled ? 1 : 0); }
  if (typeof b.line_auto_reply_enabled === 'boolean') { sets.push('line_auto_reply_enabled=?'); vals.push(b.line_auto_reply_enabled ? 1 : 0); }
  if (!sets.length) return err(400, 'nothing to update');
  // 防呆：必要連線未完成時不允許開啟自動化
  if (b.auto_post_enabled === true) {
    const s = await getSettings(env, brandId);
    const accts = await listAccounts(env);
    const ok = accts.filter((a) => a.status === 'ok');
    const missing = [
      !env.GEMINI_API_KEY && 'Gemini（AI）',
      accts.length ? !ok.length && 'Threads 授權已失效，請重新連結' : !(env.THREADS_ACCESS_TOKEN && env.THREADS_USER_ID) ? 'Threads' : s.threads_status !== 'ok' && 'Threads 授權已失效，請重新連結',
    ].filter(Boolean);
    if (missing.length) return err(409, `無法開啟自動發文，請先完成：${missing.join('、')}（設定 → 連線）`);
  }
  if (b.line_auto_reply_enabled === true && !(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN)) {
    return err(409, '無法開啟自動接待，請先完成 LINE 連線（設定 → 連線）');
  }
  await env.DB.prepare(`UPDATE brand_settings SET ${sets.join(',')},updated_at=? WHERE brand_id=?`).bind(...vals, iso(), brandId).run();
  await audit(env, brandId, actor.name, 'toggle', JSON.stringify(b));
  return json({ ok: true });
});

// ---------- 設定 ----------
const SETTING_FIELDS = ['services', 'audience', 'content_tone', 'cta_text', 'line_add_url', 'weekly_topic'];

add('GET', '/settings', 'admin', async ({ env, brandId }) => {
  const brand = await getBrand(env);
  const s: any = await getSettings(env, brandId);
  return json({
    brand: { name: brand.name, industry: brand.industry, description: brand.description, timezone: brand.timezone },
    settings: {
      ...Object.fromEntries(SETTING_FIELDS.map((k) => [k, s[k]])),
      content_topics: jsonArr(s.content_topics), banned_words: jsonArr(s.banned_words),
      posting_mode: s.posting_mode, require_review: !!s.require_review, posts_per_day: s.posts_per_day,
      publishing_times: jsonArr(s.publishing_times), daily_gen_limit: s.daily_gen_limit,
      regulated: needsReview(brand.industry, { posting_mode: 'A', require_review: 0 }),
      style_preset: s.style_preset, thread_min: s.thread_min, thread_max: s.thread_max, fact_bank: s.fact_bank,
      line_id: lineIdFromUrl(s.line_add_url),
      line_ready: !!parseLineConfig(s.line_config).serviceInfo && !parseLineConfig(s.line_config).serviceInfo.startsWith('（'),
    },
  });
});

add('PUT', '/settings', 'admin', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  let brandChanged = false;
  const sets: string[] = []; const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col}=?`); vals.push(v); };
  for (const k of SETTING_FIELDS) if (typeof b[k] === 'string') { if (b[k].length > 2000) return err(400, `${k} 過長`); put(k, b[k]); }
  if (b.line_add_url && !/^https:\/\//.test(b.line_add_url)) return err(400, 'LINE 連結需為 https');
  if (b.line_id !== undefined) { // 只填官方帳號 ID（@xxx），自動產生加好友連結
    const u = b.line_id === '' ? '' : lineAddUrl(String(b.line_id));
    if (u === null) return err(400, '官方帳號 ID 格式不正確，例如：@033azwud');
    put('line_add_url', u);
  }
  if (b.style_preset !== undefined) { if (typeof b.style_preset !== 'string' || b.style_preset.length > 500) return err(400, '寫作原則過長'); put('style_preset', b.style_preset); }
  if (b.fact_bank !== undefined) { if (typeof b.fact_bank !== 'string' || b.fact_bank.length > 5000) return err(400, '數據庫不可超過 5000 字'); put('fact_bank', b.fact_bank); }
  if (b.thread_min !== undefined || b.thread_max !== undefined) {
    const mn = Number(b.thread_min), mx = Number(b.thread_max);
    if (!Number.isInteger(mn) || !Number.isInteger(mx) || mn < 1 || mx > 10 || mn > mx) return err(400, '串文則數需為 1 到 10，且最少不可大於最多');
    put('thread_min', mn); put('thread_max', mx);
  }
  if (b.posting_mode !== undefined) { if (!['A', 'B', 'C'].includes(b.posting_mode)) return err(400, '發文模式不合法'); put('posting_mode', b.posting_mode); }
  if (typeof b.require_review === 'boolean') put('require_review', b.require_review ? 1 : 0);
  if (b.posts_per_day !== undefined) {
    if (!Number.isInteger(b.posts_per_day) || b.posts_per_day < 1 || b.posts_per_day > 5) return err(400, '每日發文需為 1–5');
    put('posts_per_day', b.posts_per_day);
  }
  if (b.publishing_times !== undefined) {
    if (!Array.isArray(b.publishing_times) || b.publishing_times.length < 1 || b.publishing_times.length > 5 ||
        b.publishing_times.some((t: any) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return err(400, '發布時間格式需為 HH:MM（1–5 個）');
    put('publishing_times', JSON.stringify([...b.publishing_times].sort()));
  }
  for (const k of ['content_topics', 'banned_words']) if (b[k] !== undefined) {
    if (!Array.isArray(b[k]) || b[k].length > 50 || b[k].some((x: any) => typeof x !== 'string' || x.length > 100)) return err(400, `${k} 不合法`);
    put(k, JSON.stringify(b[k]));
  }
  if (b.timezone !== undefined) {
    if (!isValidTimezone(b.timezone)) return err(400, '時區不合法');
    await env.DB.prepare('UPDATE brands SET timezone=? WHERE id=?').bind(b.timezone, brandId).run();
  }
  for (const k of ['name', 'description'] as const) if (typeof b[k] === 'string') {
    if (!b[k].trim() && k === 'name') return err(400, '品牌名稱不可為空');
    if (b[k].length > 2000) return err(400, `${k} 過長`);
    await env.DB.prepare(`UPDATE brands SET ${k}=? WHERE id=?`).bind(b[k], brandId).run();
    brandChanged = true;
  }
  if (!sets.length && b.timezone === undefined && !brandChanged) return err(400, 'nothing to update');
  if (sets.length) await env.DB.prepare(`UPDATE brand_settings SET ${sets.join(',')},updated_at=? WHERE brand_id=?`).bind(...vals, iso(), brandId).run();
  await audit(env, brandId, actor.name, 'settings_update', Object.keys(b).join(','));
  return json({ ok: true });
});

// ---------- Threads 貼文 ----------
add('GET', '/posts', 'admin', async ({ env, brandId, url }) => {
  const st = url.searchParams.get('status');
  const rows = await env.DB.prepare(
    `SELECT p.id,p.content,p.parts,p.part_ids,p.status,p.scheduled_at,p.published_at,p.threads_post_id,p.error_message,p.approved_by,p.account_id,p.source_post_id,a.username,
       m.views,m.likes,m.replies,(SELECT SUM(l.clicks) FROM post_links l WHERE l.brand_id=p.brand_id AND l.post_id=p.id) clicks,(SELECT SUM(l.uniques) FROM post_links l WHERE l.brand_id=p.brand_id AND l.post_id=p.id) uniques
     FROM posts p LEFT JOIN threads_accounts a ON a.id=p.account_id LEFT JOIN post_metrics m ON m.post_id=p.id
     WHERE p.brand_id=? AND p.status<>'deleted' AND (? IS NULL OR p.status=?) ORDER BY COALESCE(p.scheduled_at,p.created_at) DESC LIMIT 150`,
  ).bind(brandId, st, st).all<any>();
  return json(rows.results.map((r) => ({ ...r, parts: partsOf(r), part_ids: r.part_ids ? JSON.parse(r.part_ids) : [] })));
});

add('POST', '/posts/generate', 'admin', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const topic = String(b.topic ?? '').slice(0, 300);
  const account = b.account_id ? await getAccount(env, Number(b.account_id)) : (await listAccounts(env))[0] ?? null;
  if (b.account_id && !account) return err(404, '找不到這個 Threads 帳號');
  try {
    const g = await generateThread(env, { topic, account });
    // 手動生成一律先成為草稿，待管理員核准
    const r = await env.DB.prepare(
      `INSERT INTO posts(brand_id,account_id,content,parts,status,generation_id,error_message,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).bind(brandId, account?.id ?? null, g.parts[0], JSON.stringify(g.parts), 'draft', g.generationId, g.issues.length ? `內容檢查未通過：${g.issues.join('；')}` : null, iso(), iso()).run();
    await audit(env, brandId, actor.name, 'post_generate');
    return json({ id: r.meta.last_row_id, issues: g.issues, parts: g.parts.length });
  } catch (e) {
    if (e instanceof QuotaError) return err(429, e.message);
    const msg = (e as Error).message;
    // 轉成使用者能採取行動的說明
    if (/HTTP 4\d\d/.test(msg)) return err(502, 'AI 服務拒絕了請求，請到「設定 → AI」確認 API key 是否有效，或稍後再試。');
    if (/HTTP 5\d\d/.test(msg)) return err(502, 'AI 服務暫時無法使用，請稍後再試。既有草稿不受影響。');
    return err(502, `生成失敗：${msg}`);
  }
});

add('PUT', '/posts/(\\d+)', 'admin', async ({ env, req, m, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const parts: string[] = Array.isArray(b.parts) ? b.parts.map((x: unknown) => String(x ?? '').trim()) : typeof b.content === 'string' ? [b.content.trim()] : [];
  if (!parts.length || parts.some((x) => !x)) return err(400, '每一則內容都不可為空');
  if (parts.length > 10) return err(400, '串文最多 10 則');
  const r = await env.DB.prepare(`UPDATE posts SET content=?,parts=?,error_message=NULL,updated_at=? WHERE id=? AND brand_id=? AND status='draft'`)
    .bind(parts[0], JSON.stringify(parts), iso(), m[1], brandId).run();
  if (r.meta.changes !== 1) return err(409, '只有草稿可以修改');
  await audit(env, brandId, actor.name, 'post_edit', m[1]);
  return json({ ok: true });
});

/** 排程時間檢查：不可早於現在（保留 1 分鐘誤差），最多 90 天後。 */
function scheduleTime(v: unknown): Date | string {
  const at = new Date(String(v));
  if (isNaN(at.getTime())) return '時間格式不合法';
  if (at.getTime() < Date.now() - 60_000) return '發布時間已經過去，請選擇之後的時間';
  if (at.getTime() > Date.now() + 90 * 86400000) return '發布時間最多只能排到 90 天後';
  return at;
}

add('POST', '/posts/(\\d+)/approve', 'admin', async ({ env, req, m, actor, brandId }) => {
  const brand = await getBrand(env);
  const s = await getSettings(env, brandId);
  const post = await env.DB.prepare(`SELECT content,parts,scheduled_at,account_id FROM posts WHERE id=? AND brand_id=? AND status='draft'`).bind(m[1], brandId).first<any>();
  if (!post) return err(409, '找不到草稿');
  const issues = checkParts(partsOf(post), { industry: brand.industry, bannedWords: jsonArr(s.banned_words) });
  if (issues.length) return err(422, `內容檢查未通過，請先修改：${issues.join('；')}`);
  const b: any = await req.json().catch(() => ({}));
  let at: Date;
  if (b.scheduled_at) { const t = scheduleTime(b.scheduled_at); if (typeof t === 'string') return err(400, t); at = t; }
  else at = post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now() ? new Date(post.scheduled_at) : new Date(); // 原時段已過就立即排入
  // 指定的帳號已被移除時改用預設帳號（否則排程後會一直發不出去）
  const acct = post.account_id && !(await getAccount(env, post.account_id)) ? null : post.account_id;
  await env.DB.prepare(`UPDATE posts SET status='scheduled',approved_by=?,scheduled_at=?,account_id=?,error_message=NULL,updated_at=? WHERE id=? AND status='draft'`)
    .bind(actor.name, at.toISOString(), acct, iso(), m[1]).run();
  await audit(env, brandId, actor.name, 'post_approve', m[1]);
  const hasAcct = (await listAccounts(env)).length > 0 || !!(env.THREADS_ACCESS_TOKEN && env.THREADS_USER_ID);
  return json({ ok: true, warning: hasAcct ? null : 'Threads 尚未連結，這則貼文會等到連結後才發布' });
});

// 調整已排程（或草稿）的發布時間
add('PUT', '/posts/(\\d+)/schedule', 'admin', async ({ env, req, m, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const t = scheduleTime(b.scheduled_at);
  if (typeof t === 'string') return err(400, t);
  const r = await env.DB.prepare(`UPDATE posts SET scheduled_at=?,updated_at=? WHERE id=? AND brand_id=? AND status IN ('scheduled','draft')`)
    .bind(t.toISOString(), iso(), m[1], brandId).run();
  if (r.meta.changes !== 1) return err(409, '這則貼文已經在發布中或已發布，無法調整時間');
  await audit(env, brandId, actor.name, 'post_reschedule', `${m[1]}:${t.toISOString()}`);
  return json({ ok: true, scheduled_at: t.toISOString() });
});

// 取消排程：退回待審核（保留內容與原本時間，可修改後再核准）
add('POST', '/posts/(\\d+)/unschedule', 'admin', async ({ env, m, actor, brandId }) => {
  // 串文已發出一部分時不可退回草稿（修改後會與已發出的部分對不上）；清掉預先建立的容器，避免修改後發出舊內容
  const r = await env.DB.prepare(`UPDATE posts SET status='draft',approved_by=NULL,threads_creation_id=NULL,updated_at=?
    WHERE id=? AND brand_id=? AND status='scheduled' AND COALESCE(part_ids,'[]')='[]'`).bind(iso(), m[1], brandId).run();
  if (r.meta.changes !== 1) {
    const p = await env.DB.prepare('SELECT status,part_ids FROM posts WHERE id=? AND brand_id=?').bind(m[1], brandId).first<{ status: string; part_ids: string | null }>();
    if (p?.status === 'scheduled') return err(409, '這串已經發出前幾則，無法退回草稿；可以調整時間，或到 Threads 刪除已發出的部分後再刪除這串');
    return err(409, '這則貼文已經在發布中或已發布，無法取消');
  }
  await audit(env, brandId, actor.name, 'post_unschedule', m[1]);
  return json({ ok: true });
});

add('POST', '/posts/(\\d+)/retry', 'admin', async ({ env, m, actor, brandId }) => {
  const r = await env.DB.prepare(`UPDATE posts SET status='scheduled',attempts=0,error_message=NULL,updated_at=? WHERE id=? AND brand_id=? AND status='failed' AND approved_by IS NOT NULL`)
    .bind(iso(), m[1], brandId).run();
  if (r.meta.changes !== 1) return err(409, '無法重試');
  await audit(env, brandId, actor.name, 'post_retry', m[1]);
  return json({ ok: true });
});

// 改寫分發：以目標帳號的人設改寫同一串內容，建立各自的草稿並錯開發布時間
add('POST', '/posts/(\\d+)/distribute', 'admin', async ({ env, req, m, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  const src = await env.DB.prepare(`SELECT * FROM posts WHERE id=? AND brand_id=? AND status<>'deleted'`).bind(m[1], brandId).first<any>();
  if (!src) return err(404, '找不到來源貼文');
  const ids: number[] = Array.isArray(b.account_ids) ? [...new Set(b.account_ids.map(Number))].filter((x) => x !== src.account_id) as number[] : [];
  if (!ids.length) return err(400, '請選擇至少一個其他帳號');
  const base = new Date(src.scheduled_at ?? Date.now()).getTime();
  const created: number[] = []; const issues: string[] = [];
  for (const [k, id] of ids.entries()) {
    const account = await getAccount(env, id);
    if (!account) continue;
    try {
      const g = await generateThread(env, { account, rewriteOf: partsOf(src) });
      const at = new Date(Math.max(base, Date.now()) + (k + 1) * 45 * 60000).toISOString();
      const r = await env.DB.prepare(
        `INSERT INTO posts(brand_id,account_id,source_post_id,content,parts,status,scheduled_at,generation_id,error_message,updated_at,created_at) VALUES(?,?,?,?,?,'draft',?,?,?,?,?)`,
      ).bind(brandId, id, src.id, g.parts[0], JSON.stringify(g.parts), at, g.generationId, g.issues.length ? `內容檢查未通過：${g.issues.join('；')}` : null, iso(), iso()).run();
      created.push(r.meta.last_row_id as number);
      if (g.issues.length) issues.push(`@${account.username}`);
    } catch (e) {
      if (e instanceof QuotaError) return json({ created: created.length, stopped: e.message, flagged: issues });
      return err(502, created.length ? `已建立 ${created.length} 則後中斷：AI 服務暫時無法使用` : 'AI 服務暫時無法使用，請稍後再試');
    }
  }
  await audit(env, brandId, actor.name, 'post_distribute', `${src.id}->${created.join(',')}`);
  return json({ created: created.length, flagged: issues });
});

add('DELETE', '/posts/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
  // 軟刪除，保留 slot_key 以免排程重新產生同一時段
  await env.DB.prepare(`UPDATE posts SET status='deleted',updated_at=? WHERE id=? AND brand_id=? AND status IN ('draft','scheduled','failed','gen_failed')`)
    .bind(iso(), m[1], brandId).run();
  await audit(env, brandId, actor.name, 'post_delete', m[1]);
  return json({ ok: true });
});

// ---------- LINE 設定 / FAQ ----------
add('GET', '/line-config', 'admin', async ({ env, brandId }) => json(parseLineConfig((await getSettings(env, brandId)).line_config)));
add('PUT', '/line-config', 'admin', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => null);
  const e = validateLineConfig(b);
  if (e) return err(400, e);
  await env.DB.prepare('UPDATE brand_settings SET line_config=?,updated_at=? WHERE brand_id=?').bind(JSON.stringify(b), iso(), brandId).run();
  await audit(env, brandId, actor.name, 'line_config_update');
  return json({ ok: true });
});

add('GET', '/faq', 'admin', async ({ env, brandId }) =>
  json((await env.DB.prepare('SELECT id,keyword,response,priority,enabled FROM faq_rules WHERE brand_id=? ORDER BY priority DESC,id').bind(brandId).all()).results));
add('POST', '/faq', 'admin', async ({ env, req, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  if (!b.keyword?.trim() || !b.response?.trim() || b.response.length > 2000) return err(400, '關鍵字與回覆為必填');
  const r = await env.DB.prepare('INSERT INTO faq_rules(brand_id,keyword,response,priority,enabled) VALUES(?,?,?,?,?)')
    .bind(brandId, b.keyword.trim(), b.response.trim(), Number(b.priority) || 0, b.enabled === false ? 0 : 1).run();
  await audit(env, brandId, actor.name, 'faq_create');
  return json({ id: r.meta.last_row_id });
});
add('PUT', '/faq/(\\d+)', 'admin', async ({ env, req, m, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  if (!b.keyword?.trim() || !b.response?.trim()) return err(400, '關鍵字與回覆為必填');
  await env.DB.prepare('UPDATE faq_rules SET keyword=?,response=?,priority=?,enabled=? WHERE id=? AND brand_id=?')
    .bind(b.keyword.trim(), b.response.trim(), Number(b.priority) || 0, b.enabled === false ? 0 : 1, m[1], brandId).run();
  await audit(env, brandId, actor.name, 'faq_update', m[1]);
  return json({ ok: true });
});
add('DELETE', '/faq/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
  await env.DB.prepare('DELETE FROM faq_rules WHERE id=? AND brand_id=?').bind(m[1], brandId).run();
  await audit(env, brandId, actor.name, 'faq_delete', m[1]);
  return json({ ok: true });
});

// ---------- 留資（管理員與客服） ----------
add('GET', '/inquiries', 'staff', async ({ env, actor, brandId, url }) => {
  const q = url.searchParams;
  const status = q.get('status');
  const rows = await env.DB.prepare(
    `SELECT i.id,i.created_at,i.service,i.answers,i.handling_status,c.display_name,c.line_user_id
     FROM inquiries i JOIN contacts c ON c.id=i.contact_id
     WHERE i.brand_id=? AND (? IS NULL OR i.handling_status=?) AND (? IS NULL OR i.created_at>=?) AND (? IS NULL OR i.created_at<?)
     ORDER BY i.created_at DESC LIMIT 200`,
  ).bind(brandId, status, status, q.get('from'), q.get('from'), q.get('to'), q.get('to')).all<any>();
  return json(rows.results.map((r) => ({
    ...r, answers: JSON.parse(r.answers),
    line_user_id: actor.role === 'admin' ? r.line_user_id : undefined, // LINE User ID 僅管理員可見
  })));
});
add('PATCH', '/inquiries/(\\d+)', 'staff', async ({ env, req, m, actor, brandId }) => {
  const b: any = await req.json().catch(() => ({}));
  if (!['pending', 'done'].includes(b.handling_status)) return err(400, '狀態不合法');
  await env.DB.prepare('UPDATE inquiries SET handling_status=? WHERE id=? AND brand_id=?').bind(b.handling_status, m[1], brandId).run();
  await audit(env, brandId, actor.name, 'inquiry_status', `${m[1]}:${b.handling_status}`);
  return json({ ok: true });
});
add('DELETE', '/inquiries/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
  await env.DB.prepare('DELETE FROM inquiries WHERE id=? AND brand_id=?').bind(m[1], brandId).run();
  await audit(env, brandId, actor.name, 'inquiry_delete', m[1]);
  return json({ ok: true });
});

// 資料可攜：工作區管理員可隨時匯出自己的全部資料（不含任何憑證）
add('GET', '/export', 'admin', async ({ env, actor, brandId }) => {
  const q = async (sql: string) => (await env.DB.prepare(sql).bind(brandId).all()).results;
  const data = {
    exported_at: iso(), workspace: await getBrand(env),
    settings: await env.DB.prepare('SELECT * FROM brand_settings WHERE brand_id=?').bind(brandId).first(),
    posts: await q('SELECT * FROM posts WHERE brand_id=?'),
    faq: await q('SELECT * FROM faq_rules WHERE brand_id=?'),
    contacts: await q('SELECT * FROM contacts WHERE brand_id=?'),
    inquiries: await q('SELECT * FROM inquiries WHERE brand_id=?'),
    threads_accounts: await q('SELECT id,threads_user_id,username,persona,tone,topics,posts_per_day,publishing_times,cta_text,auto_post_enabled,created_at FROM threads_accounts WHERE brand_id=?'),
    users: await q('SELECT id,authentication_id,role,enabled FROM admin_users WHERE brand_id=?'),
    audit_logs: await q('SELECT actor,action,detail,created_at FROM audit_logs WHERE brand_id=?'),
  };
  await audit(env, brandId, actor.name, 'data_export');
  return new Response(JSON.stringify(data, null, 2), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="export-${data.workspace.slug ?? brandId}-${iso().slice(0, 10)}.json"` } });
});

// 導流漏斗：曝光 → 互動 → 點擊 LINE 連結 → 新好友 → 轉真人（全部為計數，不含個資）
add('GET', '/funnel', 'admin', async ({ env, url, brandId }) => {
  const brand = await getBrand(env);
  const s = await getSettings(env, brandId);
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const today = localDate(new Date(), brand.timezone);
  const from = day(url.searchParams.get('from')) ?? addDays(today, -29);
  const to = day(url.searchParams.get('to')) ?? addDays(today, 1); // 不含當天
  const fromIso = zonedToUtc(from, '00:00', brand.timezone).toISOString(), toIso = zonedToUtc(to, '00:00', brand.timezone).toISOString();
  const posts = (await env.DB.prepare(
    `SELECT p.id,p.content,p.parts,p.account_id,p.published_at,a.username,m.views,m.likes,m.replies,m.reposts,m.quotes,m.shares,
       (SELECT SUM(l.clicks) FROM post_links l WHERE l.brand_id=p.brand_id AND l.post_id=p.id) clicks,
       (SELECT SUM(l.uniques) FROM post_links l WHERE l.brand_id=p.brand_id AND l.post_id=p.id) uniques
     FROM posts p LEFT JOIN threads_accounts a ON a.id=p.account_id LEFT JOIN post_metrics m ON m.post_id=p.id
     WHERE p.brand_id=? AND p.status='published' AND p.published_at>=? AND p.published_at<? ORDER BY p.published_at DESC LIMIT 500`,
  ).bind(brandId, fromIso, toIso).all<any>()).results;
  const sum = (k: string) => posts.reduce((a, p) => a + (p[k] ?? 0), 0);
  const withMetrics = posts.filter((p) => p.views !== null && p.views !== undefined).length;
  const accts = await listAccounts(env);
  const insights = accts.some((a) => (a as any).insights_status === 'ok') || withMetrics > 0 ? 'ok'
    : accts.some((a) => (a as any).insights_status === 'no_permission') ? 'no_permission' : 'pending';
  // 舊資料可能含有字面上的 \n，一併當作換行
  const first = (p: any) => (partsOf(p)[0] || '').split(/\n|\\n/)[0].trim().slice(0, 80);
  // 導流分析：每篇點擊率、依帳號／時段比較、推估每篇帶來的好友（期間內每日點擊與每日新好友）
  const friendsSource = s.leads_enabled ? 'live' : env.LINE_CHANNEL_ACCESS_TOKEN ? 'daily' : 'none';
  const daily = (await env.DB.prepare('SELECT day,post_id,uniques FROM link_daily WHERE brand_id=? AND day>=? AND day<?')
    .bind(brandId, from, to).all<{ day: string; post_id: number; uniques: number }>()).results;
  const friendsByDay = new Map((await env.DB.prepare(`SELECT day,count FROM metrics_daily WHERE brand_id=? AND name='friend_add' AND day>=? AND day<?`)
    .bind(brandId, from, to).all<{ day: string; count: number }>()).results.map((r) => [r.day, r.count]));
  const traffic = buildTraffic(posts.map((p) => ({ id: p.id, hook: first(p), username: p.username, published_at: p.published_at, views: p.views ?? null, clicks: p.clicks ?? 0, uniques: p.uniques ?? 0 })),
    daily, friendsByDay, brand.timezone, friendsSource !== 'none');
  return json({
    from, to, timezone: brand.timezone, insights, tracking: !!env.PUBLIC_BASE_URL, leads_enabled: !!s.leads_enabled,
    totals: {
      posts: posts.length, posts_with_metrics: withMetrics,
      views: sum('views'), likes: sum('likes'), replies: sum('replies'), reposts: sum('reposts'), quotes: sum('quotes'), shares: sum('shares'),
      clicks: await metricSum(env, brandId, 'link_click', from, to),
      unique_clicks: await metricSum(env, brandId, 'link_unique', from, to),
      friends: await metricSum(env, brandId, 'friend_add', from, to),
      // 新好友的來源：加購客戶即時（Webhook）；其他客戶連接 LINE 數據後每日更新（隔天才有）；都沒有則無法統計
      friends_source: friendsSource,
      handoffs: await metricSum(env, brandId, 'handoff', from, to),
      leads: s.leads_enabled ? ((await env.DB.prepare('SELECT COUNT(*) c FROM inquiries WHERE brand_id=? AND created_at>=? AND created_at<?').bind(brandId, fromIso, toIso).first<{ c: number }>())?.c ?? 0) : null,
    },
    top: [...posts].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || (b.clicks ?? 0) - (a.clicks ?? 0)).slice(0, 5)
      .map((p) => ({ id: p.id, hook: first(p), username: p.username, published_at: p.published_at, views: p.views, likes: p.likes, replies: p.replies, reposts: p.reposts, clicks: p.clicks ?? 0, uniques: p.uniques ?? 0 })),
    traffic,
  });
});

registerExtra(add, json, err);

export { publishOne };
