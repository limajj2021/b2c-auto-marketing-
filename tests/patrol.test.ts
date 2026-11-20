// 半自動海巡：關鍵字 → 固定回覆範本；貼上別人的貼文連結後推薦範本，並記錄避免重複回覆
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { fill, parsePostUrl, rank } from '../src/patrol';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any, username: string, password: string) => ((await call(env, 'POST', '/api/login', { username, password })).headers.get('set-cookie') ?? '').split(';')[0];
const URL1 = 'https://www.threads.com/@someone.tw/post/DRoXhSwkRAV?xmt=abc';

describe('patrol helpers', () => {
  it('reads author and shortcode from threads.com / threads.net links, rejects other links', () => {
    expect(parsePostUrl(URL1)).toEqual({ author: 'someone.tw', shortcode: 'DRoXhSwkRAV' });
    expect(parsePostUrl('https://threads.net/@a.b/post/ABCDE12')).toEqual({ author: 'a.b', shortcode: 'ABCDE12' });
    expect(parsePostUrl('https://evil.example/@a/post/ABCDE12')).toBeNull();
    expect(parsePostUrl('https://www.threads.com/@a')).toBeNull();
  });
  it('ranks by keyword hits, then by use, skips disabled; fills {LINE} and {品牌}', () => {
    const t = (id: number, keywords: string[], uses = 0, enabled = true) => ({ id, title: '', keywords, reply: 'r', enabled, uses });
    const r = rank([t(1, ['剪輯'], 9), t(2, ['推薦剪輯', '剪片']), t(3, ['剪片'], 0, false)], '有人可以推薦剪輯師嗎？想找人剪片');
    expect(r.map((x) => x.id)).toEqual([2, 1]); expect(r[0].hits).toEqual(['推薦剪輯', '剪片']);
    expect(fill('我們是{品牌} 👇\n{LINE}', { line: 'https://lin.ee/x', brand: 'VUCA' })).toBe('我們是VUCA 👇\nhttps://lin.ee/x');
  });
});

describe('patrol API', () => {
  it('admins manage templates; match suggests filled replies; logging marks the post as replied', async () => {
    const env: any = await makeEnv(); const c = await login(env, 'boss', 'correct-horse-1');
    expect((await call(env, 'POST', '/api/patrol/templates', { reply: '' }, c)).status).toBe(400);
    await call(env, 'POST', '/api/patrol/templates', { title: '找剪輯', keywords: '推薦剪輯、剪片', reply: '我們是{品牌}，可以免費試剪 👇\n{LINE}' }, c);
    await call(env, 'POST', '/api/patrol/templates', { title: '通用', keywords: [], reply: '謝謝分享！' }, c);
    expect((await call(env, 'POST', '/api/patrol/match', { url: 'https://example.com/x' }, c)).status).toBe(400);
    const m = (await (await call(env, 'POST', '/api/patrol/match', { url: URL1, text: '求推薦剪輯師' }, c)).json()) as any;
    expect(m.author).toBe('someone.tw'); expect(m.replied).toBeNull();
    expect(m.templates[0].title).toBe('找剪輯'); expect(m.templates[0].hits).toEqual(['推薦剪輯']);
    expect(m.templates[0].reply).toBe('我們是測試品牌，可以免費試剪 👇\nhttps://line.me/R/ti/p/@test');
    await call(env, 'POST', '/api/patrol/log', { url: URL1, template_id: m.templates[0].id }, c);
    await call(env, 'POST', '/api/patrol/log', { url: URL1, template_id: m.templates[0].id }, c); // 重複按不重複計
    const again = (await (await call(env, 'POST', '/api/patrol/match', { url: URL1 }, c)).json()) as any;
    expect(again.replied.by).toBeTruthy();
    const list = (await (await call(env, 'GET', '/api/patrol/templates', undefined, c)).json()) as any[];
    expect(list.find((t) => t.title === '找剪輯').uses).toBe(1);
  });

  it('uses the lin.ee link when set; staff can patrol but not edit templates; brands are isolated', async () => {
    const env: any = await makeEnv(); const c = await login(env, 'boss', 'correct-horse-1');
    await call(env, 'PUT', '/api/settings', { line_short_url: 'https://lin.ee/AbC123' }, c);
    await call(env, 'POST', '/api/patrol/templates', { reply: '{LINE}' }, c);
    const staff = await login(env, 'cs', 'staff-password-1');
    expect((await call(env, 'POST', '/api/patrol/templates', { reply: 'x' }, staff)).status).toBe(403);
    const m = (await (await call(env, 'POST', '/api/patrol/match', { url: URL1 }, staff)).json()) as any;
    expect(m.templates[0].reply).toBe('https://lin.ee/AbC123');
    await env.DB.prepare(`INSERT INTO patrol_templates(brand_id,title,keywords,reply,created_at,updated_at) VALUES('other','x','[]','別人的','x','x')`).run();
    const list = (await (await call(env, 'GET', '/api/patrol/templates', undefined, c)).json()) as any[];
    expect(list.map((t) => t.reply)).toEqual(['{LINE}']);
    expect((await call(env, 'DELETE', `/api/patrol/templates/${(await env.DB.prepare(`SELECT id FROM patrol_templates WHERE brand_id='other'`).first()).id}`, undefined, c)).status).toBe(404);
  });
});
