import { describe, expect, it, afterEach } from 'vitest';
import { handleLineWebhook } from '../src/line/webhook';
import { hmacBase64 } from '../src/util/crypto';
import { jres, makeEnv, mockFetch } from './helpers';
import { matchFaq } from '../src/line/faq';

let restore = () => {};
afterEach(() => restore());

async function send(env: any, events: any[], sign = true) {
  const body = JSON.stringify({ events });
  const sig = sign ? await hmacBase64(env.LINE_CHANNEL_SECRET, body) : 'bad';
  return handleLineWebhook(env, new Request('https://x/line/webhook', { method: 'POST', body, headers: { 'x-line-signature': sig } }));
}
let n = 0;
const msg = (text: string, user = 'U1') => ({
  type: 'message', webhookEventId: `e${++n}`, replyToken: `r${n}`, source: { userId: user }, message: { type: 'text', text },
});
const lastText = (calls: any[]) => JSON.parse(calls[calls.length - 1].init.body).messages.map((m: any) => m.text).join('\n');

describe('LINE webhook', () => {
  it('rejects bad signature', async () => {
    const env = await makeEnv();
    expect((await send(env, [msg('hi')], false)).status).toBe(401);
  });

  it('dedups redelivered events (single reply)', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    const ev = msg('你好');
    await send(env, [ev]); await send(env, [ev]);
    expect(m.calls.filter((c) => c.url.includes('/reply')).length).toBe(1);
  });

  it('completes the inquiry flow and stores one record; no LLM call', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    for (const t of ['立即詢問', '同意', '一般諮詢', '小明', '想了解方案', 'LINE 訊息', '略過']) await send(env, [msg(t)]);
    expect(lastText(m.calls)).toContain('請確認您的資料');
    const confirm = msg('確認送出');
    await send(env, [confirm]);
    await send(env, [confirm]); // 重送同一事件
    await send(env, [msg('確認送出')]); // 已回到 idle，不得再產生紀錄
    const rows = await env.DB.prepare('SELECT * FROM inquiries').all<any>();
    expect(rows.results.length).toBe(1);
    expect(JSON.parse(rows.results[0].answers).need).toBe('想了解方案');
    expect(m.calls.some((c) => c.url.includes('generativelanguage'))).toBe(false);
  });

  it('rejects sensitive data and enforces required fields', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    for (const t of ['立即詢問', '同意', '一般諮詢']) await send(env, [msg(t, 'U2')]);
    await send(env, [msg('A123456789', 'U2')]);
    expect(lastText(m.calls)).toContain('敏感資料');
  });

  it('human handoff silences auto replies until 選單', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    await send(env, [msg('聯絡專人', 'U3')]);
    const before = m.calls.length;
    await send(env, [msg('我要問利率', 'U3')]);
    expect(m.calls.length).toBe(before);
    await send(env, [msg('選單', 'U3')]);
    expect(m.calls.length).toBe(before + 1);
  });

  it('FAQ match and fallback', async () => {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO faq_rules(brand_id,keyword,response,priority) VALUES('b1','營業時間,幾點','週一至週五 9-18',1)").run();
    const m = mockFetch(() => jres({})); restore = m.restore;
    await send(env, [msg('請問你們幾點開', 'U4')]);
    expect(lastText(m.calls)).toContain('9-18');
    await send(env, [msg('asdfgh', 'U4')]);
    expect(lastText(m.calls)).toContain('不確定');
  });

  it('paused auto reply sends nothing', async () => {
    const env = await makeEnv();
    await env.DB.prepare('UPDATE brand_settings SET line_auto_reply_enabled=0').run();
    const m = mockFetch(() => jres({})); restore = m.restore;
    await send(env, [msg('hi', 'U5')]);
    expect(m.calls.length).toBe(0);
  });

  it('data deletion removes contact and inquiries', async () => {
    const env = await makeEnv();
    const m = mockFetch(() => jres({})); restore = m.restore;
    for (const t of ['立即詢問', '同意', '一般諮詢', '小華', '需求', '電話', '略過', '確認送出', '刪除我的資料', '確認刪除']) await send(env, [msg(t, 'U6')]);
    expect((await env.DB.prepare('SELECT COUNT(*) c FROM inquiries').first<any>()).c).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) c FROM contacts WHERE line_user_id='U6'").first<any>()).c).toBe(0);
  });
});

describe('faq priority', () => {
  it('higher priority wins', () => {
    expect(matchFaq('費用多少', [{ keyword: '費用', response: 'a', priority: 1 }, { keyword: '費用', response: 'b', priority: 5 }])?.response).toBe('b');
  });
});
