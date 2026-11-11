// 排程：輪替處理各工作區，單一工作區出錯不影響其他工作區。
import { forBrand } from './db';
import { withCreds } from './integrations';
import { refreshIfNeeded } from './threads/oauth';
import { runCron } from './threads/scheduler';
import type { Env } from './types';
import { iso } from './util/time';

export async function runAllTenants(raw: Env, now = new Date()): Promise<{ processed: string[] }> {
  const batch = Math.max(1, Number(raw.CRON_BATCH) || 25);
  // 最久沒被處理的優先；工作區超過 batch 時，下一輪會輪到其他工作區
  const rows = (await raw.DB.prepare(`SELECT id FROM brands WHERE COALESCE(status,'active')='active' ORDER BY COALESCE(last_cron_at,'') LIMIT ?`)
    .bind(batch).all<{ id: string }>()).results;
  const processed: string[] = [];
  for (const { id } of rows) {
    await raw.DB.prepare('UPDATE brands SET last_cron_at=? WHERE id=?').bind(iso(now), id).run();
    try {
      const env = await withCreds(forBrand(raw, id));
      await refreshIfNeeded(env, now).catch((e) => console.error('refresh', id, (e as Error).message));
      await runCron(await withCreds(forBrand(raw, id)), now);
      processed.push(id);
    } catch (e) { console.error('cron:tenant', id, (e as Error).message); }
  }
  return { processed };
}
