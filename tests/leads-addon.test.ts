import { afterEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/admin/routes';
import { handleLineWebhook } from '../src/line/webhook';
import { hashPassword, hmacBase64 } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';

let restore = () => {};
afterEach(() => restore());
let n = 0;
const ev = (text: string | null, user = 'U1') => text === null
  ? { type: 'follow', webhookEventId: `f${++n}`, replyToken: `r${n}`, source: { userId: user } }
  : { type: 'message', webhookEventId: `e${++n}`, replyToken: `r${n}`, source: { userId: user }, message: { type: 'text', text } };
async function send(env: any, e: any) {
  const body = JSON.stringify({ events: [e] });
  return handleLineWebhook(env, new Request('https://x/line/webhook', { method: 'POST', body, headers: { 'x-line-signature': await hmacBase64(env.LINE_CHANNEL_SECRET, body) } }));
}
const lastReply = (calls: any[]) => JSON.parse(calls.filter((c) => c.url.includes('/reply')).pop().init.body).messages.pop();
const api = (env: any, method: string, path: string, body?: unknown, cookie?: string) => handleApi(env, new Request(`https://x${path}`, {
  method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json', 'x-requested-with': 'admin-ui', ...(cookie ? { cookie } : {}) } }));

describe('lead capture as a paid add-on (disabled by default)', () => {
  it('without the add-on the system never replies, reads profiles or stores anything (the OA handles replies itself)', async () => {
    const env = await makeEnv({ leads: false });
    const m = mockFetch(() => jres({ displayName: '不應被抓取' })); restore = m.restore;
    await send(env, ev(null));
    for (const t of ['立即詢問', '同意', '一般諮詢', '我想申請', '聯絡專人']) expect((await send(env, ev(t))).status).toBe(200);
    expect(m.calls.length).toBe(0); // 不回覆、不抓顯示名稱
    for (const t of ['inquiries', 'contacts', 'conversation_states', 'metrics_daily']) {
      expect(((await env.DB.prepare(`SELECT COUNT(*) c FROM ${t}`).first()) as any).c).toBe(0);
    }
  });

  it('with the add-on, counts new friends and human handoffs in real time without storing customer content', async () => {
    const env = await makeEnv({ leads: true });
    const m = mockFetch(() => jres({})); restore = m.restore;
    await send(env, ev(null, 'A')); await send(env, ev(null, 'B')); await send(env, ev('聯絡專人', 'A'));
    const rows = (await env.DB.prepare('SELECT name,count FROM metrics_daily ORDER BY name').all()).results as any[];
    expect(rows).toEqual([{ name: 'friend_add', count: 2 }, { name: 'handoff', count: 1 }]);
  });

  it('server rejects lead endpoints when not purchased; operator can enable it', async () => {
    const env: any = await makeEnv({ leads: false });
    const c = ((await api(env, 'POST', '/api/login', { username: 'boss', password: 'correct-horse-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await api(env, 'GET', '/api/inquiries', undefined, c)).status).toBe(403);
    expect((await api(env, 'PATCH', '/api/inquiries/1', { handling_status: 'done' }, c)).status).toBe(403);
    expect(await (await api(env, 'GET', '/api/me', undefined, c)).json()).toMatchObject({ leads_enabled: false });
    await env.DB.prepare("UPDATE brands SET slug='acme'").run();
    await env.DB.prepare("INSERT INTO operators(username,password_hash,created_at) VALUES('ops',?,'x')").bind(await hashPassword('operator-pass-1')).run();
    const op = ((await api(env, 'POST', '/api/op/login', { username: 'ops', password: 'operator-pass-1' })).headers.get('set-cookie') ?? '').split(';')[0];
    expect((await api(env, 'PATCH', '/api/op/tenants/acme', { leads_enabled: true }, op)).status).toBe(200);
    expect((await api(env, 'GET', '/api/inquiries', undefined, c)).status).toBe(200);
    const list: any = await (await api(env, 'GET', '/api/op/tenants', undefined, op)).json();
    expect(list.tenants[0]).toMatchObject({ leads_enabled: true, friends: 0, handoffs: 0 });
  });

  it('turning the add-on off mid-form stops replying and never saves the half-filled form', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    for (const t of ['立即詢問', '同意', '一般諮詢', '小明']) await send(env, ev(t, 'Z'));
    await env.DB.prepare('UPDATE brand_settings SET leads_enabled=0').run();
    const before = m.calls.length;
    for (const t of ['想了解方案', 'LINE 訊息', '略過', '確認送出']) await send(env, ev(t, 'Z'));
    expect(m.calls.length).toBe(before);
    expect(((await env.DB.prepare('SELECT COUNT(*) c FROM inquiries').first()) as any).c).toBe(0);
  });
});
