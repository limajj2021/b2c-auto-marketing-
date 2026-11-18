// LINE 官方短網址（lin.ee）：設定後貼文直接用它，不再換成系統追蹤連結
import { describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { postLink } from '../src/ai/gemini';
import { trackedParts } from '../src/links';
import { makeEnv } from './helpers';

const call = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x.dev${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
const ck = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

describe('LINE short URL (lin.ee)', () => {
  it('saves only lin.ee links, can be cleared, and shows in settings', async () => {
    const env: any = await makeEnv();
    const c = ck(await call(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' }));
    expect((await call(env, 'PUT', '/api/settings', { line_short_url: 'https://evil.example/abc' }, c)).status).toBe(400);
    expect((await call(env, 'PUT', '/api/settings', { line_short_url: 'http://lin.ee/AbC123' }, c)).status).toBe(200);
    expect(((await (await call(env, 'GET', '/api/settings', undefined, c)).json()) as any).settings.line_short_url).toBe('https://lin.ee/AbC123');
    expect((await call(env, 'PUT', '/api/settings', { line_short_url: '' }, c)).status).toBe(200);
    expect(((await (await call(env, 'GET', '/api/settings', undefined, c)).json()) as any).settings.line_short_url).toBe('');
  });

  it('posts use the lin.ee link when set, and publishing leaves it as is', async () => {
    expect(postLink({ line_add_url: 'https://line.me/R/ti/p/@test', line_short_url: 'https://lin.ee/AbC123' })).toBe('https://lin.ee/AbC123');
    expect(postLink({ line_add_url: 'https://line.me/R/ti/p/@test', line_short_url: '' })).toBe('https://line.me/R/ti/p/@test');
    const env: any = await makeEnv(); env.PUBLIC_BASE_URL = 'https://x.dev';
    const parts = ['鉤子', '加 LINE 👇\nhttps://lin.ee/AbC123'];
    expect(await trackedParts(env, { id: 1, brand_id: 'b1', account_id: null } as any, parts)).toEqual(parts);
  });
});
