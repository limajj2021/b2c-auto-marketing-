import { afterEach, describe, expect, it } from 'vitest';
import { checkContent } from '../src/ai/compliance';
import { ensureSlots, publishDue, reconcile, runCron } from '../src/threads/scheduler';
import { jres, makeEnv, mockFetch } from './helpers';
import { localDate, zonedToUtc } from '../src/util/time';

let restore = () => {};
afterEach(() => restore());
const NOW = new Date('2026-11-08T01:00:00Z'); // 台北 09:00
const gemini = (text = '這是一則測試貼文') => jres({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } });

describe('time', () => {
  it('converts Taipei local time to UTC', () => {
    expect(zonedToUtc('2026-11-08', '10:00', 'Asia/Taipei').toISOString()).toBe('2026-11-08T02:00:00.000Z');
    expect(localDate(new Date('2026-11-07T17:00:00Z'), 'Asia/Taipei')).toBe('2026-11-08');
  });
});

describe('compliance', () => {
  it('blocks guarantee claims and numeric rates for lending', () => {
    expect(checkContent('保證核貸，免審核', { industry: 'general', bannedWords: [] }).length).toBeGreaterThan(0);
    expect(checkContent('年利率 3% 起', { industry: 'lending', bannedWords: [] }).length).toBeGreaterThan(0);
    expect(checkContent('歡迎諮詢', { industry: 'lending', bannedWords: [] })).toEqual([]);
    expect(checkContent('含禁詞X', { industry: 'general', bannedWords: ['禁詞X'] }).length).toBe(1);
  });
});

describe('scheduler', () => {
  it('generates slots once (no duplicates on repeated cron) and logs usage', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET posts_per_day=2, posting_mode='A', auto_post_enabled=1").run();
    const m = mockFetch((u) => gemini()); restore = m.restore;
    await ensureSlots(env, NOW); await ensureSlots(env, NOW);
    const posts = await env.DB.prepare('SELECT * FROM posts').all<any>();
    expect(posts.results.length).toBe(4); // 今天 + 明天，各 2 篇
    expect(posts.results.every((p: any) => p.status === 'scheduled' && p.content.includes('https://line.me'))).toBe(true);
    const g = await env.DB.prepare('SELECT SUM(input_tokens) i, COUNT(*) c FROM ai_generations').first<any>();
    expect(g.c).toBe(4); expect(g.i).toBe(40);
  });

  it('lending industry forces drafts even in Mode A', async () => {
    const env = await makeEnv({ industry: 'lending' });
    await env.DB.prepare("UPDATE brand_settings SET posting_mode='A', auto_post_enabled=1").run();
    const m = mockFetch(() => gemini()); restore = m.restore;
    await ensureSlots(env, NOW);
    const r = await env.DB.prepare("SELECT DISTINCT status s FROM posts").all<any>();
    expect(r.results.map((x: any) => x.s)).toEqual(['draft']);
  });

  it('non-compliant text never auto-schedules', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET posting_mode='A'").run();
    const m = mockFetch(() => gemini('保證核貸，百分之百過件')); restore = m.restore;
    await ensureSlots(env, NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE status='scheduled'").first<any>()).c).toBe(0);
  });

  it('stops generating when daily quota reached, keeps drafts', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET posting_mode='B', daily_gen_limit=1, posts_per_day=3").run();
    const m = mockFetch(() => gemini()); restore = m.restore;
    await ensureSlots(env, NOW);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE status='draft'").first<any>()).c).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM posts WHERE status='generating'").first<any>()).c).toBe(0);
  });

  it('publishes via two-step API once; second run does not republish', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','hello','scheduled','2026-11-08T00:00:00Z','auto','x','x')").run();
    const m = mockFetch((u) => u.endsWith('/threads') ? jres({ id: 'c1' }) : jres({ id: 'T1' })); restore = m.restore;
    await publishDue(env, NOW); await publishDue(env, NOW);
    expect(m.calls.length).toBe(2);
    const p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    expect(p.status).toBe('published'); expect(p.threads_post_id).toBe('T1');
  });

  it('never publishes unapproved posts', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,updated_at,created_at) VALUES('b1','hello','scheduled','2026-11-08T00:00:00Z','x','x')").run();
    const m = mockFetch(() => jres({ id: 'x' })); restore = m.restore;
    await publishDue(env, NOW);
    expect(m.calls.length).toBe(0);
  });

  it('unknown outcome is reconciled against platform, not blindly retried', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','hello','scheduled','2026-11-08T00:00:00Z','auto','x','x')").run();
    let step = 0;
    let m = mockFetch((u) => { step++; if (step === 1) return jres({ id: 'c1' }); throw new Error('network down'); }); restore = m.restore;
    await publishDue(env, NOW);
    expect((await env.DB.prepare('SELECT status FROM posts').first<any>()).status).toBe('unknown');
    m.restore();
    m = mockFetch(() => jres({ data: [{ id: 'T9', text: 'hello', timestamp: '2026-11-08T01:00:00Z' }] })); restore = m.restore;
    await reconcile(env, NOW);
    const p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    expect(p.status).toBe('published'); expect(p.threads_post_id).toBe('T9');
    expect(m.calls.every((c) => !c.url.includes('threads_publish'))).toBe(true);
  });

  it('token failure flags token_invalid and halts publishing', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO posts(brand_id,content,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','hello','scheduled','2026-11-08T00:00:00Z','auto','x','x')").run();
    const m = mockFetch(() => jres({ error: { code: 190, message: 'expired' } }, 400)); restore = m.restore;
    await publishDue(env, NOW);
    expect((await env.DB.prepare('SELECT threads_status s FROM brand_settings').first<any>()).s).toBe('token_invalid');
    const n = m.calls.length;
    await publishDue(env, NOW);
    expect(m.calls.length).toBe(n);
  });

  it('paused automation does nothing in cron', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => gemini()); restore = m.restore;
    await runCron(env, NOW);
    expect(m.calls.length).toBe(0);
  });
});
