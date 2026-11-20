-- 系統紀錄：串接、發文、排程與錯誤事件，供營運與客戶追蹤問題（不含顧客訊息內容與任何憑證），保留 30 天
CREATE TABLE event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_event_logs_time ON event_logs(created_at);
CREATE INDEX idx_event_logs_brand ON event_logs(brand_id, created_at);
