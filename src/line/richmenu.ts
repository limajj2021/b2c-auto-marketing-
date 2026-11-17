// LINE 圖文選單：後台畫好圖（瀏覽器產生）→ 系統建立選單、上傳圖片、設為所有好友的預設選單。
// 由 API 設定的預設選單優先於 LINE 官方帳號後台設定的選單；移除後會回到官方帳號後台的設定。
import type { Env } from '../types';

export const LAYOUTS = {
  l6: { h: 1686, cols: 3, rows: 2 },
  l4: { h: 1686, cols: 2, rows: 2 },
  l3: { h: 843, cols: 3, rows: 1 },
  l2: { h: 843, cols: 2, rows: 1 },
} as const;
export type Layout = keyof typeof LAYOUTS;
const W = 2500;
const MAX_IMAGE = 1024 * 1024;

export interface MenuArea { label: string; type: 'url' | 'text'; value: string }
export interface MenuConfig { id?: string; layout: Layout; chatBarText: string; areas: MenuArea[]; style?: Record<string, string>; customImage?: boolean; updated_at?: string }

export class MenuError extends Error {}

/** 把版型切成格子（整數像素，最後一格吃掉餘數） */
export function bounds(layout: Layout) {
  const L = LAYOUTS[layout], out: { x: number; y: number; width: number; height: number }[] = [];
  const cw = Math.floor(W / L.cols), ch = Math.floor(L.h / L.rows);
  for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++)
    out.push({ x: c * cw, y: r * ch, width: c === L.cols - 1 ? W - c * cw : cw, height: r === L.rows - 1 ? L.h - r * ch : ch });
  return out;
}

/** 檢查並整理後台送來的設定；有問題時丟出 MenuError（訊息直接給使用者看） */
export function normalize(b: any): MenuConfig {
  const layout = b?.layout as Layout;
  if (!(layout in LAYOUTS)) throw new MenuError('版型不正確');
  const n = LAYOUTS[layout].cols * LAYOUTS[layout].rows;
  const areas: MenuArea[] = Array.isArray(b.areas) ? b.areas.slice(0, n) : [];
  if (areas.length !== n) throw new MenuError(`這個版型需要 ${n} 個按鈕`);
  const clean = areas.map((a, i) => {
    const label = String(a?.label ?? '').trim(), type = a?.type === 'url' ? 'url' : 'text', value = String(a?.value ?? '').trim();
    if (!label || label.length > 20) throw new MenuError(`第 ${i + 1} 個按鈕：名稱需要 1–20 個字`);
    if (type === 'url' && !/^(https?:\/\/[^\s]+|tel:[0-9+\-]{3,20})$/i.test(value)) throw new MenuError(`第 ${i + 1} 個按鈕：網址要以 https:// 開頭（或 tel: 電話）`);
    if (type === 'text' && (!value || value.length > 300)) throw new MenuError(`第 ${i + 1} 個按鈕：送出的文字需要 1–300 個字`);
    return { label, type, value } as MenuArea;
  });
  const chatBarText = String(b.chatBarText ?? '').trim() || '選單';
  if (chatBarText.length > 14) throw new MenuError('選單列文字最多 14 個字');
  const style: Record<string, string> = {};
  for (const k of ['bg', 'fg', 'theme']) if (typeof b.style?.[k] === 'string' && b.style[k].length <= 20) style[k] = b.style[k];
  return { layout, chatBarText, areas: clean, style, customImage: !!b.customImage };
}

/** data:image/jpeg;base64,... → bytes + 類型 */
export function decodeImage(dataUrl: unknown): { bytes: Uint8Array; type: string } {
  const m = String(dataUrl ?? '').match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new MenuError('圖片格式不正確（需要 JPEG 或 PNG）');
  const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > MAX_IMAGE) throw new MenuError('圖片超過 1MB，請換一張較小的圖片');
  return { bytes, type: m[1] };
}

const lineErr = async (r: Response, what: string) => {
  const b: any = await r.json().catch(() => ({}));
  const detail = b?.details?.map((d: any) => d.message).filter(Boolean).join('；') || b?.message || '';
  return new MenuError(`${what}失敗（LINE 回應 HTTP ${r.status}${detail ? `：${detail}` : ''}）`);
};

/** 建立選單 → 上傳圖片 → 設為預設；中途失敗會刪掉剛建立的選單，不留垃圾 */
export async function publishMenu(env: Env, cfg: MenuConfig, img: { bytes: Uint8Array; type: string }, oldId?: string): Promise<string> {
  const tok = env.LINE_CHANNEL_ACCESS_TOKEN; if (!tok) throw new MenuError('請先連接 LINE 官方帳號');
  const auth = { authorization: `Bearer ${tok}` };
  const L = LAYOUTS[cfg.layout];
  const body = {
    size: { width: W, height: L.h }, selected: true, name: `menu-${Date.now()}`.slice(0, 300), chatBarText: cfg.chatBarText,
    areas: bounds(cfg.layout).map((bd, i) => {
      const a = cfg.areas[i];
      return { bounds: bd, action: a.type === 'url' ? { type: 'uri', label: a.label, uri: a.value } : { type: 'message', label: a.label, text: a.value } };
    }),
  };
  const cr = await fetch('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!cr.ok) throw await lineErr(cr, '建立圖文選單');
  const id = String(((await cr.json()) as any).richMenuId ?? '');
  if (!id) throw new MenuError('建立圖文選單失敗（LINE 沒有回傳選單編號）');
  try {
    const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${id}/content`, { method: 'POST', headers: { ...auth, 'content-type': img.type }, body: img.bytes });
    if (!up.ok) throw await lineErr(up, '上傳選單圖片');
    const df = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${id}`, { method: 'POST', headers: auth });
    if (!df.ok) throw await lineErr(df, '設為預設選單');
  } catch (e) {
    await fetch(`https://api.line.me/v2/bot/richmenu/${id}`, { method: 'DELETE', headers: auth }).catch(() => {});
    throw e;
  }
  if (oldId && oldId !== id) await fetch(`https://api.line.me/v2/bot/richmenu/${oldId}`, { method: 'DELETE', headers: auth }).catch(() => {});
  return id;
}

/** 取消預設並刪除選單：好友會回到 LINE 官方帳號後台設定的選單（若有） */
export async function removeMenu(env: Env, id?: string): Promise<void> {
  const tok = env.LINE_CHANNEL_ACCESS_TOKEN; if (!tok) throw new MenuError('請先連接 LINE 官方帳號');
  const auth = { authorization: `Bearer ${tok}` };
  const r = await fetch('https://api.line.me/v2/bot/user/all/richmenu', { method: 'DELETE', headers: auth });
  if (!r.ok && r.status !== 404) throw await lineErr(r, '取消預設選單');
  if (id) await fetch(`https://api.line.me/v2/bot/richmenu/${id}`, { method: 'DELETE', headers: auth }).catch(() => {});
}

/** 目前所有好友的預設選單編號（API 設定的）；沒有時回傳 null */
export async function currentDefault(env: Env): Promise<string | null> {
  const tok = env.LINE_CHANNEL_ACCESS_TOKEN; if (!tok) return null;
  const r = await fetch('https://api.line.me/v2/bot/user/all/richmenu', { headers: { authorization: `Bearer ${tok}` } }).catch(() => null);
  if (!r || !r.ok) return null;
  return String(((await r.json().catch(() => ({}))) as any).richMenuId ?? '') || null;
}
