# Phase 0 真實服務驗證清單

> 所有項目必須以**授權的真實帳號**完成。自動化測試（模擬 fetch）不算通過。
> 完成後請在「結果」欄填入日期與證據（截圖／貼文 ID，不得貼 token）。

| # | 項目 | 做法 | 結果 |
|---|---|---|---|
| 1 | Threads 官方 API 發文 | Meta 開發者建立 App → 加入 Threads 產品與 `threads_basic`、`threads_content_publish` 權限 → 取得 user id 與長效 token → 設為 `THREADS_*` → 後台產生草稿、核准 → 等 Cron 發布 | ☐ |
| 2 | Threads 連結行為 | 發一則含 LINE 加好友網址的貼文，確認是否可點；不可點則改個人檔案連結 | ☐ |
| 3 | Threads 重啟後不重複 | 發布過程中重新部署，確認 `posts` 無重複、Threads 無重複貼文 | ☐ |
| 4 | LINE Webhook + Reply | Messaging API channel，Webhook URL 設為 `<管理網址>/line/webhook`，按 Verify，加好友收到歡迎訊息 | ☐ |
| 5 | LINE 真人接手衝突 | 在 OA Manager 以真人回覆，確認 Bot 不與之衝突（「聊天」與「Bot」模式設定） | ☐ |
| 6 | Gemini 免費額度 | 確認模型、RPM/日額度、商用條款、免費方案資料使用條件；後台「立即生成草稿」成功並寫入 `ai_generations` | 🟡 2026-11-08 經已部署的 Worker 呼叫 `/api/posts/generate` 成功（草稿、CTA、合規檢查、用量寫入）。`gemini-2.5-flash` 已對新用戶下架，預設改 `gemini-3.5-flash-lite`。**未驗證**：免費額度數字、商用／資料條款。key 曾貼入對話，須重發 |
| 7 | Workers 部署 | `npm run provision -- --brand <x>` 成功，`/api/health` 回 ok | ✅ 2026-11-08 首次對真實 Cloudflare 帳號執行成功；`/api/health` = ok（新 workers.dev 子網域約需數分鐘才有 TLS 憑證）。已用 API 自動建立子網域 |
| 8 | D1 讀寫 | 後台登入、改設定、LINE 留資後後台可見 | 🟡 登入、儀表板、草稿寫入／讀取已通過；LINE 留資後台可見尚未測 |
| 9 | Cron | 於 Cloudflare Dashboard 確認 `*/5` 觸發，開啟自動發文後有生成與發布 | 🟡 排程 `*/5 * * * *` 已建立（API 確認）；實際觸發與發布尚未測 |
| 10 | 免費額度 | 記錄 Workers 請求、D1 讀寫、Cron、CPU（登入 PBKDF2）實際用量是否在免費範圍 | ☐ |

## 已在本機驗證（非真實外部服務）

- 本機 workerd + 本機 D1：`wrangler d1 migrations apply --local` 成功；`/api/health` = `{"ok":true}`；無簽章的 LINE Webhook = 401；`/` 回傳後台頁。
- `npm test`：25 項單元／整合測試（簽章、去重、留資流程、人工接手、FAQ、排程不重複、未核准不發布、unknown 核對、token 失效、額度、權限、CSRF、稽核）。
