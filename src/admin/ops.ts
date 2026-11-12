// 營運總後台 API：跨工作區的健康狀態、用量計量、開通與暫停。
// 原則：營運人員只看「計數與狀態」，不讀顧客留資內容等個資。
import type { Env } from '../types';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../util/crypto';
import { iso } from '../util/time';

const SESSION_SEC = 8 * 3600;
const PLATFORM = '_platform'; // audit_logs 的 brand_id，用來記錄營運人員的操作
const json = (d: unknown, status = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const err = (status: number, error: string) => json({ error }, status);
const cookieOf = (req: Request) => (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)osid=([^;]+)/)?.[1] ?? null;
const log = (env: Env, actor: string | null, action: string, detail = '') =>
  env.DB.prepare('INSERT INTO audit_logs(brand_id,actor,action,detail,created_at) VALUES(?,?,?,?,?)').bind(PLATFORM, actor, action, detail, iso()).run();

// 營運人員的登入憑證用獨立金鑰簽發，客戶端的登入憑證無法被拿來冒充營運人員
const opSecret = (env: Env) => `${env.SESSION_SECRET}:operator`;
const randomPassword = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/[+/=]/g, '').slice(0, 14);
const monthStart = (m?: string | null) => (m && /^\d{4}-\d{2}$/.test(m) ? `${m}-01T00:00:00.000Z` : `${iso().slice(0, 7)}-01T00:00:00.000Z`);
const nextMonth = (start: string) => { const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString(); };

async function operator(env: Env, req: Request) {
  const tok = cookieOf(req); if (!tok) return null;
  const v = await verifyToken(opSecret(env), tok, Math.floor(Date.now() / 1000)); if (!v) return null;
  return env.DB.prepare('SELECT id,username,role FROM operators WHERE id=? AND enabled=1').bind(v.uid).first<{ id: number; username: string; role: 'admin' | 'support' }>();
}

export async function handleOps(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.slice('/api/op'.length);
  if (req.method !== 'GET' && req.headers.get('x-requested-with') !== 'admin-ui') return err(403, 'forbidden');

  if (path === '/login' && req.method === 'POST') {
    const b: any = await req.json().catch(() => ({}));
    const username = String(b.username ?? '').slice(0, 64);
    const fails = await env.DB.prepare(`SELECT COUNT(*) c FROM audit_logs WHERE brand_id=? AND action='op_login_fail' AND detail=? AND created_at>?`)
      .bind(PLATFORM, username, new Date(Date.now() - 15 * 60000).toISOString()).first<{ c: number }>();
    if ((fails?.c ?? 0) >= 5) return err(429, '嘗試次數過多，請 15 分鐘後再試');
    const u = await env.DB.prepare('SELECT id,password_hash FROM operators WHERE username=? AND enabled=1').bind(username).first<any>();
    const ok = u ? await verifyPassword(String(b.password ?? ''), u.password_hash) : (await hashPassword('x'), false);
    if (!ok) { await log(env, null, 'op_login_fail', username); return err(401, '帳號或密碼錯誤'); }
    const tok = await signToken(opSecret(env), { uid: u.id, exp: Math.floor(Date.now() / 1000) + SESSION_SEC });
    await log(env, username, 'op_login');
    return json({ ok: true }, 200, { 'set-cookie': `osid=${tok}; Path=/api/op; Max-Age=${SESSION_SEC}; HttpOnly; Secure; SameSite=Strict` });
  }

  const op = await operator(env, req);
  if (!op) return err(401, 'unauthorized');
  if (path === '/logout') return json({ ok: true }, 200, { 'set-cookie': 'osid=; Path=/api/op; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
  if (path === '/me') return json({ username: op.username, role: op.role });

  // 自己變更密碼
  if (path === '/password' && req.method === 'POST') {
    const b: any = await req.json().catch(() => ({}));
    const row = await env.DB.prepare('SELECT password_hash FROM operators WHERE id=?').bind(op.id).first<any>();
    if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) return err(400, '目前密碼錯誤');
    if (String(b.next ?? '').length < 12) return err(400, '新密碼至少 12 字元');
    await env.DB.prepare('UPDATE operators SET password_hash=? WHERE id=?').bind(await hashPassword(b.next), op.id).run();
    await log(env, op.username, 'op_password_change');
    return json({ ok: true });
  }

  // 維護人員（support）只能查看狀態與協助重設客戶密碼；其餘變更限管理者（admin）
  const writes = req.method !== 'GET' && !/^\/tenants\/[a-z0-9-]{2,40}\/reset-admin$/.test(path);
  if (writes && op.role !== 'admin') return err(403, '此操作需要營運管理者權限');

  if (path === '/operators' && req.method === 'GET') {
    if (op.role !== 'admin') return err(403, '此操作需要營運管理者權限');
    return json((await env.DB.prepare('SELECT id,username,role,enabled,created_at FROM operators ORDER BY id').all()).results);
  }
  if (path === '/operators' && req.method === 'POST') {
    const b: any = await req.json().catch(() => ({}));
    const username = String(b.username ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return err(400, '帳號需為 3–32 字英數');
    if (!['admin', 'support'].includes(b.role)) return err(400, '角色不合法');
    const pw = randomPassword();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO operators(username,password_hash,role,created_at) VALUES(?,?,?,?)').bind(username, await hashPassword(pw), b.role, iso()).run();
    if (r.meta.changes !== 1) return err(409, '帳號已存在');
    await log(env, op.username, 'operator_create', `${username}:${b.role}`);
    return json({ username, role: b.role, password: pw }, 201);
  }
  const om = path.match(/^\/operators\/(\d+)$/);
  if (om && req.method === 'PATCH') {
    if (Number(om[1]) === op.id) return err(400, '不能修改自己的帳號狀態或角色');
    const b: any = await req.json().catch(() => ({}));
    const sets: string[] = [], vals: unknown[] = [];
    if (typeof b.enabled === 'boolean') { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0); }
    if (b.role !== undefined) { if (!['admin', 'support'].includes(b.role)) return err(400, '角色不合法'); sets.push('role=?'); vals.push(b.role); }
    if (b.reset_password === true) { const pw = randomPassword(); sets.push('password_hash=?'); vals.push(await hashPassword(pw)); (b as any)._pw = pw; }
    if (!sets.length) return err(400, 'nothing to update');
    const r = await env.DB.prepare(`UPDATE operators SET ${sets.join(',')} WHERE id=?`).bind(...vals, om[1]).run();
    if (!r.meta.changes) return err(404, '找不到人員');
    await log(env, op.username, 'operator_update', `${om[1]}:${JSON.stringify({ enabled: b.enabled, role: b.role, reset: !!b.reset_password })}`);
    return json({ ok: true, password: (b as any)._pw });
  }

  // 所有工作區的健康狀態與本月用量（一次查詢彙總，不逐一開啟工作區）
  if (path === '/tenants' && req.method === 'GET') {
    const ms = monthStart(url.searchParams.get('month')), me = nextMonth(ms);
    const rows = (await env.DB.prepare(
      `SELECT b.id,b.slug,b.name,b.industry,b.status,b.plan,b.created_at,b.last_cron_at,s.auto_post_enabled,s.line_auto_reply_enabled,s.daily_gen_limit,s.leads_enabled,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='friend_add' AND d.day>=? AND d.day<?) friends,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='handoff' AND d.day>=? AND d.day<?) handoffs,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='link_click' AND d.day>=? AND d.day<?) clicks,
        (SELECT COALESCE(SUM(m.views),0) FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE m.brand_id=b.id AND p.published_at>=? AND p.published_at<?) views,
        (SELECT COUNT(*) FROM inquiries i WHERE i.brand_id=b.id AND i.created_at>=? AND i.created_at<?) leads,
        (SELECT COUNT(*) FROM inquiries i WHERE i.brand_id=b.id AND i.handling_status='pending') leads_pending,
        (SELECT COUNT(*) FROM posts p WHERE p.brand_id=b.id AND p.status='published' AND p.published_at>=? AND p.published_at<?) published,
        (SELECT COUNT(*) FROM posts p WHERE p.brand_id=b.id AND p.status IN ('failed','unknown','gen_failed')) post_errors,
        (SELECT COUNT(*) FROM posts p WHERE p.brand_id=b.id AND p.status='draft') drafts,
        (SELECT COUNT(*) FROM ai_generations g WHERE g.brand_id=b.id AND g.created_at>=? AND g.created_at<?) generations,
        (SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM ai_generations g WHERE g.brand_id=b.id AND g.created_at>=? AND g.created_at<?) tokens,
        (SELECT COUNT(*) FROM threads_accounts a WHERE a.brand_id=b.id) threads_accounts,
        (SELECT COUNT(*) FROM threads_accounts a WHERE a.brand_id=b.id AND a.status<>'ok') threads_invalid,
        (SELECT MIN(a.expires_at) FROM threads_accounts a WHERE a.brand_id=b.id) threads_expires,
        (SELECT COUNT(*) FROM integrations x WHERE x.brand_id=b.id AND x.name IN ('line_channel_secret','line_channel_access_token')) line_creds,
        (SELECT COUNT(*) FROM integrations x WHERE x.brand_id=b.id AND x.name='gemini_api_key') gemini_key
       FROM brands b LEFT JOIN brand_settings s ON s.brand_id=b.id ORDER BY b.created_at`,
    ).bind(ms.slice(0, 10), me.slice(0, 10), ms.slice(0, 10), me.slice(0, 10), ms.slice(0, 10), me.slice(0, 10), ms, me, ms, me, ms, me, ms, me, ms, me).all<any>()).results;
    const cronAge = (t: string | null) => (t ? Date.now() - new Date(t).getTime() : Infinity);
    return json({
      month: ms.slice(0, 7),
      tenants: rows.map((r) => {
        const issues: string[] = [];
        if (r.status === 'active') {
          if (r.threads_invalid) issues.push('Threads 授權失效');
          if (!r.threads_accounts) issues.push('未連結 Threads');
          if (r.line_creds < 2) issues.push('未連接 LINE');
          if (r.post_errors) issues.push(`${r.post_errors} 則貼文異常`);
          if (r.auto_post_enabled && cronAge(r.last_cron_at) > 30 * 60000) issues.push('排程超過 30 分鐘未執行');
        }
        return { ...r, leads_enabled: !!r.leads_enabled, line_configured: r.line_creds >= 2, gemini_own_key: !!r.gemini_key, health: r.status !== 'active' ? 'paused' : issues.length ? 'attention' : 'ok', issues };
      }),
    });
  }

  // 計費用量（按合格留資計費的依據）：可指定月份
  if (path === '/usage' && req.method === 'GET') {
    const ms = monthStart(url.searchParams.get('month')), me = nextMonth(ms);
    const rows = (await env.DB.prepare(
      `SELECT b.slug,b.name,b.plan,s.leads_enabled,
        (SELECT COUNT(*) FROM inquiries i WHERE i.brand_id=b.id AND i.created_at>=? AND i.created_at<?) leads,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='friend_add' AND d.day>=? AND d.day<?) friends,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='handoff' AND d.day>=? AND d.day<?) handoffs,
        (SELECT COALESCE(SUM(count),0) FROM metrics_daily d WHERE d.brand_id=b.id AND d.name='link_click' AND d.day>=? AND d.day<?) clicks,
        (SELECT COALESCE(SUM(m.views),0) FROM post_metrics m JOIN posts p ON p.id=m.post_id WHERE m.brand_id=b.id AND p.published_at>=? AND p.published_at<?) views,
        (SELECT COUNT(*) FROM posts p WHERE p.brand_id=b.id AND p.status='published' AND p.published_at>=? AND p.published_at<?) published,
        (SELECT COUNT(*) FROM threads_accounts a WHERE a.brand_id=b.id) threads_accounts,
        (SELECT COUNT(*) FROM ai_generations g WHERE g.brand_id=b.id AND g.created_at>=? AND g.created_at<?) generations
       FROM brands b LEFT JOIN brand_settings s ON s.brand_id=b.id ORDER BY b.slug`,
    ).bind(ms, me, ms.slice(0, 10), me.slice(0, 10), ms.slice(0, 10), me.slice(0, 10), ms.slice(0, 10), me.slice(0, 10), ms, me, ms, me, ms, me).all()).results;
    return json({ month: ms.slice(0, 7), rows });
  }

  // 開通新工作區：建立品牌、設定與第一位管理員，回傳一次性密碼
  if (path === '/tenants' && req.method === 'POST') {
    const b: any = await req.json().catch(() => ({}));
    const slug = String(b.slug ?? '').trim().toLowerCase(), name = String(b.name ?? '').trim();
    const admin = String(b.admin_username ?? 'owner').trim(), industry = String(b.industry ?? 'general');
    if (!/^[a-z0-9-]{2,40}$/.test(slug) || slug.startsWith('_')) return err(400, '工作區代號需為 2–40 字英文小寫、數字或連字號');
    if (!name || name.length > 100) return err(400, '請輸入品牌名稱');
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(admin)) return err(400, '管理員帳號需為 3–32 字英數');
    if (!['general', 'lending', 'finance', 'loan'].includes(industry)) return err(400, '產業類別不合法');
    if (await env.DB.prepare('SELECT 1 FROM brands WHERE slug=? OR id=?').bind(slug, slug).first()) return err(409, '這個工作區代號已被使用');
    const id = slug, now = iso(), pw = randomPassword();
    await env.DB.prepare(`INSERT INTO brands(id,slug,name,industry,description,timezone,created_at,status,plan) VALUES(?,?,?,?,'',?,?,'active',?)`)
      .bind(id, slug, name, industry, String(b.timezone ?? 'Asia/Taipei'), now, String(b.plan ?? 'standard')).run();
    await env.DB.prepare(`INSERT INTO brand_settings(brand_id,updated_at,auto_post_enabled,line_auto_reply_enabled) VALUES(?,?,0,1)`).bind(id, now).run();
    await env.DB.prepare(`INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES(?,'admin',?,?)`).bind(id, admin, await hashPassword(pw)).run();
    await log(env, op.username, 'tenant_create', slug);
    return json({ slug, admin_username: admin, password: pw, login_url: `${url.origin}/?w=${slug}` }, 201);
  }

  const m = path.match(/^\/tenants\/([a-z0-9-]{2,40})$/);
  if (m && req.method === 'PATCH') {
    const b: any = await req.json().catch(() => ({}));
    const sets: string[] = [], vals: unknown[] = [];
    if (b.status !== undefined) { if (!['active', 'suspended'].includes(b.status)) return err(400, '狀態不合法'); sets.push('status=?'); vals.push(b.status); }
    if (b.plan !== undefined) { if (typeof b.plan !== 'string' || b.plan.length > 40) return err(400, '方案不合法'); sets.push('plan=?'); vals.push(b.plan); }
    if (typeof b.leads_enabled === 'boolean') {
      // 加購項目：開通或關閉留資（存在 brand_settings）
      const r = await env.DB.prepare('UPDATE brand_settings SET leads_enabled=? WHERE brand_id=(SELECT id FROM brands WHERE slug=?)').bind(b.leads_enabled ? 1 : 0, m[1]).run();
      if (!r.meta.changes) return err(404, '找不到工作區');
      if (!sets.length) { await log(env, op.username, 'tenant_leads', `${m[1]}:${b.leads_enabled}`); return json({ ok: true }); }
    }
    if (!sets.length) return err(400, 'nothing to update');
    const r = await env.DB.prepare(`UPDATE brands SET ${sets.join(',')} WHERE slug=?`).bind(...vals, m[1]).run();
    if (!r.meta.changes) return err(404, '找不到工作區');
    await log(env, op.username, 'tenant_update', `${m[1]}:${JSON.stringify(b)}`);
    return json({ ok: true });
  }
  // 協助客戶重設管理員密碼（不需要看到任何客戶資料）
  const rp = path.match(/^\/tenants\/([a-z0-9-]{2,40})\/reset-admin$/);
  if (rp && req.method === 'POST') {
    const u = await env.DB.prepare(`SELECT a.id,a.authentication_id FROM admin_users a JOIN brands b ON b.id=a.brand_id WHERE b.slug=? AND a.role='admin' ORDER BY a.id LIMIT 1`).bind(rp[1]).first<any>();
    if (!u) return err(404, '找不到工作區管理員');
    const pw = randomPassword();
    await env.DB.prepare('UPDATE admin_users SET password_hash=?,enabled=1 WHERE id=?').bind(await hashPassword(pw), u.id).run();
    await log(env, op.username, 'tenant_reset_admin', rp[1]);
    return json({ admin_username: u.authentication_id, password: pw });
  }
  return err(404, 'not found');
}
