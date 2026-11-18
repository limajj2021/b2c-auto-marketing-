-- Threads 主題標籤（topic tag，每篇最多 1 個，只放在串文第 1 則）
-- brand_settings.topic_tag：品牌預設；posts.topic_tag：NULL＝用品牌預設，''＝這篇不加
ALTER TABLE brand_settings ADD COLUMN topic_tag TEXT NOT NULL DEFAULT '';
ALTER TABLE posts ADD COLUMN topic_tag TEXT;
