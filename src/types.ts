export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Secrets（以 wrangler secret 保存，不得出現在前端或日誌）
  SESSION_SECRET: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  THREADS_ACCESS_TOKEN: string;
  THREADS_USER_ID: string;
  GEMINI_API_KEY: string;
  // 非機密變數
  GEMINI_MODEL?: string;
  // 加密憑證用金鑰（缺少時退回 SESSION_SECRET）；Threads App 為所有客戶共用的 Meta App
  CRED_ENC_KEY?: string;
  THREADS_APP_ID?: string;
  THREADS_APP_SECRET?: string;
}

export interface Brand {
  id: string;
  name: string;
  industry: string;
  description: string;
  timezone: string;
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
}

/** 受監管產業：一律強制人工審核，不得自動發布。 */
export const REGULATED_INDUSTRIES = ['lending', 'finance', 'loan'];
