-- 同一位客戶可以有多個品牌：admin_users.brand_id 仍是「主要品牌」，其他可存取的品牌記在這裡
CREATE TABLE user_brands (
  user_id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','staff')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, brand_id)
);
CREATE INDEX idx_user_brands_brand ON user_brands(brand_id);
-- 登入時回到上次使用的品牌
ALTER TABLE admin_users ADD COLUMN last_brand_id TEXT;
