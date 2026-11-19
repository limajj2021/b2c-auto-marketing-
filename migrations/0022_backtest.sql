-- Prompt 回測：同一個帳號、同一個套路，用新舊兩版 Prompt 各寫一篇，比較觸及預測分數。結果不進貼文池。
CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  account_id INTEGER,
  variant TEXT NOT NULL,          -- v2 | v3
  pattern TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | failed
  parts TEXT,
  tag TEXT,
  score TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX idx_backtest_pending ON backtest_runs(brand_id, status);
