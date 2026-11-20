import { decryptText, encryptText } from './util/secrets';
import { iso } from './util/time';
import type { Env } from './types';
import { getBrand, isMulti } from './db';

/** DB 憑證名稱 → 對應的 Env 欄位。DB 優先，未設定時退回 wrangler secret。 */
export const CRED_ENV = {
  line_channel_secret: 'LINE_CHANNEL_SECRET',
  line_channel_access_token: 'LINE_CHANNEL_ACCESS_TOKEN',
  line_channel_id: 'LINE_CHANNEL_ID',
  threads_access_token: 'THREADS_ACCESS_TOKEN',
  threads_user_id: 'THREADS_USER_ID',
  gemini_api_key: 'GEMINI_API_KEY',
} as const;
export type CredName = keyof typeof CRED_ENV;

const encKey = (env: Env) => env.CRED_ENC_KEY || env.SESSION_SECRET;

/** 回傳疊加了後台所設憑證的 env；資料表尚未建立時原樣返回。 */
export async function withCreds(env: Env): Promise<Env> {
  const out: Env = { ...env };
  // 共用架構：LINE、Threads 憑證一律來自該工作區自己的設定，不可沿用平台層的 secret（避免 A 客戶用到 B 的帳號）
  if (isMulti(env)) for (const k of ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_ID', 'THREADS_ACCESS_TOKEN', 'THREADS_USER_ID'] as const) (out as any)[k] = '';
  let rows: { name: string; value_enc: string; meta: string | null }[] = [];
  try {
    const brand = await getBrand(env);
    rows = (await env.DB.prepare('SELECT name,value_enc,meta FROM integrations WHERE brand_id=?').bind(brand.id).all<{ name: string; value_enc: string; meta: string | null }>()).results;
  } catch { return out; }
  for (const r of rows) {
    if (r.name === 'line_channel_access_token') {
      try { const m = JSON.parse(r.meta || '{}'); out.LINE_TOKEN_AUTO_EXPIRES = m.auto ? String(m.expires_at ?? '') : undefined; } catch { /* 忽略 */ }
    }
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
  const b = await getBrand(env);
  const r = await env.DB.prepare('SELECT meta FROM integrations WHERE brand_id=? AND name=?').bind(b.id, name).first<{ meta: string }>();
  return r ? JSON.parse(r.meta || '{}') : null;
}

export async function deleteCreds(env: Env, names: CredName[]): Promise<void> {
  const b = await getBrand(env);
  for (const n of names) await env.DB.prepare('DELETE FROM integrations WHERE brand_id=? AND name=?').bind(b.id, n).run();
}

/** 前端用：哪些憑證已設定（絕不回傳值）。 */
export async function credStatus(env: Env): Promise<Record<CredName, { set: boolean; source: 'db' | 'env' | null; meta: Record<string, any> }>> {
  const b = await getBrand(env);
  const rows = (await env.DB.prepare('SELECT name,meta FROM integrations WHERE brand_id=?').bind(b.id).all<{ name: string; meta: string }>()).results;
  const db = new Map(rows.map((r) => [r.name, JSON.parse(r.meta || '{}')]));
  const out: any = {};
  for (const n of Object.keys(CRED_ENV) as CredName[]) {
    const inDb = db.has(n);
    const inEnv = !!(env as any)[CRED_ENV[n]];
    out[n] = { set: inDb || inEnv, source: inDb ? 'db' : inEnv ? 'env' : null, meta: db.get(n) ?? {} };
  }
  return out;
}
