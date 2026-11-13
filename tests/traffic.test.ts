// 短連結轉換率：不重複點擊人數、每篇導流排行、推估每篇帶來的好友
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleApi } from '../src/admin/routes';
import { buildTraffic, slotOf } from '../src/attribution';
import { pruneVisitors } from '../src/links';
import { makeEnv } from './helpers';

const LINE = 'https://line.me/R/ti/p/@test';
const api = (env: any, method: string, path: string, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const cookie = async (env: any) => ((await handleApi(env, new Request('https://x/api/login', { method: 'POST', body: JSON.stringify({ username: 'boss', password: 'correct-horse-1' }),
  headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui' } }))).headers.get('set-cookie') ?? '').split(';')[0];

describe('unique clicks (same visitor, same link, same day counts once)', () => {
  it('counts repeat clicks but one person once; different people separately; stores no address', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO post_links(code,brand_id,post_id,target_url,created_at) VALUES('abc123de','b1',7,?,'x')`).bind(LINE).run();
    const hit = (ip: string, ua = 'Mozilla/5.0 (iPhone)') => worker.fetch(new Request('https://app.dev/go/abc123de', { headers: { 'user-agent': ua, 'cf-connecting-ip': ip } }), env);
    await hit('1.1.1.1'); await hit('1.1.1.1'); await hit('1.1.1.1'); await hit('2.2.2.2'); await hit('1.1.1.1', 'Mozilla/5.0 (Android)');
    expect(await env.DB.prepare('SELECT clicks,uniques FROM post_links').first()).toEqual({ clicks: 5, uniques: 3 });
    const d = await env.DB.prepare('SELECT post_id,clicks,uniques FROM link_daily').first();
    expect(d).toEqual({ post_id: 7, clicks: 5, uniques: 3 });
    const m = (await env.DB.prepare("SELECT name,count FROM metrics_daily ORDER BY name").all()).results;
    expect(m).toEqual([{ name: 'link_click', count: 5 }, { name: 'link_unique', count: 3 }]);
    const stored = JSON.stringify((await env.DB.prepare('SELECT * FROM link_visitors').all()).results);
    expect(stored).not.toContain('1.1.1.1'); expect(stored).not.toContain('iPhone');
    await pruneVisitors(env, new Date(Date.now() + 3 * 86400000));
    expect(((await env.DB.prepare('SELECT COUNT(*) c FROM link_visitors').first()) as any).c).toBe(0);
  });
});

describe('traffic attribution (estimated)', () => {
  const posts = [
    { id: 1, hook: 'A', username: 'main', published_at: '2026-11-05T01:00:00Z', views: 1000, clicks: 40, uniques: 30 },  // 台北 09:00
    { id: 2, hook: 'B', username: 'main', published_at: '2026-11-05T11:00:00Z', views: 200, clicks: 25, uniques: 20 },   // 台北 19:00
    { id: 3, hook: 'C', username: 'alt', published_at: '2026-11-06T04:30:00Z', views: 20, clicks: 3, uniques: 3 },      // 曝光太少，不算點擊率
  ];
  const daily = [
    { day: '2026-11-05', post_id: 1, uniques: 30 }, { day: '2026-11-05', post_id: 2, uniques: 10 },
    { day: '2026-11-06', post_id: 2, uniques: 10 }, { day: '2026-11-06', post_id: 3, uniques: 3 },
  ];
  const friends = new Map([['2026-11-05', 8], ['2026-11-06', 13], ['2026-11-07', 4]]);

  it('splits each day’s new friends by that day’s unique clicks; friends on days without clicks are "other"', () => {
    const t = buildTraffic(posts, daily, friends, 'Asia/Taipei', true);
    const by = Object.fromEntries(t.posts.map((p) => [p.id, p]));
    expect(by[1].est_friends).toBe(6);    // 8 × 30/40
    expect(by[2].est_friends).toBe(12);   // 8 × 10/40 + 13 × 10/13
    expect(by[3].est_friends).toBe(3);    // 13 × 3/13
    expect(t.other_friends).toBe(4); expect(t.attributed_friends).toBe(21);
    expect(t.posts.map((p) => p.id)).toEqual([2, 1, 3]); // 點擊率 B 10% > A 3%；C 曝光不足排最後
    expect(by[3].ctr).toBeNull();
    expect(t.by_account.map((g) => [g.key, g.posts, g.uniques, g.est_friends])).toEqual([['@main', 2, 50, 18], ['@alt', 1, 3, 3]]);
    expect(t.by_slot.map((g) => g.key)).toEqual(['晚上 18–23', '上午 09–12', '午間 12–14']);
    expect(t.unique_since).toBe('2026-11-05');
  });

  it('posts from before unique tracking fall back to click counts instead of 0 people', () => {
    const t = buildTraffic([{ id: 9, hook: 'old', username: null, published_at: '2026-11-01T01:00:00Z', views: 2000, clicks: 100, uniques: 0 }], [], new Map(), 'Asia/Taipei', true);
    expect(t.posts[0]).toMatchObject({ legacy: true, uniques: 100, ctr: 0.05, est_friends: null });
  });

  it('shows no friend estimates when LINE data is not connected', () => {
    const t = buildTraffic(posts, daily, new Map(), 'Asia/Taipei', false);
    expect(t.posts.every((p) => p.est_friends === null)).toBe(true);
    expect(slotOf('2026-11-05T16:00:00Z', 'Asia/Taipei')).toBe('深夜 23–05'); // 台北 00:00
  });

  it('report API returns the traffic ranking and unique clicks', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,status,published_at,updated_at,created_at) VALUES('b1','爆文鉤子','published','2026-11-05T02:00:00Z','x','x')`).run();
    await env.DB.prepare(`INSERT INTO post_metrics(post_id,brand_id,views,likes,replies,reposts,quotes,shares,fetched_at) VALUES(1,'b1',1000,1,1,0,0,0,'x')`).run();
    await env.DB.prepare(`INSERT INTO post_links(code,brand_id,post_id,target_url,clicks,uniques,created_at) VALUES('abc123de','b1',1,?,60,50,'x')`).bind(LINE).run();
    await env.DB.prepare(`INSERT INTO link_daily(brand_id,post_id,day,clicks,uniques) VALUES('b1',1,'2026-11-05',60,50)`).run();
    for (const [n, c] of [['link_click', 60], ['link_unique', 50], ['friend_add', 10]]) await env.DB.prepare(`INSERT INTO metrics_daily(brand_id,day,name,count) VALUES('b1','2026-11-05',?,?)`).bind(n, c).run();
    env.LINE_CHANNEL_ACCESS_TOKEN = 'T';
    await env.DB.prepare('UPDATE brand_settings SET leads_enabled=0').run();
    const f: any = await (await api(env, 'GET', '/api/funnel?from=2026-11-01&to=2026-12-01', await cookie(env))).json();
    expect(f.totals).toMatchObject({ clicks: 60, unique_clicks: 50, friends: 10, friends_source: 'daily' });
    expect(f.traffic.posts[0]).toMatchObject({ hook: '爆文鉤子', uniques: 50, ctr: 0.05, est_friends: 10 });
  });
});
