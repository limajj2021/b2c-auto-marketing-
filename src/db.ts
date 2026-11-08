import type { Brand, Env, Settings } from './types';
import { iso } from './util/time';

/** 每個部署只有一個 brand（每企業獨立 D1）。 */
export async function getBrand(env: Env): Promise<Brand> {
  const b = await env.DB.prepare('SELECT id,name,industry,description,timezone FROM brands LIMIT 1').first<Brand>();
  if (!b) throw new Error('brand not provisioned');
  return b;
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
