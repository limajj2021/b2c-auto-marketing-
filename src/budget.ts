// 排程用量保護：Cloudflare 對每次執行的「對外請求」有上限（免費方案 50 次，資料庫查詢也算在內）。
// 排程期間所有資料庫查詢與對外呼叫都會被計數，快用完時停止，剩下的工作留到下一輪。
import type { Env } from './types';

export class BudgetError extends Error { constructor() { super('本輪排程的請求額度已用完，剩餘工作留到下一輪'); } }

export interface Budget { remaining(): number; used(): number }

export function budgeted(env: Env, limit: number): Env {
  let used = 0;
  const take = () => { if (used >= limit) throw new BudgetError(); used++; };
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, {
    get(t, k) {
      if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a));
      if (k === 'first' || k === 'all' || k === 'run' || k === 'raw') return (...a: unknown[]) => { take(); return (t as any)[k](...a); };
      return (t as any)[k];
    },
  });
  const DB = new Proxy(env.DB, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (k === 'batch' || k === 'exec') return (...a: unknown[]) => { take(); return (t as any)[k](...a); };
      return (t as any)[k];
    },
  });
  const SUBFETCH = ((input: RequestInfo | URL, init?: RequestInit) => { take(); return fetch(input, init); }) as typeof fetch;
  const BUDGET: Budget = { remaining: () => limit - used, used: () => used };
  return { ...env, DB, SUBFETCH, BUDGET };
}

/** 對外呼叫一律經過這裡，排程時會被計數。 */
export const xfetch = (env: Pick<Env, 'SUBFETCH'>): typeof fetch => env.SUBFETCH ?? fetch;
/** 剩餘額度是否足夠做一件預估要用 n 次請求的工作（非排程時永遠足夠）。 */
export const canAfford = (env: Env, n: number) => !env.BUDGET || env.BUDGET.remaining() >= n;
