-- AI 連接器（MCP）：讓客戶在自己的 ChatGPT / Codex / Claude 裡用對話寫貼文、存草稿
-- OAuth 2.1：動態註冊的用戶端、一次性授權碼、通行證（只存雜湊，不存原文）
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- access | refresh | personal（Codex 用的連線金鑰）
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL,
  brand_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX idx_oauth_tokens_owner ON oauth_tokens(brand_id, user_id, revoked);
