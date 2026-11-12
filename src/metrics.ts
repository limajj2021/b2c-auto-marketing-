// 不含個資的每日計數。
import { getBrand } from './db';
import type { Env } from './types';
import { localDate } from './util/time';

export type MetricName = 'friend_add' | 'handoff';

export async function bump(env: Env, name: MetricName, now = new Date()): Promise<void> {
  const b = await getBrand(env);
  await env.DB.prepare(`INSERT INTO metrics_daily(brand_id,day,name,count) VALUES(?,?,?,1)
    ON CONFLICT(brand_id,day,name) DO UPDATE SET count=count+1`).bind(b.id, localDate(now, b.timezone), name).run();
}

/** 指定日期區間（含頭不含尾，YYYY-MM-DD）的加總。 */
export async function metricSum(env: Env, brandId: string, name: MetricName, from: string, to = '9999-12-31'): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(count),0) c FROM metrics_daily WHERE brand_id=? AND name=? AND day>=? AND day<?')
    .bind(brandId, name, from, to).first<{ c: number }>();
  return r?.c ?? 0;
}
