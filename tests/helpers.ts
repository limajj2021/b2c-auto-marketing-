import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from '../src/util/crypto';
import type { Env } from '../src/types';

/** 以 node:sqlite 模擬 D1 介面（prepare/bind/first/all/run）。僅供單元/整合測試，不等同真實 D1 驗收。 */
export function fakeD1(db: DatabaseSync): D1Database {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) as any[] }),
    run: async () => {
      const r = db.prepare(sql).run(...(args as any[]));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

export async function makeEnv(opts: { industry?: string } = {}): Promise<Env> {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(join(process.cwd(), 'migrations')).sort()) db.exec(readFileSync(join(process.cwd(), 'migrations', f), 'utf8'));
  db.prepare("INSERT INTO brands(id,name,industry,description,timezone,created_at) VALUES('b1','測試品牌',?,'介紹','Asia/Taipei','2026-01-01')")
    .run(opts.industry ?? 'general');
  db.prepare("INSERT INTO brand_settings(brand_id,updated_at,line_add_url,cta_text) VALUES('b1','2026-01-01','https://line.me/R/ti/p/@test','加 LINE 諮詢')").run();
  db.prepare("INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES('b1','admin','boss',?)").run(await hashPassword('correct-horse-1'));
  db.prepare("INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES('b1','staff','cs',?)").run(await hashPassword('staff-password-1'));
  return {
    DB: fakeD1(db), ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    SESSION_SECRET: 's'.repeat(32), LINE_CHANNEL_SECRET: 'line-secret', LINE_CHANNEL_ACCESS_TOKEN: 'lt',
    THREADS_ACCESS_TOKEN: 'tt', THREADS_USER_ID: '123', GEMINI_API_KEY: 'gk',
    THREADS_APP_ID: 'app1', THREADS_APP_SECRET: 'appsecret',
  };
}

export type FetchMock = (url: string, init?: RequestInit) => Response | Promise<Response>;
export function mockFetch(fn: FetchMock) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any, init?: RequestInit) => { calls.push({ url: String(u), init }); return fn(String(u), init); }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
export const jres = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
