// 今日曝光：讀 Threads 帳號今天的瀏覽數，存進 account_daily；沒權限的帳號標記出來，首頁可提醒重新連結
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { upsertAccount } from '../src/threads/accounts';
import { refreshAccountViews } from '../src/threads/scheduler';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const NOW = new Date('2026-11-08T05:00:00Z'); // 台北 13:00

describe('today views per account', () => {
  it('today = cumulative views now − cumulative at the first read of the day (Threads splits days on US Pacific time)', async () => {
    const env: any = await makeEnv();
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    const b = await upsertAccount(env, 'b1', { userId: '2', username: 'old', token: 'B', expiresAt: null });
    const urls: string[] = [];
    let cur = 75; // 昨天美西那天的 75 次不能算進台灣的今天
    const m = mockFetch((u) => {
      urls.push(u);
      if (u.includes('/2/threads_insights')) return jres({ error: { code: 10, message: 'Application does not have permission for this action' } }, 403);
      return jres({ data: [{ name: 'views', period: 'day', values: [{ value: 75, end_time: '2026-11-07T08:00:00+0000' }, { value: cur - 75, end_time: '2026-11-08T08:00:00+0000' }] }] });
    }); restore = m.restore;
    const MID = new Date('2026-11-07T16:05:00Z'); // 台北 11/8 00:05，當天第一次讀
    await refreshAccountViews(env, MID);
    expect(urls[0]).toContain(`since=${Date.parse('2026-11-06T16:00:00Z') / 1000}`); // 起點固定在昨天 0 點
    let row: any = await env.DB.prepare('SELECT day,views,base_total FROM account_daily WHERE account_id=?').bind(a).first();
    expect(row).toEqual({ day: '2026-11-08', views: 0, base_total: 75 });
    expect(((await env.DB.prepare('SELECT insights_status s FROM threads_accounts WHERE id=?').bind(b).first()) as any).s).toBe('no_permission');
    const n = urls.length;
    await refreshAccountViews(env, new Date(MID.getTime() + 10 * 60000));
    expect(urls.length).toBe(n); // 30 分鐘內不重抓
    cur = 75 + 130;
    await refreshAccountViews(env, new Date(MID.getTime() + 5 * 3600000));
    row = await env.DB.prepare('SELECT views FROM account_daily WHERE account_id=?').bind(a).first();
    expect(row.views).toBe(130);
  });

  it('dashboard returns today views and accounts that need reconnecting', async () => {
    const env: any = await makeEnv();
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    await env.DB.prepare(`INSERT INTO account_daily(account_id,brand_id,day,views,fetched_at) VALUES(?,?,?,?,?)`).bind(a, 'b1', today, 321, new Date().toISOString()).run();
    const call = (method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
    const c = ((await call('POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const d: any = await (await call('GET', '/api/dashboard', undefined, c)).json();
    expect(d.views_today.map((r: any) => r.views)).toEqual([321]);
    expect(d.views_no_permission).toEqual([]);
  });
});
