-- 新文章標示：AI 生成或 AI 連接器存進來的貼文在後台標「NEW」，有人點開看過後就不再標示
ALTER TABLE posts ADD COLUMN seen_at TEXT;
-- 既有的貼文都算看過，只有之後新產生的才標 NEW
UPDATE posts SET seen_at = COALESCE(updated_at, created_at);
