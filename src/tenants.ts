// 排程：輪替處理各工作區，單一工作區出錯不影響其他工作區。
import { forBrand } from './db';
import { BudgetError, budgeted, canAfford } from './budget';
import { withCreds } from './integrations';
import { refreshIfNeeded } from './threads/oauth';
import { runCron } from './threads/scheduler';
import type { Env } from './types';
import { iso } from './util/time';

export async function runAllTenants(raw: Env, now = new Date()): Promise<{ processed: string[] }> {
  const batch = Math.max(1, Number(raw.CRON_BATCH) || 25);
  // 整次排程共用一份請求額度（Cloudflare 免費方案每次執行 50 次，含資料庫查詢）
  const benv = budgeted(raw, Math.max(10, Number(raw.CRON_SUBREQUEST_LIMIT) || 45));
  // 最久沒被處理的優先；工作區超過 batch 時，下一輪會輪到其他工作區
  const rows = (await benv.DB.prepare(`SELECT id FROM brands WHERE COALESCE(status,'active')='active' ORDER BY COALESCE(last_cron_at,'') LIMIT ?`)
    .bind(batch).all<{ id: string }>()).results;
  const processed: string[] = [];
  for (const { id } of rows) {
    if (!canAfford(benv, 12)) break; // 剩下的工作區留到下一輪（最久沒處理的優先）
    try {
      await benv.DB.prepare('UPDATE brands SET last_cron_at=? WHERE id=?').bind(iso(now), id).run();
      const env = await withCreds({ ...forBrand(benv, id), MEMO: new Map() });
      await refreshIfNeeded(env, now).catch((e) => { if (e instanceof BudgetError) throw e; console.error('refresh', id, (e as Error).message); });
      await runCron(env, now);
      processed.push(id);
    } catch (e) {
      if (e instanceof BudgetError) { console.warn('cron:budget', id, `used ${benv.BUDGET!.used()}`); break; }
      console.error('cron:tenant', id, (e as Error).message);
    }
  }
  return { processed };
}
