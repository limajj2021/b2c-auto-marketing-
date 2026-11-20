-- 貼文改用 LINE 官方短網址（lin.ee）：設定後 CTA 直接用它，不再經過系統的 /go 追蹤連結
ALTER TABLE brand_settings ADD COLUMN line_short_url TEXT NOT NULL DEFAULT '';
