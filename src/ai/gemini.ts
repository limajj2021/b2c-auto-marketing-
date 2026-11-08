import { getBrand, getSettings, jsonArr } from '../db';
import type { Brand, Env, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { localDate, iso, zonedToUtc } from '../util/time';
import { THREADS_MAX_CHARS, checkContent } from './compliance';

export class QuotaError extends Error {}

export interface GenResult {
  generationId: number;
  text: string;
  issues: string[];
}

/** 只用品牌公開資料；不得放入任何顧客資料。 */
export function buildPrompt(brand: Brand, s: Settings, topic: string): string {
  const regulated = REGULATED_INDUSTRIES.includes(brand.industry);
  const lines = [
    `你是「${brand.name}」的社群小編，為 Threads 撰寫一則繁體中文貼文。`,
    `品牌介紹：${brand.description}`,
    `產品與服務：${s.services}`,
    `目標受眾：${s.audience}`,
    `語氣：${s.content_tone}`,
    `可用主題：${jsonArr(s.content_topics).join('、') || '品牌服務相關知識'}`,
    topic ? `本次指定主題（務必圍繞此主題）：${topic}` : '',
    `禁用詞：${jsonArr(s.banned_words).join('、') || '無'}`,
    `規則：全文不超過 ${THREADS_MAX_CHARS - 80} 字；不含網址；不使用 hashtag 以外的特殊標記；只輸出貼文本文。`,
    '不得承諾或暗示保證、必過、零風險；不得編造數字、案例、利率、費用或資格。',
    regulated ? '本業務受金融法規監管：只提供一般知識與諮詢邀請，不得提及任何利率、成數、額度或核貸可能性。' : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export function appendCta(text: string, s: Settings): string {
  const cta = [s.cta_text, s.line_add_url].filter(Boolean).join(' ');
  if (!cta || text.includes(s.line_add_url)) return text;
  return `${text.trim()}\n\n${cta}`;
}

async function checkQuota(env: Env, brand: Brand, s: Settings, now: Date): Promise<void> {
  const dayStart = zonedToUtc(localDate(now, brand.timezone), '00:00', brand.timezone).toISOString();
  const day = await env.DB.prepare('SELECT COUNT(*) c FROM ai_generations WHERE brand_id=? AND created_at>=?')
    .bind(brand.id, dayStart).first<{ c: number }>();
  if ((day?.c ?? 0) >= s.daily_gen_limit) throw new QuotaError('每日生成次數已達上限');
  const monthStart = `${localDate(now, brand.timezone).slice(0, 7)}-01T00:00:00.000Z`;
  const tok = await env.DB.prepare(
    'SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM ai_generations WHERE brand_id=? AND created_at>=?',
  ).bind(brand.id, monthStart).first<{ t: number }>();
  if ((tok?.t ?? 0) >= s.monthly_token_limit) throw new QuotaError('本月 Token 額度已用完');
}

/**
 * 呼叫 Gemini 產生一則貼文並記錄用量。額度不足丟 QuotaError（呼叫端須保留既有草稿、不再生成）。
 */
export async function generatePost(env: Env, topic: string, now = new Date()): Promise<GenResult> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  await checkQuota(env, brand, s, now);
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const started = Date.now();
  const prompt = buildPrompt(brand, s, topic);

  const record = async (status: string, text: string | null, err: string | null, inT = 0, outT = 0) =>
    (await env.DB.prepare(
      `INSERT INTO ai_generations(brand_id,provider,model,prompt_version,input_tokens,output_tokens,status,result,error_message,duration_ms,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(brand.id, 'gemini', model, s.prompt_version, inT, outT, status, text, err, Date.now() - started, iso(now)).run())
      .meta.last_row_id as number;

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 600 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data: any = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) throw new Error('Gemini 回傳空內容');
    const text = appendCta(raw.trim(), s);
    const id = await record('ok', text, null, data?.usageMetadata?.promptTokenCount ?? 0, data?.usageMetadata?.candidatesTokenCount ?? 0);
    return { generationId: id, text, issues: checkContent(text, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) }) };
  } catch (e) {
    await record('failed', null, String((e as Error).message).slice(0, 300));
    throw e;
  }
}
