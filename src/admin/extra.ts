// 連線設定（LINE / Gemini / Threads）與帳號管理。由 routes.ts 註冊。
import { LineCredError, issueLineToken } from '../line/token';
import { normUsername, requestInvite } from '../threads/invites';
import { LINK_DAYS, makeConnectLink } from '../threads/connectlink';
import { SOURCES, logEvent } from '../log';
import { lineAddUrl } from '../line/links';
import { MenuError, currentDefault, decodeImage, normalize, publishMenu, removeMenu, type MenuConfig } from '../line/richmenu';
import { audit, getBrand, getSettings, isMulti } from '../db';
import { credStatus, deleteCreds, getMeta, setCred } from '../integrations';
import { buildAuthorizeUrl, oauthConfigured } from '../threads/oauth';
import { credFor, getAccount, listAccounts, publicAccount, removeAccounts, resolveCred } from '../threads/accounts';
import { iso } from '../util/time';
import { geminiFetch } from '../budget';
import type { Env } from '../types';
import { hashPassword } from '../util/crypto';
import { fill, normKeywords, parsePostUrl, rank, type Template } from '../patrol';
import { postLink } from '../ai/gemini';
import { PERSONAL_TTL, randomToken, sha256 } from '../mcp/oauth';
import type { Actor } from './routes';

type Ctx = { env: Env; req: Request; actor: Actor; m: RegExpMatchArray; url: URL; brandId: string };
type Add = (method: string, path: string, role: 'admin' | 'staff', h: (c: Ctx) => Promise<Response>) => void;
type J = (data: unknown, status?: number) => Response;
type E = (status: number, message: string) => Response;

const GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

/** chatMode：'chat' 代表官方帳號的「聊天」功能開啟中（真人聊天與自動回覆可能同時出現） */
async function lineInfo(token: string): Promise<{ ok: boolean; name?: string; basicId?: string; chatMode?: string }> {
  const r = await fetch('https://api.line.me/v2/bot/info', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { ok: false };
  const b: any = await r.json();
  return { ok: true, name: b.displayName, basicId: b.basicId, chatMode: b.chatMode };
}

/** 把 LINE Webhook 指向本系統並用 LINE 官方測試驗證 */
async function setWebhook(env: Env, token: string, origin: string): Promise<{ set: boolean; verified: boolean; endpoint: string }> {
  const ws = await getBrand(env);
  const endpoint = isMulti(env) ? `${origin}/line/webhook/${ws.slug}` : `${origin}/line/webhook`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const set = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { method: 'PUT', headers: auth, body: JSON.stringify({ endpoint }) });
  let verified = false;
  if (set.ok) {
    const t = await fetch('https://api.line.me/v2/bot/channel/webhook/test', { method: 'POST', headers: auth, body: JSON.stringify({ endpoint }) });
    verified = t.ok && ((await t.json().catch(() => ({}))) as any).success === true;
  }
  return { set: set.ok, verified, endpoint };
}
/** 還沒設定加好友連結時，用官方帳號 ID 自動帶入 */
async function fillLineUrl(env: Env, brandId: string, basicId: string): Promise<void> {
  await env.DB.prepare(`UPDATE brand_settings SET line_add_url=? WHERE brand_id=? AND COALESCE(line_add_url,'')=''`).bind(lineAddUrl(basicId), brandId).run();
}

export function registerExtra(add: Add, json: J, err: E) {
  add('GET', '/integrations', 'admin', async ({ env, url, brandId }) => {
    const st = await credStatus(env);
    const accts = await listAccounts(env);
    return json({
      line: { configured: st.line_channel_secret.set && st.line_channel_access_token.set, webhook_url: isMulti(env) ? `${url.origin}/line/webhook/${(await getBrand(env)).slug}` : `${url.origin}/line/webhook`, name: st.line_channel_access_token.meta.name ?? null, auto_token: !!st.line_channel_access_token.meta.auto, basic_id: st.line_channel_access_token.meta.basic_id ?? null, chat_mode: st.line_channel_access_token.meta.chat_mode ?? null, auto_reply: !!(await getSettings(env, brandId)).leads_enabled },
      gemini: { configured: st.gemini_api_key.set },
      threads: {
        configured: accts.length > 0,
        username: accts[0]?.username ?? null,
        expires_at: accts[0]?.expires_at ?? null,
        accounts: accts.map(publicAccount),
        oauth_available: oauthConfigured(env),
        requires_invite: env.THREADS_APP_MODE !== 'live',
        invites: (await env.DB.prepare(`SELECT id,username,status,authorize_started_at,updated_at FROM threads_invites WHERE brand_id=? AND status IN ('requested','invited','accepted') ORDER BY id`).bind(brandId).all()).results,
      },
    });
  });

  // 貼上 LINE 憑證 → 取得／驗證 token → 設定 Webhook → 用 LINE 官方測試驗證簽章
  // 建議：只貼 Channel ID + secret，系統自動申請 token 並在到期前更新；也接受自行發行的 long-lived token
  add('POST', '/integrations/line', 'admin', async ({ env, req, actor, url, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const secret = String(b.channel_secret ?? '').replace(/\s+/g, '');
    const channelId = String(b.channel_id ?? '').replace(/\s+/g, '');
    let token = String(b.channel_access_token ?? '').replace(/\s+/g, '');
    if (!/^[0-9a-f]{32}$/i.test(secret)) return err(400, 'Channel secret 應為 32 位英數字');
    let meta: Record<string, unknown> = {};
    if (!token) {
      if (!/^\d{6,12}$/.test(channelId)) return err(400, 'Channel ID 應為 10 位左右的數字');
      try {
        const t = await issueLineToken(channelId, secret);
        token = t.token; meta = { auto: true, expires_at: t.expiresAt };
      } catch (e) {
        await logEvent(env, brandId, 'error', 'line_connect', `以 Channel ID 取得 LINE 憑證失敗：${(e as Error).message}`, { channel_id: channelId });
        return err(e instanceof LineCredError ? 400 : 502, (e as Error).message);
      }
    } else if (token.length < 50) return err(400, 'Channel access token 看起來不完整');
    const info = await lineInfo(token);
    if (!info.ok) {
      await logEvent(env, brandId, 'error', 'line_connect', 'LINE 拒絕了這組 access token（讀取官方帳號資料失敗）');
      return err(400, 'Access token 無效，LINE 拒絕了這組憑證');
    }
    await setCred(env, brandId, 'line_channel_secret', secret);
    await setCred(env, brandId, 'line_channel_access_token', token, { ...meta, name: info.name, basic_id: info.basicId, chat_mode: info.chatMode ?? null });
    if (meta.auto) await setCred(env, brandId, 'line_channel_id', channelId);
    else await deleteCreds(env, ['line_channel_id']); // 改用自行發行的 token：不再自動更新
    // 只開通「導流」的客戶：只讀取好友數，不接管訊息（官方帳號自己的自動回應照常運作）
    const addon = !!(await getSettings(env, brandId)).leads_enabled;
    if (!addon && !info.basicId) { /* 沒有 basic ID 也能用，只是無法自動帶入加好友連結 */ }
    if (info.basicId) await fillLineUrl(env, brandId, info.basicId);
    const wh = addon ? await setWebhook(env, token, url.origin) : null;
    await audit(env, brandId, actor.name, 'integration_line');
    await logEvent(env, brandId, !wh || wh.verified ? 'info' : 'warn', 'line_connect',
      !wh ? `已連接 LINE「${info.name}」數據（只讀取好友數，不回覆訊息）`
        : wh.verified ? `已連接 LINE「${info.name}」，自動接待 Webhook 驗證通過` : wh.set ? `已連接 LINE「${info.name}」，但 Webhook 測試未通過：請到 LINE Developers 開啟 Use webhook` : `已連接 LINE「${info.name}」，但設定 Webhook 網址失敗`,
      { auto_token: !!meta.auto, auto_reply: addon });
    return json({ ok: true, bot: info.name, basic_id: info.basicId ?? null, chat_mode: info.chatMode ?? null, mode: addon ? 'auto_reply' : 'data', webhook_set: wh?.set ?? false, webhook_verified: wh?.verified ?? false });
  });

  // 開通「LINE 自動接待」加購後：把 Webhook 指向本系統（需已連接 LINE）
  add('POST', '/integrations/line/webhook', 'admin', async ({ env, actor, url, brandId }) => {
    if (!(await getSettings(env, brandId)).leads_enabled) return err(403, 'LINE 自動接待為加購項目，請聯絡服務商開通');
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return err(409, '請先在「設定 → LINE 官方帳號」連接 LINE');
    const wh = await setWebhook(env, env.LINE_CHANNEL_ACCESS_TOKEN, url.origin);
    await audit(env, brandId, actor.name, 'integration_line_webhook');
    await logEvent(env, brandId, wh.verified ? 'info' : 'warn', 'line_connect', wh.verified ? '自動接待 Webhook 已設定並驗證通過' : '自動接待 Webhook 設定未完成：請到 LINE Developers 開啟 Use webhook');
    return json({ ok: true, webhook_set: wh.set, webhook_verified: wh.verified });
  });

  // ---- AI 連接器（MCP）：已連接的 AI、中斷連線、Codex 連線金鑰 ----
  add('GET', '/mcp/connections', 'admin', async ({ env, brandId }) => {
    const rows = (await env.DB.prepare(`SELECT t.client_id,t.client_name,t.user_id,u.authentication_id username,MIN(t.created_at) since,MAX(t.last_used_at) last_used,
        MAX(CASE WHEN t.kind='personal' THEN 1 ELSE 0 END) personal, MAX(t.expires_at) expires_at
      FROM oauth_tokens t JOIN admin_users u ON u.id=t.user_id
      WHERE t.brand_id=? AND t.revoked=0 AND t.expires_at>? AND t.kind IN ('refresh','personal')
      GROUP BY t.client_id,t.user_id ORDER BY since DESC`).bind(brandId, iso()).all()).results;
    return json(rows.map((r: any) => ({ ...r, personal: !!r.personal })));
  });
  add('DELETE', '/mcp/connections/([A-Za-z0-9_-]{3,60})/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
    const r = await env.DB.prepare('UPDATE oauth_tokens SET revoked=1 WHERE brand_id=? AND client_id=? AND user_id=? AND revoked=0').bind(brandId, m[1], m[2]).run();
    if (!r.meta.changes) return err(404, '找不到這個連線');
    await audit(env, brandId, actor.name, 'mcp_disconnect', m[1]);
    return json({ ok: true });
  });
  // Codex 這類工具可以直接用連線金鑰（只顯示一次，90 天有效，只對應目前這個品牌）
  add('POST', '/mcp/tokens', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const name = String(b.name ?? '').trim().slice(0, 40) || 'Codex';
    const tok = 'ego_' + randomToken(32), cid = 'personal_' + randomToken(6);
    await env.DB.prepare('INSERT INTO oauth_tokens(token_hash,kind,client_id,client_name,user_id,brand_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .bind(await sha256(tok), 'personal', cid, `${name}（連線金鑰）`, actor.id, brandId, new Date(Date.now() + PERSONAL_TTL * 1000).toISOString(), iso()).run();
    await audit(env, brandId, actor.name, 'mcp_token_create', name);
    return json({ token: tok, days: PERSONAL_TTL / 86400 });
  });

  // ---- 半自動海巡：固定回覆範本 ----
  const tplRow = (r: any): Template => ({ id: r.id, title: r.title, keywords: JSON.parse(r.keywords || '[]'), reply: r.reply, enabled: !!r.enabled, uses: r.uses });
  const tplBody = async (req: Request) => {
    const b: any = await req.json().catch(() => ({}));
    const reply = String(b.reply ?? '').trim(), title = String(b.title ?? '').trim().slice(0, 40), keywords = normKeywords(b.keywords);
    if (!reply) return { error: '請填寫回覆內容' };
    if ([...reply].length > 500) return { error: '回覆最多 500 字（Threads 的上限）' };
    return { reply, title, keywords, enabled: b.enabled === undefined ? true : !!b.enabled };
  };
  add('GET', '/patrol/templates', 'staff', async ({ env, brandId }) => {
    const rows = (await env.DB.prepare('SELECT * FROM patrol_templates WHERE brand_id=? ORDER BY enabled DESC, uses DESC, id').bind(brandId).all()).results;
    return json(rows.map(tplRow));
  });
  add('POST', '/patrol/templates', 'admin', async ({ env, req, actor, brandId }) => {
    const b = await tplBody(req); if ('error' in b) return err(400, b.error!);
    const n = await env.DB.prepare('SELECT COUNT(*) c FROM patrol_templates WHERE brand_id=?').bind(brandId).first<{ c: number }>();
    if ((n?.c ?? 0) >= 50) return err(400, '範本最多 50 個');
    const r = await env.DB.prepare('INSERT INTO patrol_templates(brand_id,title,keywords,reply,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind(brandId, b.title, JSON.stringify(b.keywords), b.reply, b.enabled ? 1 : 0, iso(), iso()).run();
    await audit(env, brandId, actor.name, 'patrol_template_add', String(r.meta.last_row_id));
    return json({ ok: true, id: r.meta.last_row_id });
  });
  add('PUT', '/patrol/templates/(\\d+)', 'admin', async ({ env, req, m, actor, brandId }) => {
    const b = await tplBody(req); if ('error' in b) return err(400, b.error!);
    const r = await env.DB.prepare('UPDATE patrol_templates SET title=?,keywords=?,reply=?,enabled=?,updated_at=? WHERE id=? AND brand_id=?')
      .bind(b.title, JSON.stringify(b.keywords), b.reply, b.enabled ? 1 : 0, iso(), m[1], brandId).run();
    if (r.meta.changes !== 1) return err(404, '找不到範本');
    await audit(env, brandId, actor.name, 'patrol_template_edit', m[1]);
    return json({ ok: true });
  });
  add('DELETE', '/patrol/templates/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
    const r = await env.DB.prepare('DELETE FROM patrol_templates WHERE id=? AND brand_id=?').bind(m[1], brandId).run();
    if (r.meta.changes !== 1) return err(404, '找不到範本');
    await audit(env, brandId, actor.name, 'patrol_template_delete', m[1]);
    return json({ ok: true });
  });
  // 貼上別人的貼文 → 推薦範本（已套好連結與品牌名），並告訴你這篇是不是已經回過
  add('POST', '/patrol/match', 'staff', async ({ env, req, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const p = parsePostUrl(b.url);
    if (!p) return err(400, '請貼上 Threads 貼文的網址（在貼文按「分享 → 複製連結」）');
    const [brand, s] = await Promise.all([getBrand(env), getSettings(env, brandId)]);
    const rows = (await env.DB.prepare('SELECT * FROM patrol_templates WHERE brand_id=?').bind(brandId).all()).results.map(tplRow);
    const done = await env.DB.prepare('SELECT replied_by,created_at FROM patrol_log WHERE brand_id=? AND shortcode=?').bind(brandId, p.shortcode).first<{ replied_by: string; created_at: string }>();
    const vars = { line: postLink(s) || '', brand: brand.name };
    return json({ ...p, replied: done ? { by: done.replied_by, at: done.created_at } : null,
      templates: rank(rows, String(b.text ?? '').slice(0, 2000)).map((t) => ({ id: t.id, title: t.title, hits: t.hits, reply: fill(t.reply, vars) })) });
  });
  // 按下「開啟 Threads 回覆」時記錄，之後貼同一篇會提醒已回覆過
  add('POST', '/patrol/log', 'staff', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const p = parsePostUrl(b.url); if (!p) return err(400, '網址不正確');
    const tid = Number(b.template_id) || null;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO patrol_log(brand_id,shortcode,author,template_id,replied_by,created_at) VALUES(?,?,?,?,?,?)')
      .bind(brandId, p.shortcode, p.author, tid, actor.name, iso()).run();
    if (r.meta.changes && tid) await env.DB.prepare('UPDATE patrol_templates SET uses=uses+1 WHERE id=? AND brand_id=?').bind(tid, brandId).run();
    return json({ ok: true });
  });

  // ---- LINE 圖文選單 ----
  const loadMenu = async (env: Env, brandId: string): Promise<MenuConfig | null> => {
    const r = await env.DB.prepare('SELECT rich_menu FROM brand_settings WHERE brand_id=?').bind(brandId).first<{ rich_menu: string }>();
    try { const c = JSON.parse(r?.rich_menu || '{}'); return c && c.layout ? c : null; } catch { return null; }
  };
  const saveMenu = (env: Env, brandId: string, c: MenuConfig | null) =>
    env.DB.prepare('UPDATE brand_settings SET rich_menu=? WHERE brand_id=?').bind(c ? JSON.stringify(c) : '{}', brandId).run();

  add('GET', '/line/richmenu', 'admin', async ({ env, brandId }) => {
    const cfg = await loadMenu(env, brandId);
    const live = env.LINE_CHANNEL_ACCESS_TOKEN ? await currentDefault(env) : null;
    return json({ connected: !!env.LINE_CHANNEL_ACCESS_TOKEN, config: cfg, active: !!(cfg?.id && live === cfg.id), other_default: !!live && live !== cfg?.id });
  });
  add('POST', '/line/richmenu', 'admin', async ({ env, req, actor, brandId }) => {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return err(409, '請先在「設定 → LINE 官方帳號」連接 LINE');
    const b: any = await req.json().catch(() => ({}));
    try {
      const cfg = normalize(b), img = decodeImage(b.image);
      const old = await loadMenu(env, brandId);
      cfg.id = await publishMenu(env, cfg, img, old?.id); cfg.updated_at = iso();
      await saveMenu(env, brandId, cfg);
      await audit(env, brandId, actor.name, 'line_richmenu_publish');
      await logEvent(env, brandId, 'info', 'line_connect', `${actor.name} 發布了 LINE 圖文選單（${cfg.areas.length} 格）`);
      return json({ ok: true, id: cfg.id });
    } catch (e) {
      if (!(e instanceof MenuError)) throw e;
      await logEvent(env, brandId, 'warn', 'line_connect', `發布 LINE 圖文選單失敗：${e.message}`);
      return err(400, e.message);
    }
  });
  add('DELETE', '/line/richmenu', 'admin', async ({ env, actor, brandId }) => {
    if (!env.LINE_CHANNEL_ACCESS_TOKEN) return err(409, '請先連接 LINE');
    const cfg = await loadMenu(env, brandId);
    try { await removeMenu(env, cfg?.id); } catch (e) { if (e instanceof MenuError) return err(400, e.message); throw e; }
    if (cfg) { delete cfg.id; await saveMenu(env, brandId, cfg); } // 保留設定，下次可直接再發布
    await audit(env, brandId, actor.name, 'line_richmenu_remove');
    await logEvent(env, brandId, 'info', 'line_connect', `${actor.name} 移除了 LINE 圖文選單`);
    return json({ ok: true });
  });

  add('POST', '/integrations/gemini', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const key = String(b.api_key ?? '').trim();
    if (key.length < 20) return err(400, 'API key 看起來不完整');
    const r = await geminiFetch(env)(GEMINI_MODELS, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) {
      // 把 Google 說的原因和這次請求走的機房記下來（金鑰本身不記），方便判斷是金鑰問題還是地區限制
      const eb: any = await r.json().catch(() => ({}));
      const why = [eb?.error?.status, eb?.error?.message].filter(Boolean).join(' ').slice(0, 200);
      const colo = String((req as any).cf?.colo ?? ''), country = String((req as any).cf?.country ?? '');
      await logEvent(env, brandId, 'warn', 'system', `驗證 Gemini 金鑰失敗（HTTP ${r.status}）：${why || '沒有說明'}`, { colo, country });
      const location = /location is not supported|not supported in your country|FAILED_PRECONDITION/i.test(why);
      return err(400, location
        ? `Google 拒絕了這次請求：系統這次是從 ${colo || '某個'} 機房連線，Google 不支援這個地區（不是金鑰的問題）。請稍後再試一次。`
        : `Gemini 拒絕了這組 key（HTTP ${r.status}${why ? `：${why}` : ''}）`);
    }
    await setCred(env, brandId, 'gemini_api_key', key);
    await audit(env, brandId, actor.name, 'integration_gemini');
    return json({ ok: true });
  });

  // ---- Threads 測試邀請：觸發（客戶提出）→ 同意（客戶接受）→ 授權 ----
  add('POST', '/threads/invites', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const username = normUsername(b.username);
    if (!username) return err(400, 'Threads 帳號名稱格式不正確（不含 @，只有英文、數字、底線與句點）');
    const r = await requestInvite(env, brandId, username, 'requested', actor.name);
    if (r === 'connected') return err(409, `@${username} 已經連結了`);
    return json({ id: r.id, status: r.status, username }, 201);
  });

  // 授權連結：傳給 Threads 帳號的擁有者，不用登入後台就能完成授權（可指定預期的帳號，授權回來時核對）
  add('POST', '/threads/connect-link', 'admin', async ({ env, req, url, actor, brandId }) => {
    if (!oauthConfigured(env)) return err(409, '系統尚未設定 Threads App');
    const b: any = await req.json().catch(() => ({}));
    const name = b.username ? normUsername(b.username) : undefined;
    if (b.username && !name) return err(400, 'Threads 帳號名稱格式不正確（不含 @，只有英文、數字、底線與句點）');
    await logEvent(env, brandId, 'info', 'threads_oauth', `${actor.name} 產生了 Threads 授權連結${name ? `（要連結 @${name}）` : ''}`);
    return json({ url: await makeConnectLink(env, url.origin, brandId, name ?? undefined), days: LINK_DAYS });
  });

  // 客戶：我已在 Threads 接受邀請（只有服務商送出邀請之後才能按）
  add('POST', '/threads/invites/(\\d+)/accepted', 'admin', async ({ env, m, actor, brandId }) => {
    const r = await env.DB.prepare(`UPDATE threads_invites SET status='accepted',updated_at=? WHERE id=? AND brand_id=? AND status='invited'`).bind(iso(), m[1], brandId).run();
    if (r.meta.changes !== 1) {
      const cur = await env.DB.prepare('SELECT status FROM threads_invites WHERE id=? AND brand_id=?').bind(m[1], brandId).first<{ status: string }>();
      if (cur?.status === 'accepted') return json({ ok: true });
      return err(409, cur?.status === 'requested' ? '服務商還沒有送出邀請，請稍後再試' : '找不到這筆申請');
    }
    await logEvent(env, brandId, 'info', 'threads_oauth', `${actor.name} 表示已接受 Threads 測試邀請，可以進行授權`);
    return json({ ok: true });
  });

  add('DELETE', '/threads/invites/(\\d+)', 'admin', async ({ env, m, brandId }) => {
    await env.DB.prepare(`UPDATE threads_invites SET status='cancelled',updated_at=? WHERE id=? AND brand_id=? AND status IN ('requested','invited','accepted')`).bind(iso(), m[1], brandId).run();
    return json({ ok: true });
  });

  add('GET', '/integrations/threads/connect', 'admin', async ({ env, actor, url, brandId }) => {
    if (!oauthConfigured(env)) return err(409, '系統尚未設定 Threads App（THREADS_APP_ID / THREADS_APP_SECRET）');
    // 從邀請流程進來：必須已完成前兩步，並記下開始授權的時間（客戶頁用來提示「上次授權沒有完成」）
    const inv = url.searchParams.get('invite');
    let expect: string | undefined;
    if (inv) {
      const row = await env.DB.prepare('SELECT status,username FROM threads_invites WHERE id=? AND brand_id=?').bind(inv, brandId).first<{ status: string; username: string }>();
      if (!row) return err(404, '找不到這筆申請');
      if (env.THREADS_APP_MODE !== 'live' && row.status !== 'accepted' && row.status !== 'connected') return err(409, '請先完成前面的步驟：服務商送出邀請、你在 Threads 接受邀請');
      expect = row.username;
      await env.DB.prepare('UPDATE threads_invites SET authorize_started_at=? WHERE id=? AND brand_id=?').bind(iso(), inv, brandId).run();
    }
    // 用來判斷授權是否有回到系統：只有「開始」沒有後續結果，代表卡在 Threads／Meta 頁面
    await logEvent(env, brandId, 'info', 'threads_oauth', `${actor.name} 開始連結 Threads（等待 Threads 頁面回傳）`, { callback: `${url.origin}/threads/callback` });
    // 重新連結既有帳號：預期授權的就是那個帳號
    const acc = Number(url.searchParams.get('account')) || 0;
    if (acc) { const a = await getAccount(env, acc); if (!a) return err(404, '找不到這個帳號'); if (a.username) expect = a.username; }
    return json({ url: await buildAuthorizeUrl(env, url.origin, actor.id, Date.now(), { brandId, expect }) });
  });

  add('DELETE', '/integrations/threads', 'admin', async ({ env, actor, brandId }) => {
    await removeAccounts(env, { brandId });
    await audit(env, brandId, actor.name, 'threads_disconnect');
    return json({ ok: true });
  });

  // 連線健康檢查：實際呼叫各服務的唯讀端點
  add('POST', '/integrations/test', 'admin', async ({ env, req }) => {
    const b: any = await req.json().catch(() => ({}));
    try {
      if (b.target === 'line') {
        if (!env.LINE_CHANNEL_ACCESS_TOKEN) return json({ ok: false, message: '尚未設定' });
        const i = await lineInfo(env.LINE_CHANNEL_ACCESS_TOKEN);
        if (i.ok) { // 順便更新聊天模式，讓設定頁的提醒保持正確
          const meta = await getMeta(env, 'line_channel_access_token');
          if (meta && meta.chat_mode !== (i.chatMode ?? null)) await env.DB.prepare('UPDATE integrations SET meta=? WHERE brand_id=? AND name=?')
            .bind(JSON.stringify({ ...meta, chat_mode: i.chatMode ?? null }), (await getBrand(env)).id, 'line_channel_access_token').run();
        }
        return json({ ok: i.ok, chat_mode: i.chatMode ?? null, message: !i.ok ? 'Token 無效' : i.chatMode === 'chat' ? `已連線：${i.name}。提醒：「聊天」功能開啟中，顧客可能同時收到自動回覆與真人訊息` : `已連線：${i.name}` });
      }
      if (b.target === 'gemini') {
        if (!env.GEMINI_API_KEY) return json({ ok: false, message: '尚未設定' });
        const r = await geminiFetch(env)(GEMINI_MODELS, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
        // 顯示轉送程式實際從哪裡連線（確認不是 Google 不支援的地區）
        let via = '';
        if (env.GEMINI_PROXY) { const t = await (await env.GEMINI_PROXY.fetch('https://relay/__where')).text().catch(() => ''); const g = (k: string) => t.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] ?? ''; via = `（經由 ${g('colo')} / ${g('loc')} 連線）`; }
        const eb: any = r.ok ? null : await r.json().catch(() => ({}));
        return json({ ok: r.ok, message: r.ok ? `連線正常${via}` : `Gemini 回應 ${r.status}：${eb?.error?.message ?? ''}${via}` });
      }
      if (b.target === 'threads') {
        const accts = (await listAccounts(env)).filter((a) => !b.account_id || a.id === Number(b.account_id));
        if (!accts.length) return json({ ok: false, message: '尚未連結' });
        const res: string[] = []; let allOk = true;
        for (const a of accts) {
          const c = await credFor(env, a);
          const r = await fetch(`https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(c.token)}`);
          const d: any = await r.json().catch(() => ({}));
          allOk &&= r.ok; res.push(r.ok ? `@${d.username} 正常` : `@${a.username} 授權失效`);
        }
        return json({ ok: allOk, message: res.join('、') });
      }
    } catch { return json({ ok: false, message: '無法連線到服務' }); }
    return err(400, 'unknown target');
  });

  // ---- 帳號管理 ----
  add('GET', '/users', 'admin', async ({ env, brandId }) =>
    json((await env.DB.prepare(
      `SELECT id,authentication_id AS username,role,enabled,0 AS shared FROM admin_users WHERE brand_id=?
       UNION ALL SELECT u.id,u.authentication_id,ub.role,u.enabled,1 FROM user_brands ub JOIN admin_users u ON u.id=ub.user_id WHERE ub.brand_id=?
       ORDER BY shared, id`).bind(brandId, brandId).all()).results));

  add('POST', '/users', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(b.username ?? '')) return err(400, '帳號需為 3–32 字英數');
    if (!['admin', 'staff'].includes(b.role)) return err(400, '角色不合法');
    if (String(b.password ?? '').length < 10) return err(400, '密碼至少 10 字元');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES(?,?,?,?)')
      .bind(brandId, b.role, b.username, await hashPassword(b.password)).run();
    if (r.meta.changes !== 1) return err(409, '這個帳號名稱已被使用（帳號在整個系統內不可重複），請換一個');
    await audit(env, brandId, actor.name, 'user_create', `${b.username}:${b.role}`);
    return json({ ok: true });
  });

  add('PATCH', '/users/(\\d+)', 'admin', async ({ env, req, m, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    if (Number(m[1]) === actor.id) return err(400, '不能修改自己的帳號狀態');
    if (typeof b.enabled === 'boolean') {
      await env.DB.prepare('UPDATE admin_users SET enabled=? WHERE id=? AND brand_id=?').bind(b.enabled ? 1 : 0, m[1], brandId).run();
    }
    if (b.password !== undefined) {
      if (String(b.password).length < 10) return err(400, '密碼至少 10 字元');
      await env.DB.prepare('UPDATE admin_users SET password_hash=? WHERE id=? AND brand_id=?').bind(await hashPassword(b.password), m[1], brandId).run();
    }
    // 管理員替同事重設密碼：由系統產生一次性密碼，只回傳這一次
    let issued: string | undefined;
    if (b.reset_password === true) {
      issued = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/[+/=]/g, '').slice(0, 14);
      const r = await env.DB.prepare('UPDATE admin_users SET password_hash=?,enabled=1 WHERE id=? AND brand_id=?').bind(await hashPassword(issued), m[1], brandId).run();
      if (!r.meta.changes) return err(404, '找不到這個帳號');
    }
    await audit(env, brandId, actor.name, b.reset_password ? 'user_password_reset' : 'user_update', m[1]);
    return json({ ok: true, password: issued });
  });

  // 唯讀：列出已連結 Threads 帳號自己發過的貼文（用於分析範本帳號的貼文架構），最多 150 則
  add('GET', '/integrations/threads/posts', 'admin', async ({ env, url: reqUrl }) => {
    const cred = await resolveCred(env, Number(reqUrl.searchParams.get('account_id')) || null);
    if (!cred) return err(409, '尚未連結 Threads');
    const fields = 'id,text,timestamp,permalink,media_type,is_quote_post';
    const one = reqUrl.searchParams.get('id');
    if (one) {
      if (!/^\d+$/.test(one)) return err(400, 'id 不合法');
      const r = await fetch(`https://graph.threads.net/v1.0/${one}?fields=${fields}&access_token=${encodeURIComponent(cred.token)}`);
      const d: any = await r.json().catch(() => ({}));
      return r.ok ? json(d) : err(502, `Threads 回應錯誤：${d?.error?.message ?? r.status}`);
    }
    let url: string | null = `https://graph.threads.net/v1.0/me/threads?fields=${fields}&limit=50&access_token=${encodeURIComponent(cred.token)}`;
    const out: unknown[] = [];
    for (let i = 0; i < 3 && url; i++) {
      const r = await fetch(url);
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) return err(502, `Threads 回應錯誤：${d?.error?.message ?? r.status}`);
      out.push(...(d.data ?? []));
      url = d.paging?.next ?? null;
    }
    return json(out);
  });

  // ---- 矩陣帳號 ----
  add('GET', '/accounts', 'admin', async ({ env }) => json((await listAccounts(env)).map(publicAccount)));

  add('PATCH', '/accounts/(\\d+)', 'admin', async ({ env, req, m, actor, brandId }) => {
    const a = await getAccount(env, Number(m[1]));
    if (!a || a.brand_id !== brandId) return err(404, '找不到這個帳號');
    const b: any = await req.json().catch(() => ({}));
    const sets: string[] = []; const vals: unknown[] = [];
    const put = (c: string, v: unknown) => { sets.push(`${c}=?`); vals.push(v); };
    const str = (k: string, max: number) => { if (b[k] === undefined) return true; if (b[k] !== null && (typeof b[k] !== 'string' || b[k].length > max)) return false; put(k, b[k] === '' ? null : b[k]); return true; };
    if (b.persona !== undefined) { if (typeof b.persona !== 'string' || b.persona.length > 1000) return err(400, '人設不可超過 1000 字'); put('persona', b.persona); }
    if (!str('tone', 200) || !str('cta_text', 200)) return err(400, '語氣或 CTA 過長');
    if (b.topics !== undefined) {
      if (b.topics !== null && (!Array.isArray(b.topics) || b.topics.length > 30 || b.topics.some((x: any) => typeof x !== 'string' || x.length > 100))) return err(400, '主題不合法');
      put('topics', b.topics?.length ? JSON.stringify(b.topics) : null);
    }
    if (b.posts_per_day !== undefined) {
      if (b.posts_per_day !== null && (!Number.isInteger(b.posts_per_day) || b.posts_per_day < 1 || b.posts_per_day > 5)) return err(400, '每日發文需為 1–5');
      put('posts_per_day', b.posts_per_day);
    }
    if (b.publishing_times !== undefined) {
      if (b.publishing_times !== null && (!Array.isArray(b.publishing_times) || !b.publishing_times.length || b.publishing_times.length > 5 || b.publishing_times.some((t: any) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))) return err(400, '發布時間格式需為 HH:MM（1–5 個）');
      put('publishing_times', b.publishing_times?.length ? JSON.stringify([...b.publishing_times].sort()) : null);
    }
    if (typeof b.auto_post_enabled === 'boolean') put('auto_post_enabled', b.auto_post_enabled ? 1 : 0);
    if (!sets.length) return err(400, 'nothing to update');
    await env.DB.prepare(`UPDATE threads_accounts SET ${sets.join(',')},updated_at=? WHERE id=?`).bind(...vals, iso(), a.id).run();
    await audit(env, brandId, actor.name, 'account_update', a.username ?? String(a.id));
    return json({ ok: true });
  });

  add('DELETE', '/accounts/(\\d+)', 'admin', async ({ env, m, actor, brandId }) => {
    const a = await getAccount(env, Number(m[1]));
    if (!a || a.brand_id !== brandId) return err(404, '找不到這個帳號');
    await removeAccounts(env, { brandId, id: a.id }); // 尚未發出的貼文退回草稿，避免誤發
    await audit(env, brandId, actor.name, 'account_disconnect', a.username ?? '');
    return json({ ok: true });
  });

  // 系統紀錄（只看自己工作區）：串接、發文、排程的結果與錯誤原因
  add('GET', '/logs', 'admin', async ({ env, brandId, url }) => {
    const lv = url.searchParams.get('level');
    const cond = lv === 'error' ? ` AND level='error'` : lv === 'warn' ? ` AND level IN ('warn','error')` : '';
    const rows = (await env.DB.prepare(`SELECT id,level,source,message,detail,created_at FROM event_logs WHERE brand_id=?${cond} ORDER BY id DESC LIMIT 100`).bind(brandId).all()).results;
    return json({ rows, sources: SOURCES });
  });

  add('GET', '/audit', 'admin', async ({ env, brandId }) =>
    json((await env.DB.prepare(`SELECT actor,action,detail,created_at FROM audit_logs WHERE brand_id=? AND action<>'login_fail' ORDER BY id DESC LIMIT 50`).bind(brandId).all()).results));

  // 公開：隱私／條款頁用，只回品牌名稱
  void getBrand; void getMeta;
}
