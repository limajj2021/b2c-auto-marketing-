-- 授權保護：Threads 帳號與各項串接憑證被刪除或換掉時，舊的那一份自動封存，不會真的消失。
-- 由資料庫觸發器執行，不靠程式碼記得做；之後改版、誤按中斷或程式錯誤都能還原。
-- ⚠️ 這兩張封存表與觸發器不可刪除、不可清空（見 CLAUDE.md「受保護的資料」）。

CREATE TABLE threads_accounts_archive (
  archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,              -- deleted | token_replaced
  id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  threads_user_id TEXT NOT NULL,
  username TEXT,
  token_enc TEXT NOT NULL,
  expires_at TEXT,
  status TEXT,
  persona TEXT,
  tone TEXT,
  topics TEXT,
  posts_per_day INTEGER,
  publishing_times TEXT,
  cta_text TEXT,
  auto_post_enabled INTEGER,
  insights_status TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT NOT NULL
);
CREATE INDEX idx_threads_accounts_archive ON threads_accounts_archive(brand_id, threads_user_id);

CREATE TRIGGER trg_threads_accounts_archive_delete BEFORE DELETE ON threads_accounts
BEGIN
  INSERT INTO threads_accounts_archive(reason,id,brand_id,threads_user_id,username,token_enc,expires_at,status,persona,tone,topics,posts_per_day,publishing_times,cta_text,auto_post_enabled,insights_status,created_at,updated_at,archived_at)
  VALUES('deleted',OLD.id,OLD.brand_id,OLD.threads_user_id,OLD.username,OLD.token_enc,OLD.expires_at,OLD.status,OLD.persona,OLD.tone,OLD.topics,OLD.posts_per_day,OLD.publishing_times,OLD.cta_text,OLD.auto_post_enabled,OLD.insights_status,OLD.created_at,OLD.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER trg_threads_accounts_archive_token BEFORE UPDATE OF token_enc ON threads_accounts
WHEN OLD.token_enc IS NOT NEW.token_enc
BEGIN
  INSERT INTO threads_accounts_archive(reason,id,brand_id,threads_user_id,username,token_enc,expires_at,status,persona,tone,topics,posts_per_day,publishing_times,cta_text,auto_post_enabled,insights_status,created_at,updated_at,archived_at)
  VALUES('token_replaced',OLD.id,OLD.brand_id,OLD.threads_user_id,OLD.username,OLD.token_enc,OLD.expires_at,OLD.status,OLD.persona,OLD.tone,OLD.topics,OLD.posts_per_day,OLD.publishing_times,OLD.cta_text,OLD.auto_post_enabled,OLD.insights_status,OLD.created_at,OLD.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TABLE integrations_archive (
  archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,              -- deleted | replaced
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  meta TEXT,
  updated_at TEXT,
  archived_at TEXT NOT NULL
);
CREATE INDEX idx_integrations_archive ON integrations_archive(brand_id, name);

CREATE TRIGGER trg_integrations_archive_delete BEFORE DELETE ON integrations
BEGIN
  INSERT INTO integrations_archive(reason,brand_id,name,value_enc,meta,updated_at,archived_at)
  VALUES('deleted',OLD.brand_id,OLD.name,OLD.value_enc,OLD.meta,OLD.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER trg_integrations_archive_update BEFORE UPDATE OF value_enc ON integrations
WHEN OLD.value_enc IS NOT NEW.value_enc
BEGIN
  INSERT INTO integrations_archive(reason,brand_id,name,value_enc,meta,updated_at,archived_at)
  VALUES('replaced',OLD.brand_id,OLD.name,OLD.value_enc,OLD.meta,OLD.updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
