// 矩陣帳號：Threads 帳號的儲存、解密與舊版單帳號資料移轉。
import { getBrand } from '../db';
import type { Env, Settings } from '../types';
import { decryptText, encryptText } from '../util/secrets';
import { iso } from '../util/time';

export interface Account {
  id: number; brand_id: string; threads_user_id: string; username: string | null; token_enc: string; expires_at: string | null;
  status: string; persona: string; tone: string | null; topics: string | null; posts_per_day: number | null;
  publishing_times: string | null; cta_text: string | null; auto_post_enabled: number;
}
/** 發文用的憑證；legacy 代表沿用 wrangler secret 的單帳號設定（無 threads_accounts 時）。 */
export interface Cred { accountId: number | null; token: string; userId: string; username?: string | null }

const key = (env: Env) => env.CRED_ENC_KEY || env.SESSION_SECRET;

/** 舊版把單一帳號存在 integrations；第一次讀取時移入 threads_accounts。 */
async function migrateLegacy(env: Env): Promise<void> {
  let rows: { name: string; value_enc: string; meta: string }[] = [];
  try {
    rows = (await env.DB.prepare(`SELECT name,value_enc,meta FROM integrations WHERE name IN ('threads_access_token','threads_user_id')`).all<any>()).results;
  } catch { return; }
  const tok = rows.find((r) => r.name === 'threads_access_token'), uid = rows.find((r) => r.name === 'threads_user_id');
  if (!tok || !uid) return;
  const brand = await getBrand(env);
  const meta = JSON.parse(tok.meta || '{}');
  const userId = await decryptText(key(env), uid.value_enc).catch(() => null);
  if (!userId) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO threads_accounts(brand_id,threads_user_id,username,token_enc,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
  ).bind(brand.id, userId, meta.username ?? null, tok.value_enc, meta.expires_at ?? null, iso(), iso()).run();
  await env.DB.prepare(`DELETE FROM integrations WHERE name IN ('threads_access_token','threads_user_id')`).run();
}

export async function listAccounts(env: Env): Promise<Account[]> {
  await migrateLegacy(env);
  try { return (await env.DB.prepare('SELECT * FROM threads_accounts ORDER BY id').all<Account>()).results; } catch { return []; }
}
export async function getAccount(env: Env, id: number): Promise<Account | null> {
  return env.DB.prepare('SELECT * FROM threads_accounts WHERE id=?').bind(id).first<Account>();
}

export async function upsertAccount(env: Env, brandId: string, a: { userId: string; username: string | null; token: string; expiresAt: string | null }): Promise<number> {
  const enc = await encryptText(key(env), a.token);
  await env.DB.prepare(
    `INSERT INTO threads_accounts(brand_id,threads_user_id,username,token_enc,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,'ok',?,?)
     ON CONFLICT(brand_id,threads_user_id) DO UPDATE SET username=excluded.username,token_enc=excluded.token_enc,expires_at=excluded.expires_at,status='ok',updated_at=excluded.updated_at`,
  ).bind(brandId, a.userId, a.username, enc, a.expiresAt, iso(), iso()).run();
  return (await env.DB.prepare('SELECT id FROM threads_accounts WHERE brand_id=? AND threads_user_id=?').bind(brandId, a.userId).first<{ id: number }>())!.id;
}

export async function setAccountToken(env: Env, id: number, token: string, expiresAt: string): Promise<void> {
  await env.DB.prepare(`UPDATE threads_accounts SET token_enc=?,expires_at=?,status='ok',updated_at=? WHERE id=?`)
    .bind(await encryptText(key(env), token), expiresAt, iso(), id).run();
}
export async function markAccount(env: Env, id: number | null, status: 'ok' | 'token_invalid'): Promise<void> {
  if (id === null) {
    const b = await getBrand(env);
    await env.DB.prepare('UPDATE brand_settings SET threads_status=? WHERE brand_id=?').bind(status, b.id).run();
  } else await env.DB.prepare('UPDATE threads_accounts SET status=?,updated_at=? WHERE id=?').bind(status, iso(), id).run();
}

export async function credFor(env: Env, a: Account): Promise<Cred> {
  return { accountId: a.id, token: await decryptText(key(env), a.token_enc), userId: a.threads_user_id, username: a.username };
}
/** 依貼文所屬帳號取得憑證；未指定時用第一個帳號，再退回舊版 wrangler secret。 */
export async function resolveCred(env: Env, accountId: number | null): Promise<Cred | null> {
  const accts = await listAccounts(env);
  const a = accountId ? accts.find((x) => x.id === accountId) : accts[0];
  if (a) return a.status === 'ok' ? credFor(env, a) : null;
  if (accountId) return null; // 指定的帳號已被移除
  return env.THREADS_ACCESS_TOKEN && env.THREADS_USER_ID ? { accountId: null, token: env.THREADS_ACCESS_TOKEN, userId: env.THREADS_USER_ID } : null;
}

/** 帳號的有效設定：未覆寫的欄位沿用品牌預設。 */
export function effective(a: Account | null, s: Settings) {
  const arr = (v: string | null | undefined, d: string) => { try { const x = JSON.parse(v ?? d); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  return {
    persona: a?.persona ?? '',
    tone: a?.tone || s.content_tone,
    topics: a?.topics ? arr(a.topics, '[]') : arr(s.content_topics, '[]'),
    postsPerDay: a?.posts_per_day ?? s.posts_per_day,
    times: a?.publishing_times ? arr(a.publishing_times, '[]') : arr(s.publishing_times, '[]'),
    cta: a?.cta_text || s.cta_text,
  };
}

export const publicAccount = (a: Account) => ({
  id: a.id, username: a.username, status: a.status, expires_at: a.expires_at, persona: a.persona, tone: a.tone,
  topics: a.topics ? JSON.parse(a.topics) : null, posts_per_day: a.posts_per_day,
  publishing_times: a.publishing_times ? JSON.parse(a.publishing_times) : null, cta_text: a.cta_text, auto_post_enabled: !!a.auto_post_enabled,
});
