-- 連線憑證（LINE / Threads / Gemini）以 AES-GCM 加密後存放，後台可直接設定，不必碰 wrangler secret。
CREATE TABLE integrations (
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',   -- 非機密資訊：帳號名稱、到期時間等
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brand_id, name)
);
