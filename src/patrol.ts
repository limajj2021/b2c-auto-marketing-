// 半自動海巡：老闆在 Threads 找到別人的貼文 → 貼上連結（可附內文）→ 系統依關鍵字推薦固定回覆範本 →
// 一鍵開啟 Threads 的回覆視窗（內容已填好，由本人按發佈）。不搜尋、不爬取、不代發，完全由使用者自己送出。
export interface Template { id: number; title: string; keywords: string[]; reply: string; enabled: boolean; uses: number }

/** 從 Threads 貼文網址取出代碼與作者；不是 Threads 貼文網址時回傳 null */
export function parsePostUrl(input: string): { shortcode: string; author: string } | null {
  const m = String(input ?? '').trim().match(/^https?:\/\/(?:www\.)?threads\.(?:com|net)\/@([A-Za-z0-9._]{1,30})\/post\/([A-Za-z0-9_-]{5,40})/);
  return m ? { author: m[1], shortcode: m[2] } : null;
}

export const normKeywords = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，、\n]/);
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, 30)))].slice(0, 20);
};

/** 依貼文內容推薦範本：命中越多關鍵字越前面；沒有內文時照使用次數排序 */
export function rank(templates: Template[], text: string): (Template & { hits: string[] })[] {
  const t = (text || '').toLowerCase();
  return templates.filter((x) => x.enabled)
    .map((x) => ({ ...x, hits: t ? x.keywords.filter((k) => t.includes(k.toLowerCase())) : [] }))
    .sort((a, b) => b.hits.length - a.hits.length || b.uses - a.uses || a.id - b.id);
}

/** 套入變數：{LINE} 換成加好友連結，{品牌} 換成品牌名稱 */
export const fill = (reply: string, vars: { line: string; brand: string }) =>
  reply.replace(/\{LINE\}/gi, vars.line).replace(/\{品牌\}/g, vars.brand).trim();
