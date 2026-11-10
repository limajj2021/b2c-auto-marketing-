// 連線設定（LINE / Gemini / Threads）與帳號管理。由 routes.ts 註冊。
import { audit, getBrand } from '../db';
import { credStatus, deleteCreds, getMeta, setCred } from '../integrations';
import { buildAuthorizeUrl, oauthConfigured } from '../threads/oauth';
import type { Env } from '../types';
import { hashPassword } from '../util/crypto';
import type { Actor } from './routes';

type Ctx = { env: Env; req: Request; actor: Actor; m: RegExpMatchArray; url: URL; brandId: string };
type Add = (method: string, path: string, role: 'admin' | 'staff', h: (c: Ctx) => Promise<Response>) => void;
type J = (data: unknown, status?: number) => Response;
type E = (status: number, message: string) => Response;

const GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';

async function lineInfo(token: string): Promise<{ ok: boolean; name?: string; basicId?: string }> {
  const r = await fetch('https://api.line.me/v2/bot/info', { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return { ok: false };
  const b: any = await r.json();
  return { ok: true, name: b.displayName, basicId: b.basicId };
}

export function registerExtra(add: Add, json: J, err: E) {
  add('GET', '/integrations', 'admin', async ({ env, url }) => {
    const st = await credStatus(env);
    const th = st.threads_access_token;
    return json({
      line: { configured: st.line_channel_secret.set && st.line_channel_access_token.set, webhook_url: `${url.origin}/line/webhook`, name: st.line_channel_access_token.meta.name ?? null },
      gemini: { configured: st.gemini_api_key.set },
      threads: {
        configured: th.set && st.threads_user_id.set,
        username: th.meta.username ?? null,
        expires_at: th.meta.expires_at ?? null,
        oauth_available: oauthConfigured(env),
      },
    });
  });

  // 貼上 LINE 憑證 → 驗證 token → 設定 Webhook → 用 LINE 官方測試驗證簽章
  add('POST', '/integrations/line', 'admin', async ({ env, req, actor, url, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const secret = String(b.channel_secret ?? '').trim();
    const token = String(b.channel_access_token ?? '').trim();
    if (!/^[0-9a-f]{32}$/i.test(secret)) return err(400, 'Channel secret 應為 32 位英數字');
    if (token.length < 50) return err(400, 'Channel access token 看起來不完整');
    const info = await lineInfo(token);
    if (!info.ok) return err(400, 'Access token 無效，LINE 拒絕了這組憑證');
    await setCred(env, brandId, 'line_channel_secret', secret);
    await setCred(env, brandId, 'line_channel_access_token', token, { name: info.name, basic_id: info.basicId });
    const endpoint = `${url.origin}/line/webhook`;
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const set = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { method: 'PUT', headers: auth, body: JSON.stringify({ endpoint }) });
    let verified = false;
    if (set.ok) {
      const t = await fetch('https://api.line.me/v2/bot/channel/webhook/test', { method: 'POST', headers: auth, body: JSON.stringify({ endpoint }) });
      verified = t.ok && ((await t.json().catch(() => ({}))) as any).success === true;
    }
    await audit(env, brandId, actor.name, 'integration_line');
    return json({ ok: true, bot: info.name, webhook_set: set.ok, webhook_verified: verified });
  });

  add('POST', '/integrations/gemini', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    const key = String(b.api_key ?? '').trim();
    if (key.length < 20) return err(400, 'API key 看起來不完整');
    const r = await fetch(GEMINI_MODELS, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) return err(400, 'Gemini 拒絕了這組 key');
    await setCred(env, brandId, 'gemini_api_key', key);
    await audit(env, brandId, actor.name, 'integration_gemini');
    return json({ ok: true });
  });

  add('GET', '/integrations/threads/connect', 'admin', async ({ env, actor, url }) => {
    if (!oauthConfigured(env)) return err(409, '系統尚未設定 Threads App（THREADS_APP_ID / THREADS_APP_SECRET）');
    return json({ url: await buildAuthorizeUrl(env, url.origin, actor.id) });
  });

  add('DELETE', '/integrations/threads', 'admin', async ({ env, actor, brandId }) => {
    await deleteCreds(env, ['threads_access_token', 'threads_user_id']);
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
        return json({ ok: i.ok, message: i.ok ? `已連線：${i.name}` : 'Token 無效' });
      }
      if (b.target === 'gemini') {
        if (!env.GEMINI_API_KEY) return json({ ok: false, message: '尚未設定' });
        const r = await fetch(GEMINI_MODELS, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
        return json({ ok: r.ok, message: r.ok ? '連線正常' : `Gemini 回應 ${r.status}` });
      }
      if (b.target === 'threads') {
        if (!env.THREADS_ACCESS_TOKEN) return json({ ok: false, message: '尚未連結' });
        const r = await fetch(`https://graph.threads.net/v1.0/me?fields=username&access_token=${encodeURIComponent(env.THREADS_ACCESS_TOKEN)}`);
        const d: any = await r.json().catch(() => ({}));
        return json({ ok: r.ok, message: r.ok ? `已連線：@${d.username}` : '授權已失效，請重新連結' });
      }
    } catch { return json({ ok: false, message: '無法連線到服務' }); }
    return err(400, 'unknown target');
  });

  // ---- 帳號管理 ----
  add('GET', '/users', 'admin', async ({ env, brandId }) =>
    json((await env.DB.prepare('SELECT id,authentication_id AS username,role,enabled FROM admin_users WHERE brand_id=? ORDER BY id').bind(brandId).all()).results));

  add('POST', '/users', 'admin', async ({ env, req, actor, brandId }) => {
    const b: any = await req.json().catch(() => ({}));
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(b.username ?? '')) return err(400, '帳號需為 3–32 字英數');
    if (!['admin', 'staff'].includes(b.role)) return err(400, '角色不合法');
    if (String(b.password ?? '').length < 10) return err(400, '密碼至少 10 字元');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES(?,?,?,?)')
      .bind(brandId, b.role, b.username, await hashPassword(b.password)).run();
    if (r.meta.changes !== 1) return err(409, '帳號已存在');
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
    await audit(env, brandId, actor.name, 'user_update', m[1]);
    return json({ ok: true });
  });

  // 唯讀：列出已連結 Threads 帳號自己發過的貼文（用於分析範本帳號的貼文架構），最多 150 則
  add('GET', '/integrations/threads/posts', 'admin', async ({ env }) => {
    if (!env.THREADS_ACCESS_TOKEN) return err(409, '尚未連結 Threads');
    const fields = 'id,text,timestamp,permalink,media_type,is_quote_post';
    let url: string | null = `https://graph.threads.net/v1.0/me/threads?fields=${fields}&limit=50&access_token=${encodeURIComponent(env.THREADS_ACCESS_TOKEN)}`;
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

  add('GET', '/audit', 'admin', async ({ env, brandId }) =>
    json((await env.DB.prepare(`SELECT actor,action,detail,created_at FROM audit_logs WHERE brand_id=? AND action<>'login_fail' ORDER BY id DESC LIMIT 50`).bind(brandId).all()).results));

  // 公開：隱私／條款頁用，只回品牌名稱
  void getBrand; void getMeta;
}
