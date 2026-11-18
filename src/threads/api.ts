import type { Cred } from './accounts';

const BASE = 'https://graph.threads.net/v1.0';

/** 平台有回應並明確拒絕（可判定「未發布」）。 */
export class ThreadsApiError extends Error {
  constructor(public status: number, public code: number | undefined, msg: string) { super(msg); }
  get tokenInvalid() { return this.status === 401 || this.code === 190; }
  /** 缺少權限（例如未授權 threads_manage_replies 卻嘗試串文） */
  get permission() { return this.code === 10 || this.code === 200 || /permission/i.test(this.message); }
}
/** Threads 還沒準備好剛建立的 container（剛建立就發布時偶爾會回「資源不存在」），稍等再發通常就會成功 */
export const notReady = (e: unknown) => e instanceof ThreadsApiError && (e.code === 24 || /does not exist|not (yet )?(ready|available)|try again/i.test(e.message));
/** 等待用的計時器；測試時換成不等待 */
export const timing = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

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
export async function createContainer(c: Cred, text: string, replyTo?: string, topicTag?: string): Promise<string> {
  const p: Record<string, string> = { media_type: 'TEXT', text, access_token: c.token };
  if (replyTo) p.reply_to_id = replyTo;
  if (topicTag) p.topic_tag = topicTag;
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

/** 帳號在一段時間內的瀏覽數（since/until 為 Unix 秒）。回傳 null 代表沒有權限。 */
export async function accountViews(c: Cred, since: number, until: number): Promise<number | null> {
  try {
    const r = await call(`${BASE}/${c.userId}/threads_insights?metric=views&since=${since}&until=${until}&access_token=${encodeURIComponent(c.token)}`, { method: 'GET' }, c.f);
    const d = (r.data ?? []).find((x: any) => x.name === 'views');
    if (!d) return 0;
    if (Array.isArray(d.values)) return d.values.reduce((n: number, v: any) => n + (Number(v.value) || 0), 0);
    return Number(d.total_value?.value) || 0;
  } catch (e) {
    if (e instanceof ThreadsApiError && e.permission) return null;
    throw e;
  }
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
