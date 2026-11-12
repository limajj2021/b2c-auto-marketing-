import { afterEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleApi } from '../src/admin/routes';
import { BudgetError, budgeted } from '../src/budget';
import { runAllTenants } from '../src/tenants';
import { publishDue, refreshInsights } from '../src/threads/scheduler';
import { upsertAccount } from '../src/threads/accounts';
import { hashPassword } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const NOW = new Date('2026-11-08T03:00:00Z');
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const adminCookie = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const LINE = 'https://line.me/R/ti/p/@test';

describe('subrequest budget (free plan safety)', () => {
  it('counts D1 calls and external fetches, throws once exhausted', async () => {
    const env = budgeted(await makeEnv(), 3);
    await env.DB.prepare('SELECT 1').first(); await env.DB.prepare('SELECT 1').first();
    const m = mockFetch(() => jres({})); restore = m.restore;
    await env.SUBFETCH!('https://example.com');
    expect(env.BUDGET!.remaining()).toBe(0);
    expect(() => env.DB.prepare('SELECT 1').first()).toThrow(BudgetError);
  });

  it('a tight budget leaves a long thread unpublished (not half-posted) and the next run finishes it', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','p1',?,'scheduled','2026-11-08T00:00:00Z','owner','x','x')`)
      .bind(JSON.stringify(['p1', 'p2', 'p3', 'p4', 'p5'])).run();
    await env.DB.prepare('UPDATE brand_settings SET auto_post_enabled=1').run();
    let n = 0; const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' })); restore = m.restore;
    env.CRON_SUBREQUEST_LIMIT = '20';
    await runAllTenants(env, NOW);
    expect(m.calls.length).toBe(0); // 額度不足以發完整串：一則都不發
    expect(((await env.DB.prepare('SELECT status FROM posts').first()) as any).status).toBe('scheduled');
    env.CRON_SUBREQUEST_LIMIT = '200';
    await runAllTenants(env, new Date(NOW.getTime() + 300000));
    const p: any = await env.DB.prepare('SELECT * FROM posts').first();
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids).length).toBe(5);
  });
});

describe('LINE link click tracking', () => {
  it('publishes with a tracked short link, counts human clicks only, redirects to LINE', async () => {
    const env: any = await makeEnv();
    env.PUBLIC_BASE_URL = 'https://app.dev';
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','h',?,'scheduled','2026-11-08T00:00:00Z','owner','x','x')`)
      .bind(JSON.stringify(['鉤子', `結尾\n\n加 LINE 諮詢 ${LINE}`])).run();
    const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: 'T' }) : jres({ id: 'C' })); restore = m.restore;
    await publishDue(env, NOW);
    const sent = m.calls.filter((c) => c.url.endsWith('/threads')).map((c) => new URLSearchParams(String(c.init?.body)).get('text'));
    const link = sent[1]!.match(/https:\/\/app\.dev\/go\/(\w+)/)!;
    expect(sent[1]).not.toContain(LINE);
    const hit = (ua: string, method = 'GET') => worker.fetch(new Request(`https://app.dev/go/${link[1]}`, { method, headers: { 'user-agent': ua } }), env);
    const r = await hit('Mozilla/5.0 (iPhone)');
    expect(r.status).toBe(302); expect(r.headers.get('location')).toBe(LINE);
    await hit('facebookexternalhit/1.1'); await hit('Mozilla/5.0', 'HEAD'); await hit('Mozilla/5.0 (Android)');
    expect(((await env.DB.prepare('SELECT clicks FROM post_links').first()) as any).clicks).toBe(2);
    expect(((await env.DB.prepare("SELECT count FROM metrics_daily WHERE name='link_click'").first()) as any).count).toBe(2);
    expect((await worker.fetch(new Request('https://app.dev/go/nope1234'), env)).status).toBe(404);
  });
});

describe('Threads insights & funnel', () => {
  it('stores insights per post; marks accounts without permission and stops asking until reconnect', async () => {
    const env: any = await makeEnv();
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,status,published_at,threads_post_id,updated_at,created_at) VALUES('b1',?,'x','published','2026-11-07T00:00:00Z','M1','x','x')`).bind(a).run();
    let m = mockFetch(() => jres({ error: { code: 10, message: 'Application does not have permission for this action' } }, 400)); restore = m.restore;
    await refreshInsights(env, NOW);
    expect(((await env.DB.prepare('SELECT insights_status s FROM threads_accounts').first()) as any).s).toBe('no_permission');
    await refreshInsights(env, NOW); expect(m.calls.length).toBe(1); // 不再重試
    m.restore();
    await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A2', expiresAt: null }); // 使用者加權限後重新連結
    m = mockFetch(() => jres({ data: [{ name: 'views', values: [{ value: 1200 }] }, { name: 'likes', total_value: { value: 35 } }, { name: 'replies', values: [{ value: 4 }] }] })); restore = m.restore;
    await refreshInsights(env, NOW);
    expect(await env.DB.prepare('SELECT views,likes,replies FROM post_metrics').first()).toEqual({ views: 1200, likes: 35, replies: 4 });
  });

  it('funnel aggregates exposure, engagement, clicks, friends and handoffs for the period', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,published_at,threads_post_id,updated_at,created_at) VALUES('b1','x',?,'published','2026-11-05T02:00:00Z','M1','x','x')`).bind(JSON.stringify(['爆文鉤子\n第二行', '結尾'])).run();
    await env.DB.prepare(`INSERT INTO post_metrics(post_id,brand_id,views,likes,replies,reposts,quotes,shares,fetched_at) VALUES(1,'b1',1000,40,5,3,0,2,'x')`).run();
    await env.DB.prepare(`INSERT INTO post_links(code,brand_id,post_id,target_url,clicks,created_at) VALUES('abc123de','b1',1,?,25,'x')`).bind(LINE).run();
    for (const [n, c] of [['link_click', 25], ['friend_add', 9], ['handoff', 3]]) await env.DB.prepare(`INSERT INTO metrics_daily(brand_id,day,name,count) VALUES('b1','2026-11-05',?,?)`).bind(n, c).run();
    const c = await adminCookie(env);
    const f: any = await (await api(env, 'GET', '/api/funnel?from=2026-11-01&to=2026-12-01', undefined, c)).json();
    expect(f.totals).toMatchObject({ posts: 1, views: 1000, likes: 40, clicks: 25, friends: 9, handoffs: 3 });
    expect(f.top[0]).toMatchObject({ hook: '爆文鉤子', views: 1000, clicks: 25 });
    expect(f.insights).toBe('ok');
  });
});

describe('operator roles', () => {
  it('support staff can view and reset customer passwords but cannot suspend, onboard or manage people', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare("UPDATE brands SET slug='acme'").run();
    await env.DB.prepare("INSERT INTO operators(username,password_hash,role,created_at) VALUES('boss',?,'admin','x')").bind(await hashPassword('operator-pass-1')).run();
    const login = async (u: string, p: string) => ((await api(env, 'POST', '/api/op/login', { username: u, password: p })).headers.get('set-cookie') ?? '').split(';')[0];
    const boss = await login('boss', 'operator-pass-1');
    const made: any = await (await api(env, 'POST', '/api/op/operators', { username: 'helper', role: 'support' }, boss)).json();
    const helper = await login('helper', made.password);
    expect((await api(env, 'GET', '/api/op/tenants', undefined, helper)).status).toBe(200);
    expect((await api(env, 'POST', '/api/op/tenants/acme/reset-admin', {}, helper)).status).toBe(200);
    expect((await api(env, 'PATCH', '/api/op/tenants/acme', { status: 'suspended' }, helper)).status).toBe(403);
    expect((await api(env, 'POST', '/api/op/tenants', { slug: 'x1', name: 'x' }, helper)).status).toBe(403);
    expect((await api(env, 'GET', '/api/op/operators', undefined, helper)).status).toBe(403);
    // 自己改密碼；管理者可停用人員，停用後立即無法使用
    expect((await api(env, 'POST', '/api/op/password', { current: made.password, next: 'a-much-longer-pass' }, helper)).status).toBe(200);
    expect((await api(env, 'PATCH', '/api/op/operators/1', { enabled: false }, boss)).status).toBe(400); // 不能停用自己
    expect((await api(env, 'PATCH', '/api/op/operators/2', { enabled: false }, boss)).status).toBe(200);
    expect((await api(env, 'GET', '/api/op/tenants', undefined, helper)).status).toBe(401);
  });
});
