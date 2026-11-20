-- 登入只需帳號密碼：帳號在整個系統內不可重複（不分大小寫），系統用帳號直接找到所屬工作區
CREATE UNIQUE INDEX uq_admin_username_ci ON admin_users(lower(authentication_id));
