// 全自動發文的「找題材」：先讀這個帳號（與品牌）過去寫過的貼文，再請 AI 提出一個沒寫過的題材或觀點。
// 來源：系統裡的貼文（含題材紀錄）＋ Threads 帳號上實際發過的貼文（包含不是用本系統發的）。
// AI 提完會再用字面相似度檢查一次，太像就請它換一個。
import { BudgetError, canAfford, geminiFetch } from '../budget';
import { resolveCred, type Account } from '../threads/accounts';
import { listRecent } from '../threads/api';
import type { Brand, Env, Settings } from '../types';
import { iso } from '../util/time';
import { buildPrompt } from './gemini';

export interface Idea { topic: string; angle: string }

const HISTORY_MAX = 120;
const SIMILAR = 0.5;

const clip = (t: string, n = 70) => t.replace(/\s+/g, ' ').trim().slice(0, n);

/** 過去寫過的內容：每篇一行（題材｜觀點，或開頭一句），新的在前 */
export async function collectHistory(env: Env, brandId: string, account: Account | null): Promise<string[]> {
  const rows = (await env.DB.prepare(
    `SELECT idea,content,parts FROM posts WHERE brand_id=? AND content IS NOT NULL AND status NOT IN ('deleted','generating','gen_failed')
     ORDER BY (account_id IS ?) DESC, id DESC LIMIT ?`,
  ).bind(brandId, account?.id ?? null, HISTORY_MAX).all<any>()).results;
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => { const k = clip(t); if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
  for (const r of rows) {
    if (r.idea) { push(r.idea); continue; }
    let second = '';
    try { second = (JSON.parse(r.parts ?? '[]')[1] ?? '').split('\n')[0]; } catch { /* 舊資料 */ }
    push(`${String(r.content).split('\n')[0]}${second ? '／' + second : ''}`);
  }
  // Threads 上實際發過的貼文（可能有不是用本系統發的）；讀不到不影響生成
  if (account && canAfford(env, 12)) {
    try {
      const cred = await resolveCred(env, account.id);
      if (cred) for (const p of await listRecent(cred, 50)) if (p.text) push(p.text.split('\n').slice(0, 2).join('／'));
    } catch (e) { if (e instanceof BudgetError) throw e; }
  }
  return out.slice(0, HISTORY_MAX);
}

/** 字面相似度（中文以兩字為單位比對） */
export function similarity(a: string, b: string): number {
  const grams = (t: string) => { const s = t.replace(/[\s\p{P}\p{S}]/gu, ''); const g = new Set<string>(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0; for (const g of x) if (y.has(g)) hit++;
  return hit / Math.min(x.size, y.size);
}

export function ideaPrompt(brand: Brand, s: Settings, account: Account | null, history: string[], avoid: string[] = []): string {
  const guide = buildPrompt(brand, s, { account }).split('\n# 輸出')[0].trim();
  return `${guide}

# 這次的任務：只想題材，不寫貼文
下面是這個帳號已經寫過的貼文（每行一篇：題材｜觀點，或開頭）。
${history.length ? history.map((h) => `・${h}`).join('\n') : '（還沒有寫過任何貼文）'}
${avoid.length ? `\n這些點子跟寫過的太像，不能用：\n${avoid.map((h) => `・${h}`).join('\n')}\n` : ''}
請提出 1 個「全新」的題材與核心觀點，條件：
1. 題材不能跟上面任何一篇相同；同一個主題換句話說、換個例子也算重複。
2. 可以是完全沒碰過的題材；或是寫過的領域裡，一個從沒講過、甚至相反的觀點。
3. 要在品牌的服務與受眾範圍內，讓目標受眾看了會想留言或私訊。
4. 不要編造數字或案例。
只輸出 JSON：{"topic":"題材（15 字內）","angle":"核心觀點（一句話，40 字內）"}`;
}

const parseIdea = (raw: string): Idea | null => {
  try {
    const j = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
    const topic = clip(String(j.topic ?? ''), 30), angle = clip(String(j.angle ?? ''), 80);
    return topic && angle ? { topic, angle } : null;
  } catch { return null; }
};

/** 請 AI 想一個沒寫過的題材；太像寫過的就再問一次。用量記在 ai_generations（prompt_version=idea）。 */
export async function ideate(env: Env, brand: Brand, s: Settings, account: Account | null, history: string[], now = new Date()): Promise<Idea | null> {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const avoid: string[] = [];
  for (let round = 0; round < 2; round++) {
    const started = Date.now();
    const res = await geminiFetch(env)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: ideaPrompt(brand, s, account, history, avoid) }] }], generationConfig: { temperature: 1, maxOutputTokens: 400, responseMimeType: 'application/json' } }),
    });
    const data: any = await res.json().catch(() => ({}));
    const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    const idea = res.ok ? parseIdea(raw) : null;
    await env.DB.prepare(`INSERT INTO ai_generations(brand_id,provider,model,prompt_version,input_tokens,output_tokens,status,result,error_message,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(brand.id, 'gemini', model, 'idea', data?.usageMetadata?.promptTokenCount ?? 0, data?.usageMetadata?.candidatesTokenCount ?? 0, idea ? 'ok' : 'failed', idea ? JSON.stringify(idea) : null, idea ? null : `找題材失敗（HTTP ${res.status}）`, Date.now() - started, iso(now)).run();
    if (!idea) return null;
    const text = `${idea.topic}｜${idea.angle}`;
    if (!history.some((h) => similarity(text, h) >= SIMILAR)) return idea;
    avoid.push(text);
  }
  return null;
}
