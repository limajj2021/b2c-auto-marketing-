import { getBrand, getSettings, jsonArr } from '../db';
import { effective, type Account } from '../threads/accounts';
import type { Brand, Env, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { localDate, iso, zonedToUtc } from '../util/time';
import { THREADS_MAX_CHARS, checkParts } from './compliance';
import { xfetch } from '../budget';

export class QuotaError extends Error {}

export interface GenResult { generationId: number; parts: string[]; issues: string[] }
export interface GenOpts { topic?: string; account?: Account | null; rewriteOf?: string[] }

/** 只用品牌公開資料與企業提供的數據；不得放入任何顧客資料。 */
export function buildPrompt(brand: Brand, s: Settings, o: GenOpts = {}): string {
  const e = effective(o.account ?? null, s);
  const regulated = REGULATED_INDUSTRIES.includes(brand.industry);
  const min = Math.max(1, s.thread_min ?? 4), max = Math.max(min, s.thread_max ?? 7);
  const lines = [
    `你是「${brand.name}」的 Threads 小編${e.persona ? `，人設：${e.persona}` : ''}。請寫一串繁體中文 Threads 串文。`,
    `寫作原則（務必遵守）：${s.style_preset || '爭議化、數據化、具體化'}。`,
    '・爭議化：用對比、反直覺、點破迷思的切角引發討論；不得人身攻擊、歧視、針對特定個人或散布不實資訊。',
    '・數據化：只能使用下方「可引用數據」中的數字；需要統計數字、比例、金額但清單沒有時，寫成【待補數據：要補什麼】，絕對不可自行編造數字、比例、金額、排名或案例。【待補數據】只用於數字，名稱、規格、地點等請用一般說法（例如「你的活動」），不要用佔位符；整串最多 2 處。',
    '・具體化：用具體場景、步驟、對比取代空泛形容。',
    max === 1 ? '結構：只寫 1 則。' : `結構：共 ${min} 到 ${max} 則。`,
    max > 1 ? '・第 1 則是鉤子：1 到 3 行、不超過 60 字，用對比或問句製造好奇，不給答案、不放連結。' : '',
    max > 1 ? '・中間各則：每則只講一個重點，2 到 6 行，段落之間空一行。' : '',
    '・最後一則：總結並呼籲行動（私訊或加入 LINE 諮詢），不要自己寫網址，系統會自動附上。',
    `・每則不超過 ${THREADS_MAX_CHARS - 80} 字；除 hashtag 外不使用格式符號。`,
    `品牌介紹：${brand.description}`,
    `產品與服務：${s.services}`,
    `目標受眾：${s.audience}`,
    `語氣：${e.tone}`,
    `可用主題：${e.topics.join('、') || '品牌服務相關知識'}`,
    o.topic ? `本次指定主題（務必圍繞此主題）：${o.topic}` : '',
    `禁用詞：${jsonArr(s.banned_words).join('、') || '無'}`,
    `可引用數據：\n${s.fact_bank?.trim() || '（無）'}`,
    regulated ? '本業務受金融法規監管：只提供一般知識與諮詢邀請，不得提及任何利率、成數、額度或核貸可能性，也不得使用【待補數據】以外的數字。' : '',
    o.rewriteOf ? `請改寫以下串文：保留核心觀點，但鉤子、切角、用字與例子要完全不同，符合上述人設，避免與原文雷同。\n原文：\n${o.rewriteOf.map((p, i) => `(${i + 1}) ${p}`).join('\n')}` : '',
    '只輸出 JSON：{"parts":["第1則內文","第2則內文", ...]}',
  ];
  return lines.filter(Boolean).join('\n');
}

/** 解析模型輸出：優先 JSON；失敗時整段視為單則。 */
export function parseParts(raw: string): string[] {
  const t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : j?.parts;
    if (Array.isArray(arr)) { const p = arr.map((x) => String(x ?? '').trim()).filter(Boolean); if (p.length) return p; }
  } catch { /* fall through */ }
  return [t];
}

export function appendCta(parts: string[], cta: string, url: string): string[] {
  const out = [...parts];
  const tail = [cta, url].filter(Boolean).join(' ');
  const last = out.length - 1;
  if (tail && !out[last].includes(url || '\u0000')) out[last] = `${out[last].trim()}\n\n${tail}`;
  return out;
}

async function checkQuota(env: Env, brand: Brand, s: Settings, now: Date): Promise<void> {
  const dayStart = zonedToUtc(localDate(now, brand.timezone), '00:00', brand.timezone).toISOString();
  const day = await env.DB.prepare('SELECT COUNT(*) c FROM ai_generations WHERE brand_id=? AND created_at>=?').bind(brand.id, dayStart).first<{ c: number }>();
  if ((day?.c ?? 0) >= s.daily_gen_limit) throw new QuotaError('每日生成次數已達上限');
  const monthStart = `${localDate(now, brand.timezone).slice(0, 7)}-01T00:00:00.000Z`;
  const tok = await env.DB.prepare('SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM ai_generations WHERE brand_id=? AND created_at>=?').bind(brand.id, monthStart).first<{ t: number }>();
  if ((tok?.t ?? 0) >= s.monthly_token_limit) throw new QuotaError('本月 Token 額度已用完');
}

/** 呼叫 Gemini 產生一串貼文並記錄用量。額度不足丟 QuotaError（呼叫端須保留既有草稿、不再生成）。 */
export async function generateThread(env: Env, o: GenOpts = {}, now = new Date()): Promise<GenResult> {
  const brand = await getBrand(env);
  const s = await getSettings(env, brand.id);
  await checkQuota(env, brand, s, now);
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const started = Date.now();
  const record = async (status: string, text: string | null, err: string | null, inT = 0, outT = 0) =>
    (await env.DB.prepare(
      `INSERT INTO ai_generations(brand_id,provider,model,prompt_version,input_tokens,output_tokens,status,result,error_message,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(brand.id, 'gemini', model, s.prompt_version, inT, outT, status, text, err, Date.now() - started, iso(now)).run()).meta.last_row_id as number;
  try {
    const res = await xfetch(env)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(brand, s, o) }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 3000, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data: any = await res.json();
    const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    if (!raw.trim()) throw new Error('Gemini 回傳空內容');
    const max = Math.max(1, s.thread_max ?? 7);
    const e = effective(o.account ?? null, s);
    const parts = appendCta(parseParts(raw).slice(0, max), e.cta, s.line_add_url);
    const id = await record('ok', JSON.stringify(parts), null, data?.usageMetadata?.promptTokenCount ?? 0, data?.usageMetadata?.candidatesTokenCount ?? 0);
    return { generationId: id, parts, issues: checkParts(parts, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) }) };
  } catch (e) {
    await record('failed', null, String((e as Error).message).slice(0, 300));
    throw e;
  }
}
