-- 矩陣帳號：一個企業可連多個 Threads 帳號，各自人設與排程（NULL 代表沿用品牌預設）
CREATE TABLE threads_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  threads_user_id TEXT NOT NULL,
  username TEXT,
  token_enc TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',          -- ok | token_invalid
  persona TEXT NOT NULL DEFAULT '',           -- 人設
  tone TEXT,
  topics TEXT,                                -- JSON array
  posts_per_day INTEGER,
  publishing_times TEXT,                      -- JSON array
  cta_text TEXT,
  auto_post_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_threads_accounts ON threads_accounts(brand_id, threads_user_id);

-- 串文：parts 為各則內文（JSON array）；part_ids 為已發布的各則 ID，用於中斷後續發而不重複
ALTER TABLE posts ADD COLUMN account_id INTEGER;
ALTER TABLE posts ADD COLUMN parts TEXT;
ALTER TABLE posts ADD COLUMN part_ids TEXT;
ALTER TABLE posts ADD COLUMN source_post_id INTEGER;
CREATE INDEX idx_posts_account ON posts(brand_id, account_id, status);

-- 內容策略：爆文風格、串文則數、可引用的真實數據
ALTER TABLE brand_settings ADD COLUMN style_preset TEXT NOT NULL DEFAULT '爭議化、數據化、具體化';
ALTER TABLE brand_settings ADD COLUMN thread_min INTEGER NOT NULL DEFAULT 4;
ALTER TABLE brand_settings ADD COLUMN thread_max INTEGER NOT NULL DEFAULT 7;
ALTER TABLE brand_settings ADD COLUMN fact_bank TEXT NOT NULL DEFAULT '';
