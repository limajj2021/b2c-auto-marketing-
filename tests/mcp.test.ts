// AI 連接器（MCP）：OAuth 登入授權 → 通行證 → 在 ChatGPT/Codex 裡讀品牌指南、存草稿；品牌隔離與權限
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handleApi } from '../src/admin/routes';
import { sha256 } from '../src/mcp/oauth';
import { jres, makeEnv, mockFetch } from './helpers';

const O = 'https://x.dev', REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const go = (env: any, path: string, init: RequestInit = {}) => worker.fetch(new Request(O + path, { redirect: 'manual', ...init }), env);
const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const rpc = (env: any, tok: string | null, method: string, params?: unknown, id: number | null = 1) => go(env, '/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }) });
const tool = async (env: any, tok: string, name: string, args: unknown) => ((await (await rpc(env, tok, 'tools/call', { name, arguments: args })).json()) as any).result;
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(O + path, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));

/** 跑完整個 OAuth 流程，回傳通行證 */
async function connect(env: any, username = 'boss', password = 'correct-horse-1') {
  const reg = (await (await go(env, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT] }) })).json()) as any;
  const verifier = 'v'.repeat(50), challenge = await sha256(verifier);
  const p = { client_id: reg.client_id, redirect_uri: REDIRECT, state: 'st1', code_challenge: challenge, code_challenge_method: 'S256', scope: 'posts' };
  expect((await go(env, '/oauth/authorize?' + new URLSearchParams({ ...p, response_type: 'code' }))).status).toBe(200);
  const consent = await (await go(env, '/oauth/authorize', form({ ...p, step: 'login', username, password }))).text();
  const ticket = consent.match(/name="ticket" value="([^"]+)"/)?.[1];
  expect(ticket).toBeTruthy();
  const brand = consent.match(/name="brand_id" value="([^"]+)"/)![1];
  const ok = await go(env, '/oauth/authorize', form({ ...p, ticket: ticket!, brand_id: brand, step: 'approve' }));
  expect(ok.status).toBe(302);
  const loc = new URL(ok.headers.get('location')!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT); expect(loc.searchParams.get('state')).toBe('st1');
  const tok = (await (await go(env, '/oauth/token', form({ grant_type: 'authorization_code', code: loc.searchParams.get('code')!, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }))).json()) as any;
  return { ...tok, client_id: reg.client_id, code: loc.searchParams.get('code')!, verifier };
}

describe('AI connector OAuth', () => {
  it('publishes discovery metadata and asks unauthenticated MCP calls to log in', async () => {
    const env: any = await makeEnv();
    const as = (await (await go(env, '/.well-known/oauth-authorization-server')).json()) as any;
    expect(as.registration_endpoint).toBe(`${O}/oauth/register`); expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(((await (await go(env, '/.well-known/oauth-protected-resource')).json()) as any).resource).toBe(`${O}/mcp`);
    const r = await rpc(env, null, 'initialize', { protocolVersion: '2025-06-18' });
    expect(r.status).toBe(401); expect(r.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
  });

  it('wrong password, reused code, wrong PKCE verifier and foreign redirect are all refused', async () => {
    const env: any = await makeEnv();
    const t = await connect(env);
    expect(t.access_token).toBeTruthy(); expect(t.refresh_token).toBeTruthy(); expect(t.expires_in).toBe(3600);
    // 授權碼只能用一次
    expect((await go(env, '/oauth/token', form({ grant_type: 'authorization_code', code: t.code, redirect_uri: REDIRECT, client_id: t.client_id, code_verifier: t.verifier }))).status).toBe(400);
    // 不在註冊清單的回傳網址：不跳轉，直接顯示錯誤
    const bad = await go(env, '/oauth/authorize?' + new URLSearchParams({ client_id: t.client_id, redirect_uri: 'https://evil.example/cb', response_type: 'code', code_challenge: 'x', code_challenge_method: 'S256' }));
    expect(bad.status).toBe(400); expect(bad.headers.get('location')).toBeNull();
    // 密碼錯誤：留在登入頁
    const p = { client_id: t.client_id, redirect_uri: REDIRECT, state: '', code_challenge: 'abc', code_challenge_method: 'S256', scope: '' };
    expect(await (await go(env, '/oauth/authorize', form({ ...p, step: 'login', username: 'boss', password: 'nope' }))).text()).toContain('帳號或密碼錯誤');
    // 沒有登入憑證（ticket）不能直接按允許
    expect(await (await go(env, '/oauth/authorize', form({ ...p, step: 'approve', brand_id: 'b1', ticket: 'forged' }))).text()).toContain('重新登入');
  });

  it('refresh tokens rotate: the old one stops working once used', async () => {
    const env: any = await makeEnv();
    const t = await connect(env);
    const n = (await (await go(env, '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }))).json()) as any;
    expect(n.access_token).toBeTruthy(); expect(n.refresh_token).not.toBe(t.refresh_token);
    expect((await go(env, '/oauth/token', form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id }))).status).toBe(400);
  });
});

describe('AI connector tools', () => {
  it('reads the brand guide, saves drafts with the CTA added, and only publishes with explicit confirmation', async () => {
    const env: any = await makeEnv();
    const { access_token: tok } = await connect(env);
    const init = (await (await rpc(env, tok, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json()) as any;
    expect(init.result.protocolVersion).toBe('2025-06-18'); expect(init.result.instructions).toContain('測試品牌');
    expect((await rpc(env, tok, 'notifications/initialized', undefined, null)).status).toBe(202);
    const tools = ((await (await rpc(env, tok, 'tools/list')).json()) as any).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(['get_brand_guide', 'list_posts', 'get_post', 'save_drafts', 'update_draft', 'schedule_posts', 'publish_post']);
    const guide = await tool(env, tok, 'get_brand_guide', { topic: '房仲' });
    expect(guide.content[0].text).toContain('排版規則'); expect(guide.content[0].text).toContain('房仲'); expect(guide.content[0].text).not.toContain('只輸出 JSON');
    const saved = await tool(env, tok, 'save_drafts', { posts: [{ parts: ['鉤子一', '結尾一'] }, { parts: ['鉤子二，', '結尾二'], topic_tag: '#房仲' }] });
    expect(saved.isError).toBeUndefined(); expect(saved.structuredContent.saved).toHaveLength(2);
    const rows: any[] = (await env.DB.prepare(`SELECT parts,topic_tag,status FROM posts WHERE brand_id='b1' ORDER BY id`).all()).results;
    expect(JSON.parse(rows[0].parts)).toEqual(['鉤子一', '結尾一\n\n加 LINE 諮詢 https://line.me/R/ti/p/@test']);
    expect(JSON.parse(rows[1].parts)[0]).toBe('鉤子二'); expect(rows[1].topic_tag).toBe('房仲'); expect(rows.every((r) => r.status === 'draft')).toBe(true);
    const id = saved.structuredContent.saved[0].id;
    const noConfirm = await tool(env, tok, 'publish_post', { post_id: id, confirm: false });
    expect(noConfirm.isError).toBe(true); expect(noConfirm.content[0].text).toContain('確認');
    expect(((await env.DB.prepare('SELECT status FROM posts WHERE id=?').bind(id).first()) as any).status).toBe('draft');
    expect((await tool(env, tok, 'list_posts', { status: 'draft' })).structuredContent.posts.length).toBe(2);
    expect((await tool(env, tok, 'save_drafts', { posts: Array(11).fill({ parts: ['x'] }) })).isError).toBe(true);
  });

  it('cannot touch another brand; read-only staff get read tools only; revoked and disabled accounts lose access', async () => {
    const env: any = await makeEnv();
    await env.DB.prepare(`INSERT INTO brands(id,name,industry,description,timezone,created_at) VALUES('b2','別人','general','x','Asia/Taipei','x')`).run();
    await env.DB.prepare(`INSERT INTO posts(brand_id,content,parts,status,updated_at,created_at) VALUES('b2','別人的秘密','["別人的秘密"]','draft','x','x')`).run();
    const { access_token: tok, client_id } = await connect(env);
    const other = await tool(env, tok, 'get_post', { post_id: 1 });
    expect(other.isError).toBe(true); expect(JSON.stringify(other)).not.toContain('秘密');
    expect((await tool(env, tok, 'update_draft', { post_id: 1, parts: ['改掉'] })).isError).toBe(true);
    expect(((await env.DB.prepare('SELECT content FROM posts WHERE id=1').first()) as any).content).toBe('別人的秘密');
    // 只有讀取權限的員工
    const { access_token: st } = await connect(env, 'cs', 'staff-password-1');
    expect(((await (await rpc(env, st, 'tools/list')).json()) as any).result.tools.map((t: any) => t.name)).toEqual(['get_brand_guide', 'list_posts', 'get_post']);
    expect((await tool(env, st, 'save_drafts', { posts: [{ parts: ['x'] }] })).isError).toBe(true);
    // 後台中斷連線
    const cookie = ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const list = (await (await api(env, 'GET', '/api/mcp/connections', undefined, cookie)).json()) as any[];
    expect(list.map((c) => c.client_name)).toContain('ChatGPT');
    const mine = list.find((c) => c.client_id === client_id && c.username === 'boss');
    expect((await api(env, 'DELETE', `/api/mcp/connections/${mine.client_id}/${mine.user_id}`, undefined, cookie)).status).toBe(200);
    expect((await rpc(env, tok, 'tools/list')).status).toBe(401);
    // 員工帳號被停用
    await env.DB.prepare(`UPDATE admin_users SET enabled=0 WHERE authentication_id='cs'`).run();
    expect((await rpc(env, st, 'tools/list')).status).toBe(401);
  });

  it('Codex connection keys work, are shown once, and belong to the current brand', async () => {
    const env: any = await makeEnv();
    const cookie = ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    const r = (await (await api(env, 'POST', '/api/mcp/tokens', { name: 'Codex' }, cookie)).json()) as any;
    expect(r.token).toMatch(/^ego_/); expect(r.days).toBe(90);
    const g = await tool(env, r.token, 'get_brand_guide', {});
    expect(g.isError).toBeUndefined();
    expect(((await env.DB.prepare('SELECT COUNT(*) n FROM oauth_tokens WHERE token_hash=?').bind(r.token).first()) as any).n).toBe(0); // 不存原文
    const staff = ((await api(env, 'POST', '/api/login', { username: 'cs', password: 'staff-password-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await api(env, 'POST', '/api/mcp/tokens', {}, staff)).status).toBe(403);
  });

  it('drafts are always tied to a Threads account: with several accounts it must be named; unknown accounts are refused', async () => {
    const env: any = await makeEnv();
    const acct = (id: number, u: string, persona: string) => env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,persona,created_at,updated_at) VALUES(?,'b1',?,?,'x',?,'x','x')`).bind(id, 'u' + id, u, persona).run();
    await acct(11, 'main.tw', '品牌主帳號'); await acct(12, 'second.tw', '老闆個人帳號');
    await env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,created_at,updated_at) VALUES(13,'b2','u13','other.tw','x','x','x')`).run();
    const { access_token: tok } = await connect(env);
    const guide = await tool(env, tok, 'get_brand_guide', {});
    expect(guide.content[0].text).toContain('@main.tw（預設）'); expect(guide.content[0].text).toContain('@second.tw：老闆個人帳號');
    expect(guide.content[0].text).toContain('先問使用者要發到哪一個');
    expect((await tool(env, tok, 'get_brand_guide', { account: '@second.tw' })).content[0].text).toContain('老闆個人帳號');
    // 有多個帳號卻沒指定：不存，請 AI 先問使用者（避免存到錯的帳號）
    const ask = await tool(env, tok, 'save_drafts', { posts: [{ parts: ['預設'] }, { parts: ['指定'], account: '@Second.TW' }] });
    expect(ask.isError).toBe(true); expect(ask.content[0].text).toContain('請先問使用者');
    expect((await env.DB.prepare(`SELECT count(*) n FROM posts`).first() as any).n).toBe(0);
    const saved = await tool(env, tok, 'save_drafts', { posts: [{ parts: ['預設'], account: 'main.tw' }, { parts: ['指定'], account: '@Second.TW' }] });
    expect(saved.content[0].text).toContain('（@main.tw）'); expect(saved.content[0].text).toContain('（@second.tw）');
    const rows: any[] = (await env.DB.prepare(`SELECT account_id FROM posts WHERE brand_id='b1' ORDER BY id`).all()).results;
    expect(rows.map((r) => r.account_id)).toEqual([11, 12]);
    // 別的品牌的帳號、不存在的帳號：拒絕，而且一篇都不存
    const bad = await tool(env, tok, 'save_drafts', { posts: [{ parts: ['好'] }, { parts: ['壞'], account: 'other.tw' }] });
    expect(bad.isError).toBe(true); expect(bad.content[0].text).toContain('@main.tw、@second.tw');
    expect(((await env.DB.prepare(`SELECT COUNT(*) n FROM posts WHERE brand_id='b1'`).first()) as any).n).toBe(2);
    // 修改草稿可以換帳號
    const id = saved.structuredContent.saved[0].id;
    await tool(env, tok, 'update_draft', { post_id: id, parts: ['改到第二個帳號'], account: 'second.tw' });
    expect(((await env.DB.prepare('SELECT account_id FROM posts WHERE id=?').bind(id).first()) as any).account_id).toBe(12);
    expect((await tool(env, tok, 'list_posts', {})).content[0].text).toContain('@second.tw｜改到第二個帳號');
  });

  it('schedule_posts: needs confirmation, round-robins across named accounts in the brand timezone, and refuses foreign accounts', async () => {
    const env: any = await makeEnv();
    for (const [id, u] of [[11, 'a.tw'], [12, 'b.tw']] as const)
      await env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,status,created_at,updated_at) VALUES(?,'b1',?,?,'x','ok','x','x')`).bind(id, 'u' + id, u).run();
    await env.DB.prepare(`INSERT INTO brands(id,name,industry,description,timezone,created_at) VALUES('b2','別人','general','x','Asia/Taipei','x')`).run();
    await env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,status,created_at,updated_at) VALUES(21,'b2','u21','other.tw','x','ok','x','x')`).run();
    const { access_token: tok } = await connect(env);
    const ids = (await tool(env, tok, 'save_drafts', { posts: [{ parts: ['一'], account: 'a.tw' }, { parts: ['二'], account: 'a.tw' }, { parts: ['三'], account: 'a.tw' }] })).structuredContent.saved.map((x: any) => x.id);
    const d = new Date(Date.now() + 2 * 86400000), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
    const args = { post_ids: ids, accounts: ['@a.tw', 'b.tw'], start_at: `${day} 09:00`, interval_min: 60 };
    const no = await tool(env, tok, 'schedule_posts', { ...args, confirm: false });
    expect(no.isError).toBe(true);
    expect((await env.DB.prepare(`SELECT count(*) n FROM posts WHERE status='scheduled'`).first() as any).n).toBe(0);
    expect((await tool(env, tok, 'schedule_posts', { ...args, accounts: ['@other.tw'], confirm: true })).isError).toBe(true);
    const r = await tool(env, tok, 'schedule_posts', { ...args, confirm: true });
    expect(r.isError).toBeUndefined(); expect(r.structuredContent.scheduled).toBe(3);
    expect(r.structuredContent.per_account).toEqual({ '@a.tw': 2, '@b.tw': 1 });
    const rows: any[] = (await env.DB.prepare(`SELECT account_id,scheduled_at FROM posts WHERE brand_id='b1' ORDER BY id`).all()).results;
    expect(rows.map((x) => x.account_id)).toEqual([11, 12, 11]);
    expect(rows[0].scheduled_at).toBe(new Date(`${day}T01:00:00Z`).toISOString());
    expect(Date.parse(rows[2].scheduled_at) - Date.parse(rows[0].scheduled_at)).toBe(2 * 3600000);
    expect(r.content[0].text).toContain('09:00');
  });

  it('multi-account brands: must name the account when saving; can move a draft or publish to another account', async () => {
    const env: any = await makeEnv();
    for (const [id, u] of [[11, 'vuca.canada'], [12, 'vuca.tw']] as const)
      await env.DB.prepare(`INSERT INTO threads_accounts(id,brand_id,threads_user_id,username,token_enc,status,created_at,updated_at) VALUES(?,'b1',?,?,'x','ok','x','x')`).bind(id, 'u' + id, u).run();
    const { access_token: tok } = await connect(env);
    const miss = await tool(env, tok, 'save_drafts', { posts: [{ parts: ['GTA6'] }] });
    expect(miss.isError).toBe(true); expect(miss.content[0].text).toContain('@vuca.tw');
    const id = (await tool(env, tok, 'save_drafts', { posts: [{ parts: ['GTA6'], account: '@vuca.canada' }] })).structuredContent.saved[0].id;
    // 舊版連接器（沒有 account 欄位）：錯誤訊息教 AI 在第一則前面加「帳號：@xxx」
    expect(miss.content[0].text).toContain('帳號：@');
    const old = (await tool(env, tok, 'save_drafts', { posts: [{ parts: ['帳號：@vuca.tw\nGTA6 舊版', '結尾'] }] })).structuredContent.saved[0];
    expect(old.account).toBe('@vuca.tw');
    expect(JSON.parse(((await env.DB.prepare('SELECT parts FROM posts WHERE id=?').bind(old.id).first()) as any).parts)[0]).toBe('GTA6 舊版');
    const top = (await tool(env, tok, 'save_drafts', { account: '@vuca.tw', posts: [{ parts: ['整批'] }] })).structuredContent.saved[0];
    expect(top.account).toBe('@vuca.tw');
    // 只改帳號，不用重傳內容
    const moved = await tool(env, tok, 'update_draft', { post_id: id, account: 'vuca.tw' });
    expect(moved.isError).toBeUndefined();
    const r: any = await env.DB.prepare('SELECT account_id,parts FROM posts WHERE id=?').bind(id).first();
    expect(r.account_id).toBe(12); expect(JSON.parse(r.parts)[0]).toMatch(/^GTA6/);
    const tools = ((await (await rpc(env, tok, 'tools/list')).json()) as any).result.tools;
    expect(tools.find((t: any) => t.name === 'publish_post').inputSchema.properties.account).toBeTruthy();
    expect((await tool(env, tok, 'publish_post', { post_id: id, account: '@nobody', confirm: true })).isError).toBe(true);
  });

  it('publishing an already-published post to another account sends a copy there and leaves the original alone', async () => {
    const env: any = await makeEnv();
    const { upsertAccount } = await import('../src/threads/accounts');
    const can = await upsertAccount(env, 'b1', { userId: 'u1', username: 'vuca.canada', token: 'A', expiresAt: null });
    const tw = await upsertAccount(env, 'b1', { userId: 'u2', username: 'vuca.tw', token: 'B', expiresAt: null });
    await env.DB.prepare(`INSERT INTO posts(id,brand_id,account_id,content,parts,status,published_at,threads_post_id,updated_at,created_at) VALUES(163,'b1',?,'GTA6','["GTA6","結尾"]','published','x','T0','x','x')`).bind(can).run();
    const { access_token: tok } = await connect(env);
    const plain = await tool(env, tok, 'publish_post', { post_id: 163, confirm: true });
    expect(plain.isError).toBe(true); expect(plain.content[0].text).toContain('@vuca.canada');
    const m = mockFetch((u) => u.endsWith('/threads_publish') ? jres({ id: 'P' + Math.random() }) : jres({ id: 'C1', status: 'FINISHED' }));
    try {
      const r = await tool(env, tok, 'publish_post', { post_id: 163, account: '@vuca.tw', confirm: true });
      expect(r.isError).toBeUndefined(); expect(r.content[0].text).toContain('@vuca.tw');
    } finally { m.restore(); }
    const rows: any[] = (await env.DB.prepare('SELECT id,account_id,source_post_id,status FROM posts ORDER BY id').all()).results;
    expect(rows[0]).toMatchObject({ id: 163, account_id: can, status: 'published' });
    expect(rows[1]).toMatchObject({ account_id: tw, source_post_id: 163, status: 'published' });
  });
});
