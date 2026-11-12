import { getBrand, getSettings } from '../db';
import type { Env } from '../types';
import { verifyLineSignature } from '../util/crypto';
import { iso } from '../util/time';
import { getDisplayName, reply } from './api';
import { parseLineConfig } from './config';
import { handleText, menuFor, welcomeReply } from './flow';
import { bump } from '../metrics';

export async function handleLineWebhook(env: Env, req: Request): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, raw, req.headers.get('x-line-signature')))) {
    return new Response('invalid signature', { status: 401 });
  }
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }

  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  if (!s.line_auto_reply_enabled) return new Response('paused', { status: 200 });

  let failed = false;
  for (const ev of body.events ?? []) {
    const eventId: string | undefined = ev.webhookEventId;
    if (!eventId || !ev.source?.userId) continue;
    // 去重：先搶佔事件 ID，重送的 Webhook 不會重複回覆或重複寫入
    const claim = await env.DB.prepare('INSERT OR IGNORE INTO processed_events(brand_id,external_event_id,event_type,processed_at) VALUES(?,?,?,?)')
      .bind(brand.id, eventId, ev.type, iso()).run();
    if (claim.meta.changes !== 1) continue;
    let applied = false; // 對話狀態或統計是否已寫入；寫入後就不能讓 LINE 重送，否則會重複處理
    try {
      // 留資未開通時不另外抓取顧客顯示名稱，只保留轉真人所需的最少資訊
      const contactId = await upsertContact(env, brand.id, ev.source.userId, ev.type === 'follow' && !!s.leads_enabled);
      const cfg = menuFor(parseLineConfig(s.line_config), !!s.leads_enabled);
      if (ev.type === 'follow') { await bump(env, 'friend_add').catch(() => {}); applied = true; }
      let replies = null;
      if (ev.type === 'follow') replies = welcomeReply(cfg);
      else if (ev.type === 'message' && ev.message?.type === 'text') { replies = await handleText(env, brand.id, contactId, ev.message.text); applied = true; }
      else if (ev.type === 'message') replies = welcomeReply(cfg);
      if (replies && ev.replyToken) await reply(env, ev.replyToken, replies);
    } catch (e) {
      // 日誌不含訊息內容
      console.error('line:event_failed', ev.type, applied ? 'after_state' : 'before_state', (e as Error).message);
      if (applied) continue; // 狀態已寫入（通常是回覆失敗）：保留佔位，不要求重送，避免重複處理
      failed = true;
      // 尚未寫入任何狀態：釋放佔位讓 LINE 重送可重新處理
      await env.DB.prepare('DELETE FROM processed_events WHERE brand_id=? AND external_event_id=?').bind(brand.id, eventId).run();
    }
  }
  return new Response(failed ? 'error' : 'ok', { status: failed ? 500 : 200 });
}

async function upsertContact(env: Env, brandId: string, userId: string, fetchName: boolean): Promise<number> {
  const found = await env.DB.prepare('SELECT id FROM contacts WHERE brand_id=? AND line_user_id=?').bind(brandId, userId).first<{ id: number }>();
  if (found) return found.id;
  const name = fetchName ? await getDisplayName(env, userId) : null;
  await env.DB.prepare('INSERT OR IGNORE INTO contacts(brand_id,line_user_id,display_name,created_at) VALUES(?,?,?,?)')
    .bind(brandId, userId, name, iso()).run();
  return (await env.DB.prepare('SELECT id FROM contacts WHERE brand_id=? AND line_user_id=?').bind(brandId, userId).first<{ id: number }>())!.id;
}
