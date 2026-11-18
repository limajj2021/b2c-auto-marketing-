// 全自動發文：每個帳號每天 1 篇；先讀過去貼文（系統內＋Threads 上）找沒寫過的題材，太像就換；寫完直接排程
import { afterEach, describe, expect, it } from 'vitest';
import { upsertAccount } from '../src/threads/accounts';
import { ensureSlots, runCron as runBrand } from '../src/threads/scheduler';
import { similarity } from '../src/ai/ideate';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const NOW = new Date('2026-11-08T01:00:00Z'); // 台北 09:00
const gemText = (text: string) => jres({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });

async function setup() {
  const env: any = await makeEnv();
  // 審核模式（B）＋一天 3 篇：全自動開啟後仍是一天 1 篇、而且不用審核
  await env.DB.prepare(`UPDATE brand_settings SET posting_mode='B', require_review=1, posts_per_day=3, publishing_times='["10:00","14:00","20:00"]', auto_post_enabled=0, auto_fresh_enabled=1`).run();
  const a = await upsertAccount(env, 'b1', { userId: '7', username: 'main', token: 'TOK', expiresAt: null });
  await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,parts,status,idea,published_at,updated_at,created_at) VALUES('b1',?,'房仲不要再做影片了','["房仲不要再做影片了","因為沒人看"]','published','房仲影片｜房仲做影片沒人看是因為開場太慢','x','x','x')`).bind(a).run();
  return { env, a };
}

describe('full-auto posting with fresh topics', () => {
  it('reads past posts, picks an unused idea, writes one post per day and schedules it without review', async () => {
    const { env } = await setup();
    const prompts: string[] = [];
    const m = mockFetch((u, i) => {
      if (u.includes('/threads?fields=')) return jres({ data: [{ id: '1', text: '舊貼文：買房要先看學區\n第二行' }] });
      const body = String(i?.body); prompts.push(body);
      if (body.includes('只想題材')) return gemText(JSON.stringify(body.includes('租一輩子不一定輸給買房') ? { topic: '預售屋陷阱', angle: '樣品屋越漂亮，你越該先看合約附表' } : { topic: '租屋族心態', angle: '租一輩子不一定輸給買房，關鍵在現金流' }));
      return gemText(JSON.stringify({ parts: ['鉤子', '結尾'] }));
    }); restore = m.restore;
    await ensureSlots(env, NOW); await ensureSlots(env, NOW);
    const rows: any[] = (await env.DB.prepare(`SELECT status,approved_by,idea,scheduled_at FROM posts WHERE slot_key IS NOT NULL ORDER BY scheduled_at`).all()).results;
    expect(rows.length).toBe(2); // 今天、明天各 1 篇（不是 3 篇）
    expect(rows.every((r: any) => r.status === 'scheduled' && r.approved_by === 'auto')).toBe(true);
    expect(rows[0].idea).toBe('租屋族心態｜租一輩子不一定輸給買房，關鍵在現金流');
    expect(rows[1].idea).toBe('預售屋陷阱｜樣品屋越漂亮，你越該先看合約附表'); // 第二天：今天的題材也算寫過了
    const ideaPrompt = prompts.find((p) => p.includes('只想題材'))!;
    expect(ideaPrompt).toContain('房仲做影片沒人看'); // 系統內的過去題材
    expect(ideaPrompt).toContain('買房要先看學區'); // Threads 帳號上實際發過的
    expect(prompts.some((p) => !p.includes('只想題材') && p.includes('租一輩子不一定輸給買房'))).toBe(true);
  });

  it('asks again when the idea is too close to something already written, and gives up rather than repeat', async () => {
    const { env } = await setup();
    let n = 0;
    const m = mockFetch((u, i) => {
      if (u.includes('/threads?fields=')) return jres({ data: [] });
      if (String(i?.body).includes('只想題材')) { n++; return gemText(JSON.stringify({ topic: '房仲影片', angle: '房仲做影片沒人看是因為開場太慢' })); }
      return gemText(JSON.stringify({ parts: ['x'] }));
    }); restore = m.restore;
    await ensureSlots(env, NOW);
    expect(n).toBeGreaterThanOrEqual(2);
    const r: any = await env.DB.prepare(`SELECT status,error_message FROM posts WHERE slot_key IS NOT NULL LIMIT 1`).first();
    expect(r.status).toBe('gen_failed'); expect(r.error_message).toContain('不重複');
  });

  it('runs generation even when the regular auto-post switch is off; off means nothing is generated', async () => {
    const { env } = await setup();
    const m = mockFetch((u, i) => u.includes('/threads?fields=') ? jres({ data: [] })
      : String(i?.body).includes('只想題材') ? gemText(JSON.stringify({ topic: '新題材', angle: '完全沒寫過的觀點' })) : gemText(JSON.stringify({ parts: ['x'] }))); restore = m.restore;
    await env.DB.prepare(`UPDATE brand_settings SET auto_fresh_enabled=0`).run();
    await runBrand(env, NOW);
    expect((await env.DB.prepare(`SELECT count(*) c FROM posts WHERE slot_key IS NOT NULL`).first() as any).c).toBe(0);
    await env.DB.prepare(`UPDATE brand_settings SET auto_fresh_enabled=1`).run();
    await runBrand(env, NOW);
    expect((await env.DB.prepare(`SELECT count(*) c FROM posts WHERE slot_key IS NOT NULL`).first() as any).c).toBe(2);
  });

  it('similarity catches reworded duplicates but not different topics', () => {
    expect(similarity('房仲做影片沒人看是因為開場太慢', '房仲影片｜房仲做影片沒人看，因為開場太慢了')).toBeGreaterThan(0.5);
    expect(similarity('租屋族心態｜租一輩子不一定輸', '房仲影片｜開場太慢')).toBeLessThan(0.3);
  });
});
