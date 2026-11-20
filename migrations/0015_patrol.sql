-- 半自動海巡：關鍵字 → 固定回覆範本；使用紀錄避免同一篇貼文重複回覆
CREATE TABLE patrol_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '[]',   -- JSON array；別人的貼文含任一關鍵字就推薦這個範本
  reply TEXT NOT NULL,                   -- 可用 {LINE}（加好友連結）、{品牌}
  enabled INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_patrol_tpl ON patrol_templates(brand_id, enabled);

CREATE TABLE patrol_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  shortcode TEXT NOT NULL,               -- Threads 貼文代碼（網址 /post/ 後面那段）
  author TEXT NOT NULL DEFAULT '',
  template_id INTEGER,
  replied_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_patrol_log ON patrol_log(brand_id, shortcode);
