// LINE 官方帳號 ID（@xxx）與加好友連結互轉。
const ID = /^@?([a-z0-9._-]{3,40})$/i;

/** 官方帳號 ID → 加好友連結；格式不正確回傳 null。也接受直接貼上的加好友網址。 */
export function lineAddUrl(input: string): string | null {
  const v = String(input ?? '').trim();
  const fromUrl = lineIdFromUrl(v);
  if (fromUrl) return `https://line.me/R/ti/p/${fromUrl}`;
  const m = v.replace(/\s+/g, '').match(ID);
  return m ? `https://line.me/R/ti/p/@${m[1].toLowerCase()}` : null;
}

/** 加好友連結 → 官方帳號 ID（含 @）；不是這種連結時回傳空字串。 */
export function lineIdFromUrl(url: string | null | undefined): string {
  const m = String(url ?? '').match(/line\.me\/(?:R\/)?ti\/p\/(?:%40|@)([a-z0-9._-]{3,40})/i);
  return m ? `@${m[1].toLowerCase()}` : '';
}
