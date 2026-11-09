import { decryptText, encryptText } from './util/secrets';
import { iso } from './util/time';
import type { Env } from './types';

/** DB 憑證名稱 → 對應的 Env 欄位。DB 優先，未設定時退回 wrangler secret。 */
export const CRED_ENV = {
  line_channel_secret: 'LINE_CHANNEL_SECRET',
  line_channel_access_token: 'LINE_CHANNEL_ACCESS_TOKEN',
  threads_access_token: 'THREADS_ACCESS_TOKEN',
  threads_user_id: 'THREADS_USER_ID',
  gemini_api_key: 'GEMINI_API_KEY',
} as const;
export type CredName = keyof typeof CRED_ENV;

const encKey = (env: Env) => env.CRED_ENC_KEY || env.SESSION_SECRET;

/** 回傳疊加了後台所設憑證的 env；資料表尚未建立時原樣返回。 */
export async function withCreds(env: Env): Promise<Env> {
  let rows: { name: string; value_enc: string }[] = [];
  try {
    rows = (await env.DB.prepare('SELECT name,value_enc FROM integrations').all<{ name: string; value_enc: string }>()).results;
  } catch { return env; }
  const out: Env = { ...env };
  for (const r of rows) {
    const k = CRED_ENV[r.name as CredName];
    if (!k) continue;
    try { (out as any)[k] = await decryptText(encKey(env), r.value_enc); } catch { /* 金鑰不符則忽略該筆 */ }
  }
  return out;
}

export async function setCred(env: Env, brandId: string, name: CredName, value: string, meta: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO integrations(brand_id,name,value_enc,meta,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(brand_id,name) DO UPDATE SET value_enc=excluded.value_enc,meta=excluded.meta,updated_at=excluded.updated_at`,
  ).bind(brandId, name, await encryptText(encKey(env), value), JSON.stringify(meta), iso()).run();
}

export async function getMeta(env: Env, name: CredName): Promise<Record<string, any> | null> {
  const r = await env.DB.prepare('SELECT meta FROM integrations WHERE name=?').bind(name).first<{ meta: string }>();
  return r ? JSON.parse(r.meta || '{}') : null;
}

export async function deleteCreds(env: Env, names: CredName[]): Promise<void> {
  for (const n of names) await env.DB.prepare('DELETE FROM integrations WHERE name=?').bind(n).run();
}

/** 前端用：哪些憑證已設定（絕不回傳值）。 */
export async function credStatus(env: Env): Promise<Record<CredName, { set: boolean; source: 'db' | 'env' | null; meta: Record<string, any> }>> {
  const rows = (await env.DB.prepare('SELECT name,meta FROM integrations').all<{ name: string; meta: string }>()).results;
  const db = new Map(rows.map((r) => [r.name, JSON.parse(r.meta || '{}')]));
  const out: any = {};
  for (const n of Object.keys(CRED_ENV) as CredName[]) {
    const inDb = db.has(n);
    const inEnv = !!(env as any)[CRED_ENV[n]];
    out[n] = { set: inDb || inEnv, source: inDb ? 'db' : inEnv ? 'env' : null, meta: db.get(n) ?? {} };
  }
  return out;
}
