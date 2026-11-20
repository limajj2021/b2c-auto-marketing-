// 系統紀錄（event_logs）：記錄串接、發文、排程與錯誤，讓營運與客戶看得到問題出在哪一步。
// 原則：不記顧客訊息內容、LINE User ID、任何憑證；寫入失敗不影響主流程。
import type { Env } from './types';
import { iso } from './util/time';

export type Level = 'info' | 'warn' | 'error';
export const LOG_RETENTION_DAYS = 30;

/** 來源代碼 → 中文名稱（前端共用同一份對照） */
export const SOURCES: Record<string, string> = {
  threads_oauth: 'Threads 授權', threads_publish: 'Threads 發文', threads_generate: 'AI 生成', threads_token: 'Threads 憑證',
  threads_insights: 'Threads 成效數據', threads_reconcile: '發文核對', line_webhook: 'LINE 接收訊息', line_connect: 'LINE 串接',
  line_token: 'LINE 憑證', line_insights: 'LINE 好友數', cron: '排程', system: '系統',
};

/** 去除可能夾帶的憑證（網址參數、Bearer） */
export function redact(s: string): string {
  return s
    .replace(/((?:access_token|client_secret|refresh_token|code|token|key)=)[^&\s"']+/gi, '$1***')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***');
}

export async function logEvent(
  env: Env, brandId: string | null, level: Level, source: string, message: string,
  detail?: Record<string, unknown>, opts: { throttleMinutes?: number } = {},
): Promise<void> {
  const msg = redact(String(message)).slice(0, 500);
  const det = detail ? redact(JSON.stringify(detail)).slice(0, 2000) : null;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${source}]`, brandId ?? '-', msg);
  try {
    if (opts.throttleMinutes) {
      // 容易被大量觸發的事件（例如簽章錯誤）同一工作區同一類一段時間內只記一筆
      const since = new Date(Date.now() - opts.throttleMinutes * 60000).toISOString();
      const dup = await env.DB.prepare('SELECT 1 FROM event_logs WHERE COALESCE(brand_id,\'\')=? AND source=? AND message=? AND created_at>? LIMIT 1')
        .bind(brandId ?? '', source, msg, since).first();
      if (dup) return;
    }
    await env.DB.prepare('INSERT INTO event_logs(brand_id,level,source,message,detail,created_at) VALUES(?,?,?,?,?,?)')
      .bind(brandId, level, source, msg, det, iso()).run();
  } catch { /* 紀錄失敗不影響主流程（包含排程額度用完） */ }
}

export async function pruneLogs(env: Env, now = new Date()): Promise<void> {
  await env.DB.prepare('DELETE FROM event_logs WHERE created_at<?').bind(new Date(now.getTime() - LOG_RETENTION_DAYS * 86400000).toISOString()).run();
}
