-- 共用架構：一個資料庫服務多個工作區（企業），所有資料以 brand_id 隔離
ALTER TABLE brands ADD COLUMN slug TEXT;                 -- 工作區代號，登入與 LINE Webhook 網址使用
UPDATE brands SET slug = id WHERE slug IS NULL;
CREATE UNIQUE INDEX uq_brands_slug ON brands(slug);
ALTER TABLE brands ADD COLUMN status TEXT NOT NULL DEFAULT 'active';   -- active | suspended
ALTER TABLE brands ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE brands ADD COLUMN last_cron_at TEXT;        -- 排程輪替用，避免單一工作區佔滿資源
CREATE INDEX idx_admin_users_brand ON admin_users(brand_id);
CREATE INDEX idx_integrations_brand ON integrations(brand_id);
CREATE INDEX idx_threads_accounts_brand ON threads_accounts(brand_id);

-- 營運人員（你與維護人員）：跨工作區管理，但看不到顧客個資內容
CREATE TABLE operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
