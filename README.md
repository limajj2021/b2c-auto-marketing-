# B2B Threads AI 獲客 × LINE 自動留資系統（MVP）

Threads AI 發文 → LINE 規則式接待 → 客戶留資 → 企業真人接手。
技術：Cloudflare Workers + D1 + Cron Triggers + Static Assets，TypeScript，Gemini（僅用於貼文生成）。
需求來源：PRD v3.0。每家企業獨立 Worker／D1／Secrets，共用同一份核心程式碼。

## ⚠️ 目前驗收狀態（請先讀）

| 項目 | 狀態 |
|---|---|
| 程式碼、Schema、後台、部署腳本 | ✅ 已實作 |
| 已部署到測試用 Cloudflare 帳號（Worker、D1、Cron、後台、隱私／條款頁） | ✅ 2026-11-08 實測 |
| Gemini 經 Worker 生成草稿並寫入用量 | ✅ 實測 |
| LINE 真實 Webhook：LINE 官方測試簽章通過、手機收到回覆 | ✅ 實測（完整留資流程與人工接手未走完） |
| 單元／整合測試（34 項，模擬外部 API） | ✅ 通過 |
| 本機 workerd + 本機 D1：遷移、`/api/health`、LINE 簽章拒絕、靜態頁 | ✅ 已驗證 |
| **Threads 一鍵授權與真實發文** | ❌ **未驗證**（按鈕與 callback 已寫好並有測試；待登記 Meta 跳轉網址後實測） |
| **LINE 真人接手與 OA 聊天模式衝突、Gemini 免費額度與條款** | ❌ **未驗證** |
| 第二企業部署、備份還原、交接演練 | ❌ 未執行 |

依 PRD 規則 22，模擬測試不等同真實 API 驗收。請依 [docs/PHASE0.md](docs/PHASE0.md) 逐項完成真實驗證後再進入客戶上線。

## 結構

```
src/index.ts            Worker 入口（fetch / scheduled）
src/ai/                 Gemini 生成（唯一呼叫 LLM 處）、內容合規檢查
src/threads/            官方 API 客戶端、排程／發布／核對
src/line/               Webhook、規則式流程、FAQ、留資（無 LLM）
src/admin/              後台 API、登入、角色權限、連線設定、帳號管理
src/integrations.ts     後台所設憑證（AES-GCM 加密存 D1，優先於 wrangler secret）
public/index.html       手機版後台（單檔，無建置步驟）；privacy/terms/data-deletion.html 為 Meta 審核所需頁面（通用範本，需法務檢視）
migrations/             D1 Schema
brands/*.json           各企業設定範本
scripts/provision.mjs   一鍵建立企業環境；scripts/backup.mjs 備份
tests/                  vitest
docs/                   PHASE0 / DEPLOY / HANDOVER
```

## 快速開始（本機）

```bash
npm install
cp .dev.vars.example .dev.vars        # 填入測試用金鑰
npm run db:migrate:local
npx wrangler d1 execute DB --local --command "INSERT INTO brands(id,name,created_at) VALUES('dev','Dev',datetime('now'));INSERT INTO brand_settings(brand_id) VALUES('dev')"
npm run dev                           # http://localhost:8787
npm test && npm run typecheck
```

## 一鍵部署企業環境

```bash
cp brands/example.json brands/acme.json     # 編輯品牌、LINE 加好友網址等
# 於 .secrets/acme.env 放入 LINE_*、THREADS_*、GEMINI_API_KEY（可先缺，之後補上重跑）
npx wrangler login
npm run provision -- --brand acme --dry-run   # 先看計畫
npm run provision -- --brand acme
```
詳見 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 重要設計決定

- **防重複發文**：`posts.slot_key` 唯一約束 + 原子狀態搶佔（`scheduled→publishing`）+ 保存 `creation_id` 重用；請求結果不明時標記 `unknown`，先向 Threads 列表核對文字再決定是否重試。
- **LINE 去重**：`processed_events(brand_id, webhookEventId)` 唯一；處理失敗會釋放佔位以便重送；留資另以 `flow_id` 唯一防重複提交。
- **受監管產業（`industry = lending/finance/loan`）**：不論模式一律走人工審核；利率／案例等數字內容被合規檢查擋下，須人工撰寫。通過檢查不代表合法，仍需法遵確認。
- **合規檢查未通過的草稿不能核准**（API 422），需先修改。
- **額度**：每日生成次數、每月 Token 上限；超額即停止生成、保留草稿，不會自動升級付費。
- **後台安全**：PBKDF2 密碼、簽章 Session（8 小時）、每次請求回查帳號啟用、伺服器端角色檢查、`SameSite=Strict` + 自訂標頭防 CSRF、登入失敗 5 次鎖 15 分鐘、設定變更寫入 `audit_logs`。客服角色看不到 LINE User ID。
- **隱私**：留資前告知並需輸入「同意」；偵測身分證／卡號樣式拒收；顧客可自行「查詢／刪除我的資料」；`retention_days` 到期由 Cron 清除。

## 已知限制與最小替代方案

1. **LINE「互動式選單」以快速回覆按鈕實作**，未建立 Rich Menu（需另行呼叫 Rich Menu API 與圖片）。可在 OA Manager 手動設定 Rich Menu，按鈕文字設為與選單名稱相同的訊息即可。
2. **Threads 連結呈現未測**（PRD 7.2 要求先測）。若貼文內網址不可點，改放個人檔案連結。
3. Threads 長效 token（約 60 天）由 Cron 在到期前 10 天自動續期（有單元測試，**未對真實 Threads 驗證**）；續期失敗且已過期時，後台首頁會警示並暫停發布。
4. **真人接手**：Webhook 端靜默 24 小時或顧客輸入「選單」。同一 OA 的聊天模式與 Bot 模式並行行為須實測（PRD 4.5）。
5. 發文時段以 UTC 儲存；後台歷史以 UTC 顯示。
6. 無 CSV 匯出、無表單進度恢復（P1）。
7. `provision.mjs` 解析 `wrangler d1 list --json` 欄位（`uuid`/`id`），不同 wrangler 版本輸出若不同需微調。
8. Cloudflare 免費方案 Worker CPU 時間有限；PBKDF2 登入（100k 次）在免費方案是否穩定需實測。
