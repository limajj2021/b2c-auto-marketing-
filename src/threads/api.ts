import type { Env } from '../types';

const BASE = 'https://graph.threads.net/v1.0';

/** 平台有回應並明確拒絕（可判定「未發布」）。 */
export class ThreadsApiError extends Error {
  constructor(public status: number, public code: number | undefined, msg: string) { super(msg); }
  get tokenInvalid() { return this.status === 401 || this.code === 190; }
}
/** 請求送出後未取得回應（結果未知）。 */
export class ThreadsUnknownError extends Error {}

async function call(url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try { res = await fetch(url, init); } catch (e) { throw new ThreadsUnknownError(String((e as Error).message)); }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ThreadsApiError(res.status, body?.error?.code, body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/** 步驟 1：建立 media container（尚未公開） */
export async function createContainer(env: Env, text: string): Promise<string> {
  const r = await call(`${BASE}/${env.THREADS_USER_ID}/threads`,
    form({ media_type: 'TEXT', text, access_token: env.THREADS_ACCESS_TOKEN }));
  return r.id as string;
}

/** 步驟 2：發布 container，回傳平台貼文 ID */
export async function publishContainer(env: Env, creationId: string): Promise<string> {
  const r = await call(`${BASE}/${env.THREADS_USER_ID}/threads_publish`,
    form({ creation_id: creationId, access_token: env.THREADS_ACCESS_TOKEN }));
  return r.id as string;
}

/** 核對用：取得近期已發布貼文 */
export async function listRecent(env: Env, limit = 25): Promise<{ id: string; text?: string; timestamp?: string }[]> {
  const u = `${BASE}/${env.THREADS_USER_ID}/threads?fields=id,text,timestamp&limit=${limit}&access_token=${encodeURIComponent(env.THREADS_ACCESS_TOKEN)}`;
  const r = await call(u, { method: 'GET' });
  return r.data ?? [];
}
