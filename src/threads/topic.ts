// Threads 主題標籤：每篇最多 1 個，用 API 的 topic_tag 參數帶入（不寫進內文）。
/** 整理並檢查標籤：去掉開頭的 #、前後空白；1～50 字，不能有句點和 &。回傳 null 代表格式不對，'' 代表不加 */
export function normTopicTag(v: unknown): string | null {
  const t = String(v ?? '').trim().replace(/^#+/, '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  if ([...t].length > 50 || /[.&#\n]/.test(t)) return null;
  return t;
}
/** 這篇實際要用的標籤：貼文自己有設定就用貼文的（空字串＝客戶自己拿掉，不加）；否則用品牌預設，再沒有就用保底標籤 */
export const effectiveTag = (postTag: string | null | undefined, brandTag: string | undefined, fallback = '') =>
  (postTag !== null && postTag !== undefined ? postTag : brandTag || fallback).trim();

/** 把任意文字整理成可用的標籤（AI 給的、品牌主題）：去掉 # . & 與多餘空白，最多 50 字；整理不出來回傳 '' */
export function toTag(v: unknown): string {
  const t = String(v ?? '').replace(/[#.&\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, 50).join('').trim();
}
/** 保底標籤：品牌簡稱（品牌名稱在「｜」或括號前的部分），用在貼文沒有標籤、品牌也沒設定預設標籤時 */
export function autoTag(brandName: string): string {
  return toTag(String(brandName ?? '').split(/[｜|（(]/)[0]);
}
