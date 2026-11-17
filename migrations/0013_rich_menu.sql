-- LINE 圖文選單：記住上次發布的設定與選單編號，方便再次編輯
ALTER TABLE brand_settings ADD COLUMN rich_menu TEXT NOT NULL DEFAULT '{}';
