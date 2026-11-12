import type { Cred } from './accounts';

const BASE = 'https://graph.threads.net/v1.0';

/** 平台有回應並明確拒絕（可判定「未發布」）。 */
export class ThreadsApiError extends Error {
  constructor(public status: number, public code: number | undefined, msg: string) { super(msg); }
  get tokenInvalid() { return this.status === 401 || this.code === 190; }
  /** 缺少權限（例如未授權 threads_manage_replies 卻嘗試串文） */
  get permission() { return this.code === 10 || this.code === 200 || /permission/i.test(this.message); }
}
/** 請求送出後未取得回應（結果未知）。 */
export class ThreadsUnknownError extends Error {}

async function call(url: string, init: RequestInit, f: typeof fetch = fetch): Promise<any> {
  let res: Response;
  try { res = await f(url, init); } catch (e) { throw new ThreadsUnknownError(String((e as Error).message)); }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ThreadsApiError(res.status, body?.error?.code, body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}
const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/** 步驟 1：建立 media container；replyTo 有值時成為該則的回覆（串文） */
export async function createContainer(c: Cred, text: string, replyTo?: string): Promise<string> {
  const p: Record<string, string> = { media_type: 'TEXT', text, access_token: c.token };
  if (replyTo) p.reply_to_id = replyTo;
  return (await call(`${BASE}/${c.userId}/threads`, form(p), c.f)).id as string;
}
/** 步驟 2：發布 container，回傳平台貼文 ID */
export async function publishContainer(c: Cred, creationId: string): Promise<string> {
  return (await call(`${BASE}/${c.userId}/threads_publish`, form({ creation_id: creationId, access_token: c.token }), c.f)).id as string;
}
/** 核對用：取得近期已發布貼文 */
export async function listRecent(c: Cred, limit = 25): Promise<{ id: string; text?: string; timestamp?: string }[]> {
  const r = await call(`${BASE}/${c.userId}/threads?fields=id,text,timestamp&limit=${limit}&access_token=${encodeURIComponent(c.token)}`, { method: 'GET' }, c.f);
  return r.data ?? [];
}

/** Threads 成效數據（需 threads_manage_insights）。回傳 null 代表沒有權限。 */
export async function postInsights(c: Cred, mediaId: string): Promise<Record<string, number> | null> {
  const metrics = 'views,likes,replies,reposts,quotes,shares';
  try {
    const r = await call(`${BASE}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(c.token)}`, { method: 'GET' }, c.f);
    const out: Record<string, number> = {};
    for (const d of r.data ?? []) out[d.name] = Number(d.total_value?.value ?? d.values?.[0]?.value ?? 0);
    return out;
  } catch (e) {
    if (e instanceof ThreadsApiError && e.permission) return null;
    throw e;
  }
}
