// 授權保護（多重防護）：
// 1. 資料庫觸發器：Threads 帳號／串接憑證被刪除或換掉時自動封存
// 2. 同一帳號重新連結時，從封存還原設定並接回歷史貼文
// 3. 中斷要輸入帳號名稱；「一次中斷全部」已移除
// 4. 靜態檢查：之後的 migration 與程式碼不能刪掉受保護的資料
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { setCred } from '../src/integrations';
import { removeAccounts, upsertAccount } from '../src/threads/accounts';
import { makeEnv } from './helpers';

const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];

describe('credential protection', () => {
  it('archives Threads accounts and credentials when they are deleted or replaced', async () => {
    const env: any = await makeEnv();
    const id = await upsertAccount(env, 'b1', { userId: 'u1', username: 'main', token: 'T1', expiresAt: null });
    await upsertAccount(env, 'b1', { userId: 'u1', username: 'main', token: 'T2', expiresAt: null }); // 重新授權：舊 token 封存
    await env.DB.prepare('DELETE FROM threads_accounts WHERE id=?').bind(id).run();
    const arc: any[] = (await env.DB.prepare('SELECT reason,id,username,token_enc FROM threads_accounts_archive ORDER BY archive_id').all()).results;
    expect(arc.map((r) => r.reason)).toEqual(['token_replaced', 'deleted']);
    expect(arc.every((r) => r.id === id && r.username === 'main' && r.token_enc)).toBe(true);
    await setCred(env, 'b1', 'line_channel_secret', 'a');
    await setCred(env, 'b1', 'line_channel_secret', 'b');
    await env.DB.prepare(`DELETE FROM integrations WHERE brand_id='b1'`).run();
    expect(((await env.DB.prepare('SELECT reason FROM integrations_archive ORDER BY archive_id').all()).results as any[]).map((r) => r.reason)).toEqual(['replaced', 'deleted']);
  });

  it('reconnecting a disconnected account restores its settings and reattaches its post history', async () => {
    const env: any = await makeEnv();
    const old = await upsertAccount(env, 'b1', { userId: 'u1', username: 'main', token: 'T1', expiresAt: null });
    await env.DB.prepare(`UPDATE threads_accounts SET persona='資深房仲',publishing_times='["20:00"]' WHERE id=?`).bind(old).run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,parts,status,published_at,updated_at,created_at) VALUES('b1',?,'舊文','["舊文"]','published','x','x','x')`).bind(old).run();
    await removeAccounts(env, { brandId: 'b1', id: old });
    const nu = await upsertAccount(env, 'b1', { userId: 'u1', username: 'main', token: 'T9', expiresAt: null });
    expect(nu).not.toBe(old);
    const a: any = await env.DB.prepare('SELECT persona,publishing_times FROM threads_accounts WHERE id=?').bind(nu).first();
    expect(a).toEqual({ persona: '資深房仲', publishing_times: '["20:00"]' });
    expect(((await env.DB.prepare(`SELECT account_id FROM posts WHERE content='舊文'`).first()) as any).account_id).toBe(nu);
    // 別的帳號不會被接上
    const other = await upsertAccount(env, 'b1', { userId: 'u2', username: 'other', token: 'X', expiresAt: null });
    expect(((await env.DB.prepare('SELECT persona FROM threads_accounts WHERE id=?').bind(other).first()) as any).persona).toBe('');
  });

  it('disconnecting needs the account name typed in; disconnect-all no longer exists', async () => {
    const env: any = await makeEnv(); const c = await login(env);
    const id = await upsertAccount(env, 'b1', { userId: 'u1', username: 'Main.Acct', token: 'T1', expiresAt: null });
    expect((await api(env, 'DELETE', `/api/accounts/${id}`, undefined, c)).status).toBe(400);
    expect((await api(env, 'DELETE', `/api/accounts/${id}?confirm=other`, undefined, c)).status).toBe(400);
    expect((await env.DB.prepare('SELECT count(*) n FROM threads_accounts').first() as any).n).toBe(1);
    expect((await api(env, 'DELETE', '/api/integrations/threads', undefined, c)).status).not.toBe(200);
    expect((await env.DB.prepare('SELECT count(*) n FROM threads_accounts').first() as any).n).toBe(1);
    expect((await api(env, 'DELETE', `/api/accounts/${id}?confirm=%40main.acct`, undefined, c)).status).toBe(200);
  });
});

describe('guards against future changes wiping protected data', () => {
  const PROTECTED = ['threads_accounts', 'integrations', 'threads_accounts_archive', 'integrations_archive', 'post_links', 'oauth_tokens', 'oauth_clients'];
  it('no migration after 0021 drops, empties or rewrites the token of a protected table, or drops the archive triggers', () => {
    const files = readdirSync(join(process.cwd(), 'migrations')).filter((f) => f > '0021');
    for (const f of files) {
      const sql = readFileSync(join(process.cwd(), 'migrations', f), 'utf8').replace(/--.*$/gm, '');
      for (const t of PROTECTED) {
        expect(sql, `${f} 不可以 DROP ${t}`).not.toMatch(new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${t}\\b`, 'i'));
        expect(sql, `${f} 不可以 DELETE FROM ${t}`).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'i'));
        expect(sql, `${f} 不可以重新命名 ${t}`).not.toMatch(new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+RENAME`, 'i'));
      }
      expect(sql, `${f} 不可以改寫 token`).not.toMatch(/SET\s+(token_enc|value_enc)\s*=/i);
      expect(sql, `${f} 不可以刪掉封存觸發器`).not.toMatch(/DROP\s+TRIGGER/i);
    }
  });

  it('only the designated functions may delete Threads accounts or credentials', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    const allowed: Record<string, string[]> = { threads_accounts: ['src/threads/accounts.ts'], integrations: ['src/integrations.ts', 'src/threads/accounts.ts'] };
    for (const f of walk(join(process.cwd(), 'src')).filter((x) => x.endsWith('.ts'))) {
      const rel = f.slice(process.cwd().length + 1), src = readFileSync(f, 'utf8');
      for (const [t, ok] of Object.entries(allowed)) if (new RegExp(`DELETE\\s+FROM\\s+${t}\\b`, 'i').test(src)) expect(ok, `${rel} 不可以直接刪除 ${t}`).toContain(rel);
      expect(src, `${rel} 不可以 DROP 資料表`).not.toMatch(/DROP\s+TABLE/i);
    }
  });
});
