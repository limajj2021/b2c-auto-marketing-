import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { appendCta, buildPrompt, parseParts } from '../src/ai/gemini';
import { listAccounts, upsertAccount } from '../src/threads/accounts';
import { ensureSlots, publishDue, reconcile } from '../src/threads/scheduler';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
const NOW = new Date('2026-11-08T01:00:00Z'); // 台北 09:00
const gem = (parts: string[]) => jres({ candidates: [{ content: { parts: [{ text: JSON.stringify({ parts }) }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } });

async function api(env: any, method: string, path: string, body?: unknown, cookie?: string) {
  return handleApi(env, new Request(`https://x.dev${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));
}
const admin = async (env: any) => ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
const insertThread = (env: any, parts: string[], extra = '') =>
  env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,scheduled_at,approved_by,updated_at,created_at${extra ? ',account_id' : ''}) VALUES('b1',?,?,'scheduled','2026-11-08T00:00:00Z','owner','x','x'${extra ? ',' + extra : ''})`)
    .bind(parts[0], JSON.stringify(parts)).run();

describe('thread generation', () => {
  it('parses JSON parts, falls back to single text, appends CTA only to the last part', () => {
    expect(parseParts('{"parts":["a","b"]}')).toEqual(['a', 'b']);
    expect(parseParts('```json\n{"parts":["x"]}\n```')).toEqual(['x']);
    expect(parseParts('純文字貼文')).toEqual(['純文字貼文']);
    expect(appendCta(['鉤子', '結尾'], '加 LINE', 'https://line.me/x')).toEqual(['鉤子', '結尾\n\n加 LINE https://line.me/x']);
  });

  it('prompt encodes the viral template, hook/CTA structure, persona and fact-bank rule', () => {
    const p = buildPrompt({ id: 'b', name: 'VUCA', industry: 'general', description: 'd', timezone: 'Asia/Taipei' },
      { style_preset: '爭議化、數據化、具體化', thread_min: 4, thread_max: 7, fact_bank: '贊助平均 3 萬（2025 調查）', content_tone: 't', content_topics: '[]', banned_words: '[]', services: '', audience: '' } as any,
      { account: { persona: '毒舌行銷顧問' } as any, topic: '活動贊助' });
    for (const k of ['爭議化、數據化、具體化', '4 到 7 則', '第 1 則是鉤子', '最後一則', '毒舌行銷顧問', '贊助平均 3 萬', '【待補數據', '活動贊助']) expect(p).toContain(k);
  });

  it('placeholder data blocks approval until replaced', async () => {
    const env = await makeEnv(); const c = await admin(env);
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b1','h',?,'draft','x','x')`).bind(JSON.stringify(['鉤子', '有【待補數據：平均金額】的人'])).run();
    const r = await api(env, 'POST', '/api/posts/1/approve', {}, c);
    expect(r.status).toBe(422); expect((await r.json() as any).error).toContain('第 2 則');
    await api(env, 'PUT', '/api/posts/1', { parts: ['鉤子', '平均約 3 萬'] }, c);
    expect((await api(env, 'POST', '/api/posts/1/approve', {}, c)).status).toBe(200);
  });
});

describe('thread publishing', () => {
  it('publishes a chain with reply_to_id linking each part to the previous one', async () => {
    const env = await makeEnv();
    await insertThread(env, ['p1', 'p2', 'p3']);
    let n = 0;
    const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: `C${n}` })); restore = m.restore;
    await publishDue(env, NOW);
    const creates = m.calls.filter((c) => c.url.endsWith('/threads')).map((c) => Object.fromEntries(new URLSearchParams(String(c.init?.body))));
    expect(creates.map((c) => [c.text, c.reply_to_id])).toEqual([['p1', undefined], ['p2', 'T1'], ['p3', 'T2']]);
    const p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2', 'T3']); expect(p.threads_post_id).toBe('T1');
  });

  it('missing reply permission stops mid-chain; retry resumes from the failed part without re-posting', async () => {
    const env = await makeEnv(); const c = await admin(env);
    await insertThread(env, ['p1', 'p2', 'p3']);
    let n = 0;
    let m = mockFetch((u, i) => {
      const b = new URLSearchParams(String(i?.body));
      if (u.endsWith('/threads') && b.get('reply_to_id')) return jres({ error: { code: 10, message: 'Application does not have permission' } }, 400);
      return u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' });
    }); restore = m.restore;
    await publishDue(env, NOW);
    let p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    expect(p.status).toBe('failed'); expect(p.error_message).toContain('threads_manage_replies'); expect(JSON.parse(p.part_ids)).toEqual(['T1']);
    m.restore();
    m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: `T${++n}` }) : jres({ id: 'C' })); restore = m.restore;
    expect((await api(env, 'POST', '/api/posts/1/retry', {}, c)).status).toBe(200);
    await publishDue(env, NOW);
    p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    const texts = m.calls.filter((x) => x.url.endsWith('/threads')).map((x) => new URLSearchParams(String(x.init?.body)).get('text'));
    expect(texts).toEqual(['p2', 'p3']); // p1 不重發
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2', 'T3']);
  });

  it('unknown result on the first part is reconciled, then the rest of the chain continues', async () => {
    const env = await makeEnv();
    await insertThread(env, ['first', 'second']);
    let m = mockFetch((u) => { if (u.endsWith('/threads_publish')) throw new Error('net'); return jres({ id: 'C1' }); }); restore = m.restore;
    await publishDue(env, NOW);
    expect((await env.DB.prepare('SELECT status FROM posts').first<any>()).status).toBe('unknown');
    m.restore();
    m = mockFetch((u) => u.includes('/threads?fields') ? jres({ data: [{ id: 'T1', text: 'first' }] }) : u.endsWith('/threads_publish') ? jres({ id: 'T2' }) : jres({ id: 'C2' })); restore = m.restore;
    await reconcile(env, NOW); await publishDue(env, NOW);
    const p = await env.DB.prepare('SELECT * FROM posts').first<any>();
    expect(p.status).toBe('published'); expect(JSON.parse(p.part_ids)).toEqual(['T1', 'T2']);
    expect(new URLSearchParams(String(m.calls.find((c) => c.url.endsWith('/threads') && c.init?.method === 'POST')?.init?.body)).get('reply_to_id')).toBe('T1');
  });
});

describe('matrix accounts', () => {
  it('each account gets its own slots, persona prompt, token and staggered time', async () => {
    const env = await makeEnv();
    await env.DB.prepare("UPDATE brand_settings SET posting_mode='A', posts_per_day=1, publishing_times='[\"10:00\"]'").run();
    await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'TOKA', expiresAt: null });
    await upsertAccount(env, 'b1', { userId: '2', username: 'founder', token: 'TOKB', expiresAt: null });
    await env.DB.prepare("UPDATE threads_accounts SET persona='創辦人第一人稱' WHERE username='founder'").run();
    const prompts: string[] = [];
    const m = mockFetch((u, i) => { prompts.push(String(i?.body)); return gem(['鉤子', '結尾']); }); restore = m.restore;
    await ensureSlots(env, NOW); await ensureSlots(env, NOW);
    const rows = (await env.DB.prepare('SELECT account_id,scheduled_at,slot_key FROM posts ORDER BY account_id,scheduled_at').all<any>()).results;
    expect(rows.length).toBe(4); // 2 帳號 × 今天/明天
    expect(rows[0].scheduled_at).toBe('2026-11-08T02:00:00.000Z');
    expect(rows[2].scheduled_at).toBe('2026-11-08T02:20:00.000Z'); // 第二個帳號錯開 20 分鐘
    expect(prompts.some((p) => p.includes('創辦人第一人稱'))).toBe(true);
    // 發布時使用各自帳號的 token
    restore(); const m2 = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: 'T' + Math.random() }) : jres({ id: 'C' })); restore = m2.restore;
    await publishDue(env, new Date('2026-11-08T03:00:00Z'));
    const toks = m2.calls.filter((c) => c.url.endsWith('/threads') ).map((c) => new URLSearchParams(String(c.init?.body)).get('access_token'));
    expect(new Set(toks)).toEqual(new Set(['TOKA', 'TOKB']));
    expect(m2.calls.some((c) => c.url.includes('/1/threads')) && m2.calls.some((c) => c.url.includes('/2/threads'))).toBe(true);
  });

  it('distribute rewrites a thread for other accounts as staggered drafts', async () => {
    const env = await makeEnv(); const c = await admin(env);
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    const b = await upsertAccount(env, 'b1', { userId: '2', username: 'alt', token: 'B', expiresAt: null });
    await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,parts,status,scheduled_at,updated_at,created_at) VALUES('b1',?,'h',?,'draft','2030-01-01T00:00:00Z','x','x')`).bind(a, JSON.stringify(['原鉤子', '原內容'])).run();
    const m = mockFetch((u, i) => gem(['新鉤子', '新內容'])); restore = m.restore;
    const r = await api(env, 'POST', '/api/posts/1/distribute', { account_ids: [a, b] }, c);
    expect(await r.json()).toMatchObject({ created: 1 });
    expect(String(m.calls[0].init?.body)).toContain('原鉤子');
    const d = await env.DB.prepare('SELECT * FROM posts WHERE id=2').first<any>();
    expect(d).toMatchObject({ account_id: b, source_post_id: 1, status: 'draft' });
    expect(d.scheduled_at).toBe('2030-01-01T00:45:00.000Z');
  });

  it('account settings can be overridden and disconnecting returns its queued posts to draft', async () => {
    const env = await makeEnv(); const c = await admin(env);
    const a = await upsertAccount(env, 'b1', { userId: '1', username: 'main', token: 'A', expiresAt: null });
    expect((await api(env, 'PATCH', `/api/accounts/${a}`, { persona: '學長', posts_per_day: 2, publishing_times: ['21:00', '09:00'] }, c)).status).toBe(200);
    expect((await api(env, 'PATCH', `/api/accounts/${a}`, { publishing_times: ['25:00'] }, c)).status).toBe(400);
    const list: any[] = await (await api(env, 'GET', '/api/accounts', undefined, c)).json();
    expect(list[0]).toMatchObject({ persona: '學長', posts_per_day: 2, publishing_times: ['09:00', '21:00'] });
    expect(JSON.stringify(list)).not.toContain('token');
    await env.DB.prepare(`INSERT INTO posts(brand_id,account_id,content,status,approved_by,updated_at,created_at) VALUES('b1',?,'x','scheduled','owner','x','x')`).bind(a).run();
    await api(env, 'DELETE', `/api/accounts/${a}`, undefined, c);
    expect((await listAccounts(env)).length).toBe(0);
    expect((await env.DB.prepare('SELECT status FROM posts').first<any>()).status).toBe('draft');
  });
});
