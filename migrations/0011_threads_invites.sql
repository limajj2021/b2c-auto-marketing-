-- Threads 測試邀請進度：App 在開發模式時，每個要授權的 Threads 帳號都要先被加為測試人員並接受邀請
-- requested（客戶已提出）→ invited（服務商已在 Meta 送出邀請）→ accepted（客戶已接受，可授權）→ connected（已連結）
CREATE TABLE threads_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id TEXT NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  requested_by TEXT,
  authorize_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_threads_invite ON threads_invites(brand_id, lower(username));
CREATE INDEX idx_threads_invite_status ON threads_invites(status);
