export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Secrets（以 wrangler secret 保存，不得出現在前端或日誌）
  SESSION_SECRET: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** 有值時 access token 由系統以 Channel ID + secret 自動申請與更新 */
  LINE_CHANNEL_ID?: string;
  /** 系統自動申請的 LINE token 到期時間（withCreds 載入；空字串代表未知） */
  LINE_TOKEN_AUTO_EXPIRES?: string;
  THREADS_ACCESS_TOKEN: string;
  THREADS_USER_ID: string;
  GEMINI_API_KEY: string;
  // 非機密變數
  GEMINI_MODEL?: string;
  // 加密憑證用金鑰（缺少時退回 SESSION_SECRET）；Threads App 為所有客戶共用的 Meta App
  CRED_ENC_KEY?: string;
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
  /** 覆寫向 Meta 要求的權限（逗號分隔）；Meta App 尚未加入某權限時可暫時移除 */
  THREADS_SCOPES?: string;
  /** "1" = 共用架構（多工作區）；未設定 = 單一企業獨立部署 */
  MULTI_TENANT?: string;
  /** 每次排程最多處理幾個工作區（輪替），預設 25 */
  CRON_BATCH?: string;
  /** 由請求解析出的工作區；只在程式內部設定 */
  BRAND_ID?: string;
  /** 對外網址（例如 https://xxx.workers.dev），用來產生貼文追蹤短連結 */
  PUBLIC_BASE_URL?: string;
  /** 每次排程最多使用的請求數（含資料庫查詢）。免費方案建議 45，付費方案可設 5000 */
  CRON_SUBREQUEST_LIMIT?: string;
  /** 排程期間由 budget.ts 注入 */
  SUBFETCH?: typeof fetch;
  BUDGET?: import('./budget').Budget;
  /** 排程額度用完時仍可用於收尾寫入的資料庫（不計數）；只在 budget.ts 設定 */
  DB_RESERVE?: D1Database;
  /** 排程期間每個工作區一份的讀取快取（品牌、設定），減少重複查詢 */
  MEMO?: Map<string, unknown>;
}

export interface Brand {
  id: string;
  slug?: string;
  status?: string;
  name: string;
  industry: string;
  description: string;
  timezone: string;
  last_housekeeping_at?: string | null;
}

export interface Settings {
  brand_id: string;
  services: string;
  audience: string;
  content_tone: string;
  content_topics: string;
  banned_words: string;
  cta_text: string;
  line_add_url: string;
  posting_mode: 'A' | 'B' | 'C';
  require_review: number;
  posts_per_day: number;
  publishing_times: string;
  weekly_topic: string;
  auto_post_enabled: number;
  line_auto_reply_enabled: number;
  daily_gen_limit: number;
  monthly_token_limit: number;
  retention_days: number;
  prompt_version: string;
  line_config: string;
  threads_status: string;
  style_preset: string;
  thread_min: number;
  thread_max: number;
  fact_bank: string;
  leads_enabled: number;
}

export interface Post {
  id: number;
  brand_id: string;
  content: string;
  status: string;
  slot_key: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  threads_post_id: string | null;
  threads_creation_id: string | null;
  generation_id: number | null;
  approved_by: string | null;
  attempts: number;
  gen_attempts: number;
  error_message: string | null;
  account_id: number | null;
  parts: string | null;
  part_ids: string | null;
  source_post_id: number | null;
}

/** 受監管產業：一律強制人工審核，不得自動發布。 */
export const REGULATED_INDUSTRIES = ['lending', 'finance', 'loan'];
