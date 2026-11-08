// LINE 規則式接待與留資流程。本檔案全程不呼叫 LLM。
import type { Env } from '../types';
import { iso } from '../util/time';
import type { Reply } from './api';
import { parseLineConfig, type LineConfig } from './config';
import { matchFaq } from './faq';

const HUMAN_TTL_MS = 24 * 3600 * 1000;
const SKIP = ['略過', '跳過'];
const SENSITIVE = /\b[A-Z][12]\d{8}\b|\b(?:\d[ -]?){15,16}\b/; // 身分證字號、卡號樣式

interface State { flow_state: string; current_step: string | null; form_data: any; updated_at: string }

async function loadState(env: Env, brandId: string, contactId: number): Promise<State> {
  const r = await env.DB.prepare('SELECT flow_state,current_step,form_data,updated_at FROM conversation_states WHERE brand_id=? AND contact_id=?')
    .bind(brandId, contactId).first<any>();
  if (!r) return { flow_state: 'idle', current_step: null, form_data: {}, updated_at: iso() };
  return { ...r, form_data: JSON.parse(r.form_data || '{}') };
}

async function saveState(env: Env, brandId: string, contactId: number, flow: string, step: string | null, data: unknown) {
  await env.DB.prepare(
    `INSERT INTO conversation_states(brand_id,contact_id,flow_state,current_step,form_data,updated_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(brand_id,contact_id) DO UPDATE SET flow_state=excluded.flow_state,current_step=excluded.current_step,
       form_data=excluded.form_data,updated_at=excluded.updated_at`,
  ).bind(brandId, contactId, flow, step, JSON.stringify(data ?? {}), iso()).run();
}

const mainQuick = (c: LineConfig) => [c.menu.info, c.menu.inquiry, c.menu.human];

export function welcomeReply(c: LineConfig): Reply[] {
  return [{ text: c.welcome, quick: mainQuick(c) }];
}

export async function handleText(env: Env, brandId: string, contactId: number, rawText: string, now = new Date()): Promise<Reply[]> {
  const row = await env.DB.prepare('SELECT line_config FROM brand_settings WHERE brand_id=?').bind(brandId).first<{ line_config: string }>();
  const cfg = parseLineConfig(row?.line_config ?? '{}');
  const t = rawText.trim();
  const st = await loadState(env, brandId, contactId);
  const idle = () => saveState(env, brandId, contactId, 'idle', null, {});
  const toHuman = async (): Promise<Reply[]> => {
    await saveState(env, brandId, contactId, 'human', null, { since: iso(now) });
    return [{ text: cfg.humanNotice }];
  };

  // 真人接手：停止所有自動回覆（避免與 OA 真人回覆衝突），24 小時或輸入「選單」後恢復
  if (st.flow_state === 'human') {
    const expired = now.getTime() - new Date(st.updated_at).getTime() > HUMAN_TTL_MS;
    if (t === '選單' || t.toLowerCase() === 'menu' || expired) { await idle(); return welcomeReply(cfg); }
    return [];
  }

  if (t === '選單' || t.toLowerCase() === 'menu') { await idle(); return welcomeReply(cfg); }
  if (t === cfg.menu.human) return toHuman();

  if (st.flow_state === 'delete_confirm') {
    await idle();
    if (t === '確認刪除') {
      await env.DB.prepare('DELETE FROM inquiries WHERE brand_id=? AND contact_id=?').bind(brandId, contactId).run();
      await env.DB.prepare('DELETE FROM conversation_states WHERE brand_id=? AND contact_id=?').bind(brandId, contactId).run();
      await env.DB.prepare('DELETE FROM contacts WHERE brand_id=? AND id=?').bind(brandId, contactId).run();
      return [{ text: '已刪除您在本系統留存的資料。' }];
    }
    return [{ text: '已取消刪除。', quick: mainQuick(cfg) }];
  }

  if (st.flow_state === 'form') return formStep(env, brandId, contactId, cfg, st, t);

  // idle
  if (t.includes('刪除我的資料') || t.includes('查詢我的資料')) {
    if (t.includes('查詢')) {
      const n = await env.DB.prepare('SELECT COUNT(*) c FROM inquiries WHERE brand_id=? AND contact_id=?').bind(brandId, contactId).first<{ c: number }>();
      return [{ text: `目前留存您的諮詢紀錄共 ${n?.c ?? 0} 筆。如需刪除請輸入「刪除我的資料」。`, quick: mainQuick(cfg) }];
    }
    await saveState(env, brandId, contactId, 'delete_confirm', null, {});
    return [{ text: '將刪除您所有的諮詢紀錄，無法復原。請輸入「確認刪除」，或任意文字取消。' }];
  }
  if (t === cfg.menu.info) return [{ text: `${cfg.serviceInfo}\n\n營業時間：${cfg.businessHours}`, quick: mainQuick(cfg) }];
  if (t === cfg.menu.inquiry || /(諮詢|詢問|申請)/.test(t)) return startForm(env, brandId, contactId, cfg);
  if (/(真人|專人|客服|人工)/.test(t)) return toHuman();

  const faqs = await env.DB.prepare('SELECT keyword,response,priority FROM faq_rules WHERE brand_id=? AND enabled=1').bind(brandId).all<any>();
  const hit = matchFaq(t, faqs.results);
  if (hit) return [{ text: hit.response, quick: mainQuick(cfg) }];
  return [{ text: cfg.fallback, quick: mainQuick(cfg) }];
}

async function startForm(env: Env, brandId: string, contactId: number, cfg: LineConfig): Promise<Reply[]> {
  await saveState(env, brandId, contactId, 'form', 'consent', { flow_id: crypto.randomUUID(), answers: {} });
  return [{ text: cfg.privacyNotice, quick: ['同意', '取消'] }];
}

function fieldPrompt(f: LineConfig['fields'][number]): Reply {
  const quick = f.options?.length ? [...f.options] : f.required ? undefined : [SKIP[0]];
  return { text: f.label + (f.required ? '' : '（可輸入「略過」）'), quick };
}

async function formStep(env: Env, brandId: string, contactId: number, cfg: LineConfig, st: State, t: string): Promise<Reply[]> {
  const data = st.form_data;
  const step = st.current_step ?? 'consent';
  const save = (s: string) => saveState(env, brandId, contactId, 'form', s, data);

  if (t === '取消') {
    await saveState(env, brandId, contactId, 'idle', null, {});
    return [{ text: '已取消。如需協助可再選擇下方選項。', quick: mainQuick(cfg) }];
  }

  if (step === 'consent') {
    if (t !== '同意') return [{ text: cfg.privacyNotice, quick: ['同意', '取消'] }];
    await save('service');
    return [{ text: '請選擇想了解的服務類型：', quick: cfg.services }];
  }

  if (step === 'service') {
    if (!cfg.services.includes(t)) return [{ text: '請從選項中選擇服務類型：', quick: cfg.services }];
    data.service = t;
    await save(`f:${cfg.fields[0].key}`);
    return [fieldPrompt(cfg.fields[0])];
  }

  if (step.startsWith('f:')) {
    const idx = cfg.fields.findIndex((f) => `f:${f.key}` === step);
    if (idx < 0) { await saveState(env, brandId, contactId, 'idle', null, {}); return welcomeReply(cfg); }
    const f = cfg.fields[idx];
    if (f.blockIf && t === f.blockIf) {
      // 例如未成年：停止流程，交由合法授權人員處理
      await saveState(env, brandId, contactId, 'human', null, { since: iso(), reason: 'blocked' });
      return [{ text: '依規定此流程無法在線上繼續，已為您轉接專人處理。' }];
    }
    if (SENSITIVE.test(t)) return [{ text: '請勿提供身分證字號、卡號等敏感資料，請重新輸入。' }];
    if (!f.required && SKIP.includes(t)) data.answers[f.key] = '';
    else if (!t) return [fieldPrompt(f)];
    else data.answers[f.key] = t.slice(0, 500);
    const next = cfg.fields[idx + 1];
    if (next) { await save(`f:${next.key}`); return [fieldPrompt(next)]; }
    await save('confirm');
    return [{ text: summary(cfg, data), quick: ['確認送出', '重新填寫', '取消'] }];
  }

  if (step === 'confirm') {
    if (t === '重新填寫') { data.answers = {}; await save('service'); return [{ text: '請重新選擇服務類型：', quick: cfg.services }]; }
    if (t !== '確認送出') return [{ text: summary(cfg, data), quick: ['確認送出', '重新填寫', '取消'] }];
    await env.DB.prepare(
      `INSERT OR IGNORE INTO inquiries(brand_id,contact_id,flow_id,service,answers,handling_status,created_at) VALUES(?,?,?,?,?,'pending',?)`,
    ).bind(brandId, contactId, data.flow_id, data.service ?? null, JSON.stringify(data.answers), iso()).run();
    await saveState(env, brandId, contactId, 'idle', null, {});
    return [{ text: cfg.completeMessage, quick: mainQuick(cfg) }];
  }

  await saveState(env, brandId, contactId, 'idle', null, {});
  return welcomeReply(cfg);
}

function summary(cfg: LineConfig, data: any): string {
  const lines = cfg.fields.map((f) => `${f.label.replace(/[？?].*$/, '')}：${data.answers[f.key] || '（無）'}`);
  return `請確認您的資料：\n服務：${data.service}\n${lines.join('\n')}`;
}
