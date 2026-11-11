import type { Brand, Env, Settings } from './types';
import { iso } from './util/time';

export const isMulti = (env: Env) => env.MULTI_TENANT === '1';
/** 回傳綁定到指定工作區的 env；之後所有 getBrand 都只會拿到這個工作區。 */
export const forBrand = (env: Env, brandId: string): Env => ({ ...env, BRAND_ID: brandId });

const COLS = 'id,slug,status,name,industry,description,timezone';

/** 目前請求所屬的工作區。共用架構下若未解析出工作區，直接拒絕，避免跨工作區讀寫。 */
export async function getBrand(env: Env): Promise<Brand> {
  let b: Brand | null;
  if (env.BRAND_ID) b = await env.DB.prepare(`SELECT ${COLS} FROM brands WHERE id=?`).bind(env.BRAND_ID).first<Brand>();
  else if (isMulti(env)) throw new Error('tenant not resolved');
  else b = await env.DB.prepare(`SELECT ${COLS} FROM brands ORDER BY created_at LIMIT 1`).first<Brand>();
  if (!b) throw new Error('brand not provisioned');
  return b;
}

export async function brandBySlug(env: Env, slug: string): Promise<Brand | null> {
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return null;
  return env.DB.prepare(`SELECT ${COLS} FROM brands WHERE slug=?`).bind(slug).first<Brand>();
}

export async function getSettings(env: Env, brandId: string): Promise<Settings> {
  const s = await env.DB.prepare('SELECT * FROM brand_settings WHERE brand_id=?').bind(brandId).first<Settings>();
  if (!s) throw new Error('settings missing');
  return s;
}

export async function audit(env: Env, brandId: string, actor: string | null, action: string, detail = ''): Promise<void> {
  await env.DB.prepare('INSERT INTO audit_logs(brand_id,actor,action,detail,created_at) VALUES(?,?,?,?,?)')
    .bind(brandId, actor, action, detail, iso()).run();
}

export function jsonArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
