-- 短連結：不重複點擊人數與每日每篇點擊（用來推估每篇帶來的好友數）
ALTER TABLE post_links ADD COLUMN uniques INTEGER NOT NULL DEFAULT 0;

-- 訪客去重：只存「網路位址＋裝置」經每日更換的密鑰雜湊後的代碼，無法還原，保留 2 天後刪除
CREATE TABLE link_visitors (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  vh TEXT NOT NULL,
  PRIMARY KEY (code, day, vh)
);

-- 每篇貼文每天的點擊次數與不重複人數（工作區時區）
CREATE TABLE link_daily (
  brand_id TEXT NOT NULL,
  post_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  uniques INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (brand_id, post_id, day)
);
