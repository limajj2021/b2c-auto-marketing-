export interface FaqRule { keyword: string; response: string; priority: number }

/** 固定規則比對：priority 高者優先；keyword 以逗號/頓號分隔多個候選詞。 */
export function matchFaq(text: string, rules: FaqRule[]): FaqRule | null {
  const t = text.trim().toLowerCase();
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    const kws = r.keyword.split(/[,，、]/).map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (kws.some((k) => t.includes(k))) return r;
  }
  return null;
}
