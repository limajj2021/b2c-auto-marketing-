-- 每個 Threads 帳號每天的曝光（瀏覽數），來自 Threads 帳號成效 API（需 threads_manage_insights）
CREATE TABLE account_daily (
  account_id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- 工作區時區的 YYYY-MM-DD
  views INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);
CREATE INDEX idx_account_daily_brand ON account_daily(brand_id, day);
