import { getBrand, getSettings, jsonArr } from '../db';
import { effective, type Account } from '../threads/accounts';
import type { Brand, Env, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { localDate, iso, zonedToUtc } from '../util/time';
import { THREADS_MAX_CHARS, checkParts } from './compliance';
import { xfetch } from '../budget';

export class QuotaError extends Error {}

export interface GenResult { generationId: number; parts: string[]; issues: string[] }
export interface GenOpts { topic?: string; account?: Account | null; rewriteOf?: string[]; pattern?: PatternKey }

/** 底層 Prompt 版本：寫進 ai_generations.prompt_version（格式 v2:套路代號），方便日後比較哪個套路成效好 */
export const PROMPT_VERSION = 'v2';

/**
 * 觀點拆解串文的套路庫。needs：需要「可引用數據」裡有素材才能用（引言、案例、報告），沒有素材時不選，避免捏造。
 * 熱門事件（D）與長文議題（L）需要即時新聞或不同版面，不放進自動發文。
 */
export const PATTERNS = {
  A: { name: '文化對比', needs: false, flow: '「為什麼 A 做 X 像『乞討』，B 做 X 像『創業』？」→ 痛點場景 →「破局關鍵：邏輯完全不同」→ A 思維（👉 結果）→ B 思維（👉 結果）→「醒醒吧」→ CTA' },
  B: { name: '業內引言', needs: true, flow: '開頭引用「可引用數據」中的一句業內引言（必須原文、註明來源）→ 下一則揭曉關鍵詞 → 重新定義（不是 X 而是 Y）→ 1️⃣2️⃣3️⃣ 三層 → 🧭 反問讀者 → CTA' },
  C: { name: '荒謬場景', needs: false, flow: '「花了＿＿做了＿＿，結果卻還＿＿？這不是＿＿問題，真相是：」→「觀念落伍」→ 證據（有數據用數據，沒有就用案例或邏輯）→「想像一下：」before→after ×3 → 三贏 →「這就是我們在做的事」' },
  E: { name: '成功案例', needs: true, flow: '「從 0 到＿＿」（數字只能來自可引用數據）→ 原本窘境 →「👉 這就是大多數人的現實」→ 我們先問一個關鍵問題 → ✔️ 三步拆解 → 結果數字 →「你以為靠關係？其實靠策略」' },
  F: { name: '打臉迷思', needs: false, flow: '「你還在＿＿嗎？別傻了。很多人以為是＿＿，但真相是……」→ 下一則重複揭曉 → 正常狀況 vs 異常狀況 → 🚫 無效行為清單 → 💥 錯！階梯清單（做 1／50／100／300 次各會怎樣，用邏輯推演，不寫成統計結果）→ CTA' },
  G: { name: '權威數據', needs: true, flow: '「＿＿才是王？一份報告打臉所有＿＿！」（報告必須來自可引用數據並註明出處）→ 數字並列比較 → 🤔 為什麼 → 📈 趨勢 → 🧠 金句 → CTA' },
  H: { name: '反常識金句', needs: false, flow: '「最好的＿＿？不是＿＿，是＿＿」→「很多人覺得狂，其實真相是⋯」→ 證據（有數據用數據，沒有就用案例或邏輯）→ 回應反對意見 → CTA' },
  I: { name: '只在乎三件事', needs: false, flow: '「🔍＿＿其實只在乎三件事：不是＿＿、不是＿＿……而是⋯」→ 1️⃣2️⃣3️⃣ 用讀者的內心問句當小標 → 📩 CTA' },
  J: { name: '揭弊', needs: false, flow: '「別再被假＿＿騙了」→ 付出 vs 回報的落差（具體數字只能來自可引用數據，沒有就用具體場景）→ 排比「所謂＿＿，變成＿＿」×3 → 戳破讀者自我設限 → 我們要建的新做法 → CTA' },
  K: { name: '錢從哪來', needs: false, flow: '「＿＿的錢從哪來？」→ 熱鬧畫面讓讀者代入 →「答案很簡單，也很驚人：」→ 拆解收入或成本來源（用邏輯推演）→ 拉回讀者也能用' },
} as const;
export type PatternKey = keyof typeof PATTERNS;

/** 依有沒有素材挑套路，避開上一次用過的，讓帳號內容不重複 */
export function pickPattern(hasFacts: boolean, last?: string | null, rnd = Math.random): PatternKey {
  const ok = (Object.keys(PATTERNS) as PatternKey[]).filter((k) => (hasFacts || !PATTERNS[k].needs) && k !== last);
  return ok[Math.floor(rnd() * ok.length) % ok.length];
}

/** 只用品牌公開資料與企業提供的數據；不得放入任何顧客資料。 */
export function buildPrompt(brand: Brand, s: Settings, o: GenOpts = {}): string {
  const e = effective(o.account ?? null, s);
  const regulated = REGULATED_INDUSTRIES.includes(brand.industry);
  const min = Math.max(1, s.thread_min ?? 4), max = Math.max(min, s.thread_max ?? 7);
  const facts = s.fact_bank?.trim() || '';
  const pat = o.pattern ? PATTERNS[o.pattern] : null;
  const lines = [
    '# 角色',
    `你是「${brand.name}」的 Threads 內容策略師${e.persona ? `，人設：${e.persona}` : ''}，專寫「觀點拆解串文」。`,
    '讓目標讀者在這串文裡經歷：被戳痛 → 發現「不是我的錯，是觀念錯了」→ 看到證據 → 看見更好的可能 → 自然想找你。最後一則才輕帶品牌服務。',
    '',
    '# 品牌資料',
    `品牌介紹：${brand.description}`,
    `產品與服務：${s.services}`,
    `目標讀者：${s.audience}`,
    `語氣：${e.tone}`,
    `可用主題：${e.topics.join('、') || '品牌服務相關知識'}`,
    o.topic ? `本次指定主題（務必圍繞此主題）：${o.topic}` : '',
    `禁用詞：${jsonArr(s.banned_words).join('、') || '無'}`,
    `可引用數據（唯一可用的數字、引言、案例、報告來源）：\n${facts || '（無）'}`,
    `品牌寫作原則：${s.style_preset || '爭議化、數據化、具體化'}`,
    '',
    '# 本次套路',
    pat ? `使用「${pat.name}」當主架構：${pat.flow}` : '從文化對比、荒謬場景、打臉迷思、反常識金句、只在乎三件事、揭弊、錢從哪來中挑一個最適合主題的當主架構。',
    '套路是骨架，句型裡的「＿＿」要換成符合品牌與讀者的具體內容；不必逐字照抄。',
    '',
    '# 寫作規則',
    max === 1 ? '・只寫 1 則。' : `・共 ${min} 到 ${max} 則。第 1 則是鉤子：1 到 3 行、不超過 60 字，不給答案、不放連結。`,
    '・每則 2～6 行，一則一個重點，一行約 20 字內；段落之間空一行，也可以用單獨一行「-」分隔。',
    '・懸念切割：前一則停在「真相是……」「而是⋯」，下一則開頭重複這句再揭曉。',
    '・至少一次翻轉歸因：「這不是你能力的問題，而是＿＿的問題」。',
    '・至少一組二元對比，例如：成本 vs 投資、被管理者 vs 資產、要錢 vs 創造價值。',
    '・重新定義：「＿＿在意的不是＿＿，而是＿＿」。',
    '・關鍵詞用「」框起來；emoji 只當段落標記（👉💬1️⃣2️⃣3️⃣🚫💥🧭🔍📩🤔📈🧠✔️），每則最多 3 個。',
    '・語氣直接、略帶挑釁（別傻了、醒醒吧、錯！），但最後一定站在讀者這邊；不得人身攻擊、歧視、針對特定個人或品牌。',
    '・不加 hashtag，不寫「總之」，不寫網址。',
    '',
    '# 事實規則（最高優先，違反就整串作廢）',
    '・數字、比例、金額、排名、報告、引言、客戶案例只能來自「可引用數據」，並寫出來源。',
    '・沒有素材時改用具體場景、案例情境或邏輯推演，不要寫成統計結果；不可以寫「研究顯示」「某業內人直言」「調查發現」這類沒有出處的說法。',
    '・真的需要一個數字才講得通時，寫成【待補數據：要補什麼】讓人工補上；只用於數字，整串最多 2 處。',
    regulated ? '・本業務受金融法規監管：只提供一般知識與諮詢邀請，不得提及任何利率、成數、額度或核貸可能性，也不得使用【待補數據】以外的數字。' : '',
    '',
    '# 結尾',
    '・最後一則：可先用 🧭 反問收束 →「這就是我們在做的事」或「你不是一個人」→ 一句價值主張（不賣夢想，專賣＿＿）→ 一句邀請讀者私訊或加 LINE，最後一行用「👇」結尾。',
    '・不要自己寫連結或 LINE ID，系統會在最後一則下方自動附上 CTA 與連結。',
    `・每則不超過 ${THREADS_MAX_CHARS - 80} 字。`,
    o.rewriteOf ? `\n# 改寫\n請改寫以下串文：保留核心觀點，但鉤子、切角、用字與例子要完全不同，符合上述人設，避免與原文雷同。\n原文：\n${o.rewriteOf.map((p, i) => `(${i + 1}) ${p}`).join('\n')}` : '',
    '',
    '# 輸出',
    '只輸出 JSON：{"parts":["第1則內文","第2則內文", ...]}，不要輸出套路說明、備選鉤子或其他文字。',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
  // 換個套路：避開這個品牌上一次用過的
  const last = await env.DB.prepare(`SELECT prompt_version v FROM ai_generations WHERE brand_id=? AND prompt_version LIKE ? ORDER BY id DESC LIMIT 1`).bind(brand.id, `${PROMPT_VERSION}:%`).first<{ v: string }>();
  const pattern = o.pattern ?? pickPattern(!!s.fact_bank?.trim(), last?.v?.split(':')[1]);
  o = { ...o, pattern };
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const started = Date.now();
  const record = async (status: string, text: string | null, err: string | null, inT = 0, outT = 0) =>
    (await env.DB.prepare(
      `INSERT INTO ai_generations(brand_id,provider,model,prompt_version,input_tokens,output_tokens,status,result,error_message,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(brand.id, 'gemini', model, `${PROMPT_VERSION}:${pattern}`, inT, outT, status, text, err, Date.now() - started, iso(now)).run()).meta.last_row_id as number;
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
