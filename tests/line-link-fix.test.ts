// 發布時把舊的或別的品牌的 LINE 連結換成品牌目前設定的連結（草稿寫好後品牌改過 LINE 設定）
import { describe, expect, it } from 'vitest';
import { fixLineLinks, trackedParts } from '../src/links';
import { makeEnv } from './helpers';

describe('stale LINE links are replaced at publish time', () => {
  it('replaces foreign line.me / lin.ee links, keeps the current ones', () => {
    const cur = ['https://line.me/R/ti/p/@new', 'https://lin.ee/abc'];
    expect(fixLineLinks(['加 LINE：https://line.me/R/ti/p/@old', '或 https://lin.ee/zzz', '這個對 https://lin.ee/abc'], cur, cur[0]))
      .toEqual(['加 LINE：https://line.me/R/ti/p/@new', '或 https://line.me/R/ti/p/@new', '這個對 https://lin.ee/abc']);
    expect(fixLineLinks(['沒有連結'], cur, cur[0])).toEqual(['沒有連結']);
  });

  it('a draft written with an old LINE id goes out with the tracked link to the current LINE', async () => {
    const env: any = await makeEnv();
    env.PUBLIC_BASE_URL = 'https://x.dev';
    const out = await trackedParts(env, { id: 9, brand_id: 'b1', account_id: null }, ['鉤子', '加 LINE https://line.me/R/ti/p/@033azwud']);
    expect(out[1]).toMatch(/^加 LINE https:\/\/x\.dev\/go\/\w+$/);
    const row: any = await env.DB.prepare('SELECT target_url FROM post_links WHERE post_id=9').first();
    expect(row.target_url).toBe('https://line.me/R/ti/p/@test');
  });
});
