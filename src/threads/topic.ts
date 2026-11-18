// Threads 主題標籤：每篇最多 1 個，用 API 的 topic_tag 參數帶入（不寫進內文）。
/** 整理並檢查標籤：去掉開頭的 #、前後空白；1～50 字，不能有句點和 &。回傳 null 代表格式不對，'' 代表不加 */
export function normTopicTag(v: unknown): string | null {
  const t = String(v ?? '').trim().replace(/^#+/, '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if ([...t].length > 50 || /[.&#\n]/.test(t)) return null;
  return t;
}
/** 這篇實際要用的標籤：貼文自己有設定（含「不加」）就用貼文的，否則用品牌預設 */
export const effectiveTag = (postTag: string | null | undefined, brandTag: string | undefined) => (postTag ?? brandTag ?? '').trim();
