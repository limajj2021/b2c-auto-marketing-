// Threads 偶爾回「資源不存在」：剛建立的 container 還沒準備好。要等一下重試，不行就換新的 container，不重複發已發出的則數
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishDue, runCron } from '../src/threads/scheduler';
import { budgeted } from '../src/budget';
import { timing } from '../src/threads/api';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
beforeAll(() => { timing.sleep = async () => {}; });
const NOW = new Date('2026-11-18T08:00:00Z');
const NOT_READY = () => jres({ error: { code: 24, message: 'The requested resource does not exist' } }, 400);
const insert = (env: any, parts: string[]) => env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1',?,?,'scheduled','2026-11-18T07:00:00Z','owner','x','x')`).bind(parts[0], JSON.stringify(parts)).run();

describe('publishing when Threads is not ready yet', () => {
  it('waits and retries the same container, then finishes the whole thread', async () => {
    const env: any = await makeEnv(); await insert(env, ['p1', 'p2', 'p3']);
    let n = 0, fails = 0;
    const m = mockFetch((u) => {
      if (u.endsWith('/threads_publish')) { if (n === 1 && fails < 2) { fails++; return NOT_READY(); } return jres({ id: `T${++n}` }); }
      return jres({ id: `C${n}` });
    }); restore = m.restore;
    await publishDue(env, NOW);
    const p: any = await env.DB.prepare('SELECT * FROM posts').first();
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2', 'T3']);
    expect(m.calls.filter((c) => c.url.endsWith('/threads')).length).toBe(3); // 沒有多建 container
  });

  it('keeps going still-not-ready: drops that container, says so in Chinese, and the next run resumes without re-posting', async () => {
    const env: any = await makeEnv(); await insert(env, ['p1', 'p2']);
    let n = 0, broken = true;
    let m = mockFetch((u) => {
      if (u.endsWith('/threads_publish')) return n === 1 && broken ? NOT_READY() : jres({ id: `T${++n}` });
      return jres({ id: `C${n}` });
    }); restore = m.restore;
    await publishDue(env, NOW);
    let p: any = await env.DB.prepare('SELECT * FROM posts').first();
    expect(p.status).toBe('scheduled'); expect(JSON.parse(p.part_ids)).toEqual(['T1']); expect(p.threads_creation_id).toBeNull();
    expect(p.error_message).toContain('暫時還沒準備好'); expect(p.error_message).toContain('自動接續');
    broken = false;
    await publishDue(env, NOW);
    p = await env.DB.prepare('SELECT * FROM posts').first();
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2']);
    const firstParts = m.calls.filter((c) => c.url.endsWith('/threads')).map((c) => new URLSearchParams(String(c.init?.body)).get('text'));
    expect(firstParts.filter((t) => t === 'p1').length).toBe(1); // 第 1 則只發過一次
  });

  it('with auto-posting off, still publishes posts a person approved, but not AI auto-approved ones', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`UPDATE brand_settings SET auto_post_enabled=0 WHERE brand_id='b1'`).run();
    await insert(env, ['human']);
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,scheduled_at,approved_by,updated_at,created_at) VALUES('b1','ai','["ai"]','scheduled','2026-11-18T07:00:00Z','auto','x','x')`).run();
    let n = 0; const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' })); restore = m.restore;
    await runCron(env, NOW);
    const rows: any[] = (await env.DB.prepare('SELECT content,status FROM posts ORDER BY id').all()).results;
    expect(rows).toEqual([{ content: 'human', status: 'published' }, { content: 'ai', status: 'scheduled' }]);
  });

  it('a long thread that does not fit in one run publishes what fits, then resumes next run without failing', async () => {
    const env: any = await makeEnv();
    await insert(env, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    let n = 0; const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' })); restore = m.restore;
    const b1: any = budgeted(env, 30); await publishDue(b1, NOW);
    let p: any = await env.DB.prepare('SELECT * FROM posts').first();
    const first = JSON.parse(p.part_ids).length;
    expect(first).toBeGreaterThan(0); expect(first).toBeLessThan(8);
    expect(p.status).toBe('scheduled'); expect(p.error_message).toContain('接續'); expect(p.attempts).toBe(0);
    for (let i = 0; i < 4 && p.status !== 'published'; i++) { await publishDue(budgeted(env, 30), NOW); p = await env.DB.prepare('SELECT * FROM posts').first(); }
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toHaveLength(8);
    expect(m.calls.filter((c) => c.url.endsWith('/threads_publish')).length).toBe(8); // 每則只發一次
  });
});
