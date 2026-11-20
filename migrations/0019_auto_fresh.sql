-- 全自動發文：開啟後每個帳號每天 1 篇，AI 先讀過去的貼文，挑一個沒寫過的題材或觀點，寫完直接排程發布
ALTER TABLE brand_settings ADD COLUMN auto_fresh_enabled INTEGER NOT NULL DEFAULT 0;
-- 這篇的題材與核心觀點（全自動發文用來避免重複）
ALTER TABLE posts ADD COLUMN idea TEXT;
