-- 每家企業一個獨立 D1；brand_id 仍保留以符合 PRD 資料模型並防止誤混資料。
CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  created_at TEXT NOT NULL
);

CREATE TABLE brand_settings (
  brand_id TEXT PRIMARY KEY REFERENCES brands(id),
  services TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  content_tone TEXT NOT NULL DEFAULT '專業、親切、清楚',
  content_topics TEXT NOT NULL DEFAULT '[]',      -- JSON array
  banned_words TEXT NOT NULL DEFAULT '[]',        -- JSON array
  cta_text TEXT NOT NULL DEFAULT '',
  line_add_url TEXT NOT NULL DEFAULT '',
  posting_mode TEXT NOT NULL DEFAULT 'B' CHECK (posting_mode IN ('A','B','C')),
  require_review INTEGER NOT NULL DEFAULT 1,      -- Mode C 是否需審核
  posts_per_day INTEGER NOT NULL DEFAULT 1 CHECK (posts_per_day BETWEEN 1 AND 5),
  publishing_times TEXT NOT NULL DEFAULT '["10:00","14:00","18:00","20:00","21:30"]',
  weekly_topic TEXT NOT NULL DEFAULT '',
  auto_post_enabled INTEGER NOT NULL DEFAULT 0,
  line_auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
  daily_gen_limit INTEGER NOT NULL DEFAULT 10,
  monthly_token_limit INTEGER NOT NULL DEFAULT 300000,
  retention_days INTEGER NOT NULL DEFAULT 180,
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  line_config TEXT NOT NULL DEFAULT '{}',         -- JSON，空物件代表使用預設值
  threads_status TEXT NOT NULL DEFAULT 'ok',      -- ok | token_invalid
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ai_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                           -- ok | failed
  result TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gen_created ON ai_generations(brand_id, created_at);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  -- generating | gen_failed | draft | scheduled | publishing | published | unknown | failed | deleted
  status TEXT NOT NULL,
  slot_key TEXT,                                  -- 'YYYY-MM-DD#n'，防止同一時段重複產生
  scheduled_at TEXT,
  published_at TEXT,
  threads_post_id TEXT,
  threads_creation_id TEXT,                       -- 已建立 container 時保存，重試不重建
  generation_id INTEGER,
  approved_by TEXT,                               -- 'auto' 或管理員帳號
  attempts INTEGER NOT NULL DEFAULT 0,
  gen_attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_posts_slot ON posts(brand_id, slot_key) WHERE slot_key IS NOT NULL;
CREATE INDEX idx_posts_status ON posts(brand_id, status, scheduled_at);

CREATE TABLE faq_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  keyword TEXT NOT NULL,                          -- 多個關鍵字以逗號分隔
  response TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_faq ON faq_rules(brand_id, enabled, priority);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_contacts ON contacts(brand_id, line_user_id);

CREATE TABLE conversation_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  flow_state TEXT NOT NULL DEFAULT 'idle',        -- idle | form | human | delete_confirm
  current_step TEXT,
  form_data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_conv ON conversation_states(brand_id, contact_id);

CREATE TABLE inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  flow_id TEXT NOT NULL,                          -- 防重複提交
  service TEXT,
  answers TEXT NOT NULL,                          -- JSON
  handling_status TEXT NOT NULL DEFAULT 'pending' CHECK (handling_status IN ('pending','done')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_inquiry_flow ON inquiries(brand_id, flow_id);
CREATE INDEX idx_inquiry_list ON inquiries(brand_id, handling_status, created_at);

CREATE TABLE processed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT,
  processed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_events ON processed_events(brand_id, external_event_id);

CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  authentication_id TEXT NOT NULL,                -- 登入帳號
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX uq_admin ON admin_users(brand_id, authentication_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT,                                    -- 不寫入顧客內容
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit ON audit_logs(brand_id, action, created_at);
