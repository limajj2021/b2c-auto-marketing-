// 導流分析：每篇貼文的點擊率排行，以及「推估」每篇帶來的新好友數。
// 推估方式：每天的新好友，依當天各篇貼文的不重複點擊人數比例分配。LINE 不會告訴我們好友是從哪個連結來的，
// 所以這是估算值；當天沒有任何點擊的新好友（例如掃 QR Code、搜尋加入）歸為「其他來源」。

export interface PostRow {
  id: number; hook: string; username: string | null; published_at: string;
  views: number | null; clicks: number; uniques: number;
}
export interface Traffic {
  /** legacy：人數統計上線前的貼文，只有點擊次數（以次數計算點擊率） */
  posts: (PostRow & { ctr: number | null; est_friends: number | null; legacy: boolean })[];
  by_account: Group[]; by_slot: Group[];
  other_friends: number; attributed_friends: number; unique_since: string | null;
}
export interface Group { key: string; posts: number; views: number; uniques: number; ctr: number | null; est_friends: number | null }

/** 依發布時間（工作區時區）分成五個時段 */
export const SLOTS: [string, number, number][] = [['清晨 05–09', 5, 9], ['上午 09–12', 9, 12], ['午間 12–14', 12, 14], ['下午 14–18', 14, 18], ['晚上 18–23', 18, 23], ['深夜 23–05', 23, 5]];
export function slotOf(isoTime: string, timezone: string): string {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(isoTime)));
  for (const [k, a, b] of SLOTS) if (a < b ? h >= a && h < b : h >= a || h < b) return k;
  return SLOTS[SLOTS.length - 1][0];
}

/** 曝光太少時點擊率沒有參考價值 */
const MIN_VIEWS = 50;
const rate = (u: number, v: number | null) => (v && v >= MIN_VIEWS ? u / v : null);
const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildTraffic(
  posts: PostRow[], daily: { day: string; post_id: number; uniques: number }[], friendsByDay: Map<string, number>,
  timezone: string, hasFriends: boolean,
): Traffic {
  // 1) 每天的總不重複點擊
  const dayTotal = new Map<string, number>();
  for (const d of daily) dayTotal.set(d.day, (dayTotal.get(d.day) ?? 0) + d.uniques);
  // 2) 依比例分配當天新好友
  const est = new Map<number, number>();
  let attributed = 0, other = 0;
  for (const [day, f] of friendsByDay) {
    const tot = dayTotal.get(day) ?? 0;
    if (!tot) { other += f; continue; }
    attributed += f;
  }
  for (const d of daily) {
    const tot = dayTotal.get(d.day) ?? 0, f = friendsByDay.get(d.day) ?? 0;
    if (tot && f && d.uniques) est.set(d.post_id, (est.get(d.post_id) ?? 0) + (f * d.uniques) / tot);
  }
  // 人數統計上線前的貼文沒有人數，改用點擊次數，避免被誤判成 0 人
  const rows = posts.map((p) => {
    const legacy = !p.uniques && p.clicks > 0, u = legacy ? p.clicks : p.uniques;
    return { ...p, uniques: u, legacy, ctr: rate(u, p.views), est_friends: hasFriends && !(legacy && !est.has(p.id)) ? round1(est.get(p.id) ?? 0) : null };
  });
  // 3) 排序：有足夠曝光的依點擊率，其餘依點擊人數
  const ranked = [...rows].filter((p) => p.uniques > 0 || (p.views ?? 0) > 0)
    .sort((a, b) => (b.ctr ?? -1) - (a.ctr ?? -1) || b.uniques - a.uniques || (b.views ?? 0) - (a.views ?? 0));
  const group = (keyOf: (p: typeof rows[number]) => string): Group[] => {
    const m = new Map<string, Group & { _v: number }>();
    for (const p of rows) {
      const k = keyOf(p);
      const g = m.get(k) ?? { key: k, posts: 0, views: 0, uniques: 0, ctr: null, est_friends: hasFriends ? 0 : null, _v: 0 };
      g.posts++; g.uniques += p.uniques;
      if (p.views !== null) { g.views += p.views; g._v += p.views; }
      if (g.est_friends !== null) g.est_friends += p.est_friends ?? 0;
      m.set(k, g);
    }
    return [...m.values()].map(({ _v, ...g }) => ({ ...g, ctr: rate(g.uniques, _v || null), est_friends: g.est_friends === null ? null : round1(g.est_friends) }))
      .sort((a, b) => (b.ctr ?? -1) - (a.ctr ?? -1) || b.uniques - a.uniques);
  };
  const firstDay = daily.filter((d) => d.uniques > 0).map((d) => d.day).sort()[0] ?? null;
  return {
    posts: ranked.slice(0, 10),
    by_account: group((p) => (p.username ? '@' + p.username : '預設帳號')),
    by_slot: group((p) => slotOf(p.published_at, timezone)),
    other_friends: other, attributed_friends: attributed, unique_since: firstDay,
  };
}
