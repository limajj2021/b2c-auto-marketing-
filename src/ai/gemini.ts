import { getBrand, getSettings, jsonArr } from '../db';
import { effective, type Account } from '../threads/accounts';
import type { Brand, Env, Settings } from '../types';
import { REGULATED_INDUSTRIES } from '../types';
import { localDate, iso, zonedToUtc } from '../util/time';
import { THREADS_MAX_CHARS, checkParts } from './compliance';
import { toTag } from '../threads/topic';
import { geminiFetch } from '../budget';

export class QuotaError extends Error {}

export interface GenResult { generationId: number; parts: string[]; issues: string[]; /** AI 為這篇挑的主題標籤 */ tag: string }
/** autoPublish：全自動發文，寫完沒人會改，所以不能留空格給人補；fix：上一版沒過檢查的原因，這次要避開 */
/** variant：底層 Prompt 版本（回測時可指定 v2／v3）；recent：同品牌最近發過或排好的開頭，避免各帳號寫出雷同的東西 */
export interface GenOpts { topic?: string; account?: Account | null; rewriteOf?: string[]; pattern?: PatternKey; autoPublish?: boolean; fix?: string[]; variant?: 'v2' | 'v3'; recent?: string[]; angle?: string }

/** 底層 Prompt 版本：寫進 ai_generations.prompt_version（格式 v2:套路代號），方便日後比較哪個套路成效好 */
export const PROMPT_VERSION = 'v3';
/** 正式環境用哪一版（回測通過才切換）；回測時用 GenOpts.variant 指定 */
export const ACTIVE_PROMPT: 'v2' | 'v3' = 'v3'; // 2026-11-19 回測：觸及預測分數 v2 57～58 → v3 70～81，開頭雷同度 0.1 → 0.0

/** 開頭不能直接套用的套話：模板只當骨架，照抄會讓每個帳號看起來一樣，也是演算法判定低品質的訊號 */
export const STOCK_OPENERS = ['其實只在乎三件事', '只在乎三件事', '醒醒吧', '這不是你能力的問題', '別再被假', '像在「乞討」', '像在乞討', '別傻了', '你以為只要'];
/** 金融借貸敏感詞：Meta 對推薦借貸類內容較保守，開頭避開，改講生活裡的錢 */
export const SENSITIVE_HOOK = ['借錢', '借款', '貸款', '放款', '核貸', '撥款', '利率', '利息', '額度', '調頭寸', '週轉', '周轉', '融資', '信貸'];

/** 開頭切入角度：每篇隨機指定一種，避免 AI 每篇都寫成同一個場景（回測發現會一直寫「週五晚上的咖啡廳」） */
export const OPENING_ANGLES = [
  '從一則大家都知道的時事、節日或季節切入', '從一句客戶或身邊人真的會說的話（引號）切入', '從一個反直覺的數字或比例切入（只能用可引用數據，沒有就用情境假設）',
  '從一個具體物品切入（收據、合約、手機畫面、行事曆…自己挑）', '從兩種人的對比切入', '從一個常見誤解或流行說法切入，然後反駁',
  '從一段對話切入', '從一個時間點的倒數切入', '從一個職業或身分的日常切入', '從讀者會想留言反駁的一句話切入',
];

/** v3：比對自家帳號與高觸及帳號（SnakeSponsor）後加上的「觸及規則」 */
function reachRules(o: GenOpts, finance: boolean): string[] {
  return [
    '# 觸及規則（最高優先，Threads 演算法會先看第一則決定要不要推）',
    '・第一則一定要有「具體錨點」：一個看得見的人、場景、時間點或金額（人物身分、地點、時刻、物品、金額擇一兩個）。不要用抽象概念開頭（例如「資金安排」「品牌經營」「短影音策略」）。',
    '・場景要自己想、而且每篇不同：不要用「手機跳出通知」「一張帳單擺在桌上」「週五晚上的咖啡廳」這種大家都用過的開場，也不要跟下面列出的最近開頭用同一個場景。',
    `・這篇的開頭切入角度：${o.angle ?? OPENING_ANGLES[0]}。`,
    '・優先從讀者這陣子正在關注、大家都知道的事切入（節日、發薪日、購物節、新手機、熱門遊戲、演唱會、季節、社群上正在吵的話題），再轉到你的觀點；只用大家都知道的事實，不要編造新聞細節。',
    '・情境裡的金額、人數可以寫成「假設」「例如」的情境數字，但不能寫成統計結果或研究。',
    `・下列套話不能出現在第一則（模板只是骨架，換成你自己的說法）：${STOCK_OPENERS.join('、')}。`,
    '・第一則要能單獨被看懂、讓人想點開看下一則；不要只丟一個口號。',
    '・最後一則（系統會在它後面加 CTA）要先放一行讀者可以直接回答的問句，結尾用「？」，例如二選一或「你遇過嗎？」，讓人想留言；留言比按讚更能換到推薦。',
    finance ? `・本品牌是金融相關：第一則與第二則不要出現這些字：${SENSITIVE_HOOK.join('、')}；改講生活裡跟錢有關的處境（月底、帳單、家人、工作、夢想），服務留到最後一則再輕帶。` : '',
    o.recent?.length ? `・同品牌各帳號最近已經發過或排好的開頭如下，這篇的題材、切角和開頭都不能跟它們相似：\n${o.recent.map((h) => `  ・${h}`).join('\n')}` : '',
    '',
  ];
}

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
  const v3 = (o.variant ?? ACTIVE_PROMPT) === 'v3';
  const finance = regulated || /借|貸|資金|理財|財務|金融|錢/.test(`${brand.industry}${brand.description}${s.services}`);
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
    ...(v3 ? reachRules(o, finance) : []),
    '# 寫作規則',
    max === 1 ? '・只寫 1 則。' : `・共 ${min} 到 ${max} 則。第 1 則是鉤子：1 到 3 行、不超過 60 字，不給答案、不放連結。`,
    '・每則 2～8 行，一則只講一個重點。',
    '',
    '# 排版規則（手機上要整齊，務必遵守）',
    '# 斷行嚴格規則（違反就整串重寫）',
    '・只能在標點符號後面換行：每一行的最後一個字必須是標點（，。？！：；…）或 emoji。',
    '・絕對不能在一句話中間換行（不准斷句）。錯誤示範：「很多人以為只要」換行「努力就會成功」。正確：「很多人以為，只要努力就會成功。」',
    `・每一行 ${LINE_MIN}～${LINE_MAX} 個字（含標點）：最少 ${LINE_MIN} 字、最多 ${LINE_MAX} 字；不要三五個字就換行，短句用逗號接在同一行。`,
    `・一句話超過 ${LINE_MAX} 個字時，把句子改短，或在句中的逗號處換行；寧可整句放在同一行，也不能從句子中間切開。`,
    '・每一句都要有標點符號，換行的地方也要保留標點，不要把標點拿掉。',
    '・不要把「」裡的詞、數字和單位、英文單字拆到兩行。',
    '・段落之間空一行，只空一行；不要用「-」「—」「---」之類的符號分隔。',
    '・條列時每一項獨立一行，用 emoji 或 1️⃣2️⃣3️⃣ 開頭；項目的說明寫在下一行，不要跟在同一行後面。',
    '・行首、行尾不要空格。',
    '・懸念切割：前一則停在「真相是……」「而是⋯」，下一則開頭重複這句再揭曉。',
    '・至少一次翻轉歸因：「這不是你能力的問題，而是＿＿的問題」。',
    '・至少一組二元對比，例如：成本 vs 投資、被管理者 vs 資產、要錢 vs 創造價值。',
    '・重新定義：「＿＿在意的不是＿＿，而是＿＿」。',
    '・關鍵詞用「」框起來；emoji 只當段落標記（👉💬1️⃣2️⃣3️⃣🚫💥🧭🔍📩🤔📈🧠✔️），每則最多 3 個。',
    '・語氣直接、略帶挑釁（別傻了、醒醒吧、錯！），但最後一定站在讀者這邊；不得人身攻擊、歧視、針對特定個人或品牌。',
    '・不加 hashtag，不寫「總之」，不寫網址。',
    '',
    '# 事實規則（最高優先，違反就整串作廢）',
    v3 ? '・統計數字、比例、排名、報告、引言、客戶案例只能來自「可引用數據」，並寫出來源；情境裡的假設金額可以用，但要寫成「假設」「例如」。'
      : '・數字、比例、金額、排名、報告、引言、客戶案例只能來自「可引用數據」，並寫出來源。',
    '・沒有素材時改用具體場景、案例情境或邏輯推演，不要寫成統計結果；不可以寫「研究顯示」「某業內人直言」「調查發現」這類沒有出處的說法。',
    o.autoPublish
      ? '・這串會直接自動發布，沒有人會再修改：絕對不要寫【待補數據】或任何要人補的空格、括號註記；沒有素材就不要用數字，改用具體場景或邏輯推演。'
      : '・真的需要一個數字才講得通時，寫成【待補數據：要補什麼】讓人工補上；只用於數字，整串最多 2 處。',
    o.autoPublish ? '・不要用「保證」「零風險」「0 費用」「免審核」「秒過件」這類誇大或絕對的說法。' : '',
    regulated ? '・本業務受金融法規監管：只提供一般知識與諮詢邀請，不得提及任何利率、成數、額度或核貸可能性，也不得使用【待補數據】以外的數字。' : '',
    '',
    '# 結尾',
    '・最後一則：可先用 🧭 反問收束 →「這就是我們在做的事」或「你不是一個人」→ 一句價值主張（不賣夢想，專賣＿＿）→ 一句邀請讀者私訊或加 LINE，最後一行用「👇」結尾。',
    '・不要自己寫連結或 LINE ID，系統會在最後一則下方自動附上 CTA 與連結。',
    `・每則不超過 ${THREADS_MAX_CHARS - 80} 字。`,
    o.fix?.length ? `\n# 修正\n上一版沒有通過檢查，這次一定要避開：\n${o.fix.map((x) => `・${x}`).join('\n')}` : '',
    o.rewriteOf ? `\n# 改寫\n請改寫以下串文：保留核心觀點，但鉤子、切角、用字與例子要完全不同，符合上述人設，避免與原文雷同。\n原文：\n${o.rewriteOf.map((p, i) => `(${i + 1}) ${p}`).join('\n')}` : '',
    '',
    '# 輸出',
    v3 ? '・另外給這串一個 Threads 主題標籤 topic_tag：2～12 個字，是目標讀者會追蹤或搜尋的興趣社群，而且要跟本品牌的服務直接相關（開頭用時事切入也一樣，標籤要回到品牌領域，例如「小資理財」「短影音剪輯」「房仲經營」），不要用品牌名稱，不含 #、句點與 &。'
      : '・另外給這串一個 Threads 主題標籤 topic_tag：2～12 個字、跟這串的主題直接相關、讀者會搜尋的詞（例如「短影音剪輯」「房仲經營」），不含 #、句點與 &。',
    '只輸出 JSON：{"parts":["第1則內文","第2則內文", ...],"topic_tag":"主題標籤"}，不要輸出套路說明、備選鉤子或其他文字。',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 解析模型輸出：優先 JSON；失敗時整段視為單則。 */
/** 貼文結尾用的加好友連結：有設定 LINE 官方短網址（lin.ee）就用它，否則用 line.me 連結（發布時換成系統追蹤短連結） */
export const postLink = (s: Pick<Settings, 'line_add_url' | 'line_short_url'>) => s.line_short_url || s.line_add_url;

/** 手機上一行能完整顯示的字數（保守值）；超過的行會被自動折行，排版就亂了 */
export const LINE_MAX = 18;
/** 一行至少寫到這個字數再換行（客戶要求：不要三五個字就換行） */
export const LINE_MIN = 15;

/** 整理排版：去掉行首尾空白、行尾逗號、當分隔線用的「-」，多個空行合成一個 */
export function tidyPart(s: string): string {
  const lines = s.replace(/\r/g, '').split('\n')
    .map((l) => l.trim())
    .map((l) => (/^[-—–_─]{1,5}$/.test(l) ? '' : l));
  return mergeShortLines(lines).flatMap(wrapAtPunct).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 太長的行在標點後面換行，每行盡量寫滿但不超過上限；單一個子句本身就超過上限時整句保留，絕不從句子中間切。
 * 有網址的行不動。
 */
export function wrapAtPunct(line: string): string[] {
  if (len(line) <= LINE_MAX || /https?:\/\//.test(line)) return [line];
  // 子句＝內容＋標點＋緊接的右引號／括號（不讓「」」被擠到下一行開頭）＋ emoji
  const clauses = line.match(/[^，。？！；：…,?!;:]+[，。？！；：…,?!;:]*[」』）)】]*\s*(\p{Extended_Pictographic}\uFE0F?)*/gu) ?? [line];
  const out: string[] = [];
  let cur = '';
  for (const c of clauses.map((x) => x.trim()).filter(Boolean)) {
    if (cur && len(cur) + len(c) > LINE_MAX) { out.push(cur); cur = c; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const len = (t: string) => [...t].length;
const ENDS_PUNCT = /[，。？！：；、,.?!:;…⋯」』）)👇]$/u;
const LIST_HEAD = /^(\p{Extended_Pictographic}|[0-9]️⃣|[0-9]+[.、)]|[-•・])/u;
/**
 * 不准斷句（嚴格規則）：同一段裡，行尾不是標點就代表句子被從中間切開，直接接回下一行（不加標點，避免加錯）。
 * 條列項目（emoji、1️⃣ 開頭）的標題行與空行不動。寧可一行長一點，也不在句子中間換行。
 */
export function mergeShortLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    if (prev && l && !LIST_HEAD.test(l) && !LIST_HEAD.test(prev) && !ENDS_PUNCT.test(prev) && !/\p{Extended_Pictographic}$/u.test(prev)) {
      out[out.length - 1] = `${prev}${l}`; // 句子被切開：接回去
    } else if (prev && l && !LIST_HEAD.test(l) && !LIST_HEAD.test(prev) && /[，、：；,:;]$/.test(prev) && len(prev) < LINE_MIN && len(prev) + len(l) <= LINE_MAX) {
      out[out.length - 1] = `${prev}${l}`; // 逗號後就換行、又不到最少字數：同一句的下一段接上來
    } else out.push(l);
  }
  return out;
}

/** 讀出模型給的主題標籤（沒有就是空字串） */
export function parseTag(raw: string): string {
  try { const j = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); return toTag(j?.topic_tag ?? ''); } catch { return ''; }
}

/** 格式檢查：要能解析成 JSON 的 parts，則數夠、每則不超過 Threads 上限 */
export function wellFormed(raw: string, minParts: number): boolean {
  const t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const j = JSON.parse(t), arr = Array.isArray(j) ? j : j?.parts;
    if (!Array.isArray(arr)) return false;
    const p = arr.map((x: unknown) => String(x ?? '').trim()).filter(Boolean);
    return p.length >= minParts && p.every((x: string) => [...x].length <= THREADS_MAX_CHARS);
  } catch { return !/^[{[]/.test(t); } // 純文字（非 JSON）沿用舊的單則處理；看起來是 JSON 卻壞掉才算失敗
}

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
  const variant = o.variant ?? ACTIVE_PROMPT;
  const last = await env.DB.prepare(`SELECT prompt_version v FROM ai_generations WHERE brand_id=? AND prompt_version LIKE 'v_:%' ORDER BY id DESC LIMIT 1`).bind(brand.id).first<{ v: string }>();
  // v3：同品牌各帳號最近的開頭一起給 AI，避免幾個帳號同時寫出雷同的貼文
  if (variant === 'v3' && !o.recent) {
    const rows = (await env.DB.prepare(`SELECT content FROM posts WHERE brand_id=? AND content IS NOT NULL AND status IN ('published','scheduled','draft','publishing') ORDER BY id DESC LIMIT 15`).bind(brand.id).all<{ content: string }>()).results;
    o = { ...o, recent: rows.map((r) => String(r.content).split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 50)) };
  }
  const pattern = o.pattern ?? pickPattern(!!s.fact_bank?.trim(), last?.v?.split(':')[1]);
  o = { ...o, pattern, variant, angle: o.angle ?? OPENING_ANGLES[Math.floor(Math.random() * OPENING_ANGLES.length)] };
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const started = Date.now();
  const record = async (status: string, text: string | null, err: string | null, inT = 0, outT = 0) =>
    (await env.DB.prepare(
      `INSERT INTO ai_generations(brand_id,provider,model,prompt_version,input_tokens,output_tokens,status,result,error_message,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(brand.id, 'gemini', model, `${variant}:${pattern}`, inT, outT, status, text, err, Date.now() - started, iso(now)).run()).meta.last_row_id as number;
  const max = Math.max(1, s.thread_max ?? 7), min = Math.min(max, Math.max(1, s.thread_min ?? 4));
  const call = () => geminiFetch(env)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(brand, s, o) }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 3000, responseMimeType: 'application/json' },
    }),
  });
  try {
    let res = await call(), data: any = null, raw = '';
    // 格式壞掉（JSON 沒寫好、整串塞成一則）或 Gemini 暫時忙碌：自動再寫一次
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) res = await call();
      if (res.status === 503 && attempt === 0) continue;
      if (!res.ok) break;
      data = await res.json();
      raw = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
      if (wellFormed(raw, max === 1 ? 1 : Math.min(2, min))) break;
    }
    if (!res.ok) {
      // 記下 Gemini 說的原因（例如地區不支援、模型名稱錯誤、金鑰無效），不記任何內容或金鑰
      const eb: any = await res.json().catch(() => ({}));
      const why = [eb?.error?.status, eb?.error?.message].filter(Boolean).join(' ').replace(/key=[^&\s]+/gi, 'key=***').slice(0, 200);
      throw new Error(`Gemini HTTP ${res.status}${why ? `：${why}` : ''}`);
    }
    if (!raw.trim()) throw new Error('Gemini 回傳空內容');
    if (!wellFormed(raw, max === 1 ? 1 : Math.min(2, min))) throw new Error('AI 回傳的格式不正確（重試後仍失敗），稍後再試');
    const e = effective(o.account ?? null, s);
    const parts = appendCta(parseParts(raw).map(tidyPart).filter(Boolean).slice(0, max), e.cta, postLink(s));
    const id = await record('ok', JSON.stringify(parts), null, data?.usageMetadata?.promptTokenCount ?? 0, data?.usageMetadata?.candidatesTokenCount ?? 0);
    return { generationId: id, parts, tag: parseTag(raw), issues: checkParts(parts, { industry: brand.industry, bannedWords: jsonArr(s.banned_words) }) };
  } catch (e) {
    await record('failed', null, String((e as Error).message).slice(0, 300));
    throw e;
  }
}
