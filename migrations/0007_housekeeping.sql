-- 每個工作區各自記錄上次清理時間（過期留資、去重紀錄、卡住的生成），每小時一次
ALTER TABLE brands ADD COLUMN last_housekeeping_at TEXT;
