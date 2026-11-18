// Threads 主題標籤：品牌預設＋每篇可覆寫；發布時只在第 1 則用 topic_tag 參數帶入
import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { publishDue } from '../src/threads/scheduler';
import { effectiveTag, normTopicTag } from '../src/threads/topic';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const login = async (env: any) => ((await call(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const NOW = new Date('2026-11-18T08:00:00Z');

describe('topic tag rules', () => {
  it('strips #, allows spaces and CJK, rejects dots, & and over 50 chars', () => {
    expect(normTopicTag('#短影音剪輯')).toBe('短影音剪輯');
    expect(normTopicTag('  Threads  Tips ')).toBe('Threads Tips');
    expect(normTopicTag('')).toBe('');
    expect(normTopicTag('a.b')).toBeNull(); expect(normTopicTag('R&D')).toBeNull(); expect(normTopicTag('字'.repeat(51))).toBeNull();
    expect(effectiveTag(null, '預設')).toBe('預設'); expect(effectiveTag('', '預設')).toBe(''); expect(effectiveTag('這篇', '預設')).toBe('這篇');
  });
});

describe('topic tag in settings, drafts and publishing', () => {
  it('brand default goes on the first part only; a post can override or turn it off', async () => {
    const env: any = await makeEnv(); const c = await login(env);
    expect((await call(env, 'PUT', '/api/settings', { topic_tag: 'a.b' }, c)).status).toBe(400);
    expect((await call(env, 'PUT', '/api/settings', { topic_tag: '#短影音剪輯' }, c)).status).toBe(200);
    expect(((await (await call(env, 'GET', '/api/settings', undefined, c)).json()) as any).settings.topic_tag).toBe('短影音剪輯');
    const add = (parts: string[]) => env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1',?,?,'draft','x','x')`).bind(parts[0], JSON.stringify(parts)).run();
    await add(['預設1', '預設2']); await add(['覆寫']); await add(['不加']);
    expect((await call(env, 'PUT', '/api/posts/2', { parts: ['覆寫'], topic_tag: '房仲' }, c)).status).toBe(200);
    expect((await call(env, 'PUT', '/api/posts/3', { parts: ['不加'], topic_tag: '' }, c)).status).toBe(200);
    expect((await call(env, 'PUT', '/api/posts/3', { parts: ['不加'], topic_tag: 'x&y' }, c)).status).toBe(400);
    const list = (await (await call(env, 'GET', '/api/posts', undefined, c)).json()) as any[];
    expect(list.find((p) => p.id === 2).topic_tag).toBe('房仲'); expect(list.find((p) => p.id === 1).topic_tag).toBeNull();
    await env.DB.prepare(`UPDATE posts SET status='scheduled',scheduled_at='2026-11-18T07:00:00Z',approved_by='boss'`).run();
    let n = 0; const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' })); restore = m.restore;
    await publishDue(env, NOW);
    const creates = m.calls.filter((x) => x.url.endsWith('/threads')).map((x) => Object.fromEntries(new URLSearchParams(String(x.init?.body))));
    const byText = Object.fromEntries(creates.map((x) => [x.text, x.topic_tag ?? null]));
    expect(byText).toEqual({ 預設1: '短影音剪輯', 預設2: null, 覆寫: '房仲', 不加: null });
    // 標籤不會寫進內文
    expect(creates.every((x) => !String(x.text).includes('#'))).toBe(true);
  });

  it('saving a draft without topic_tag leaves the post tag unchanged; null returns to the brand default', async () => {
    const env: any = await makeEnv(); const c = await login(env);
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,topic_tag,updated_at,created_at) VALUES('b1','a','["a"]','draft','舊','x','x')`).run();
    await call(env, 'PUT', '/api/posts/1', { parts: ['a2'] }, c);
    expect(((await env.DB.prepare('SELECT topic_tag FROM posts').first()) as any).topic_tag).toBe('舊');
    await call(env, 'PUT', '/api/posts/1', { parts: ['a2'], topic_tag: null }, c);
    expect(((await env.DB.prepare('SELECT topic_tag FROM posts').first()) as any).topic_tag).toBeNull();
  });
});
