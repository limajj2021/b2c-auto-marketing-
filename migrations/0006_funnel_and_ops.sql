-- 導流漏斗：貼文中的 LINE 連結改經追蹤短連結（只記次數，不記是誰）
CREATE TABLE post_links (
  code TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  post_id INTEGER,
  account_id INTEGER,
  target_url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_post_links_post ON post_links(brand_id, post_id);

-- Threads 成效數據（每串貼文首則的瀏覽與互動），需 threads_manage_insights 權限
CREATE TABLE post_metrics (
  post_id INTEGER PRIMARY KEY,
  brand_id TEXT NOT NULL,
  views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, quotes INTEGER, shares INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_post_metrics_brand ON post_metrics(brand_id);
ALTER TABLE threads_accounts ADD COLUMN insights_status TEXT NOT NULL DEFAULT 'unknown'; -- ok | no_permission | unknown

-- 營運人員角色：admin 全部權限；support 只能查看狀態與協助重設客戶密碼
ALTER TABLE operators ADD COLUMN role TEXT NOT NULL DEFAULT 'admin';
