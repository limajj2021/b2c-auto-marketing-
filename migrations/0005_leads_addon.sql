-- 留資改為加購項目：預設關閉；未開通時不蒐集顧客填寫的任何資料
ALTER TABLE brand_settings ADD COLUMN leads_enabled INTEGER NOT NULL DEFAULT 0;

-- 不含個資的每日計數（新好友、轉真人等），作為成效與計費依據
CREATE TABLE metrics_daily (
  brand_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- 工作區時區的 YYYY-MM-DD
  name TEXT NOT NULL,         -- friend_add | handoff
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, day, name)
);
