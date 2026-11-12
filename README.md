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
| Threads 一鍵授權與真實發文 | ✅ 2026-11-10 實測（測試人員模式；token 自動續期尚未實際到期驗證） |
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

## 部署模式（2026-11-11 起）

| 模式 | 適用 | 設定 |
|---|---|---|
| **共用架構（標準版，預設）** | 一般客戶。由你統一託管，一次更新全部生效 | `brands/<platform>.json` 設 `"multiTenant": true`；客戶在營運總後台開通 |
| **獨立部署（企業專屬版）** | 有法遵或資安要求、願意付較高費用的客戶 | 每家一份 `brands/*.json`，不設 `multiTenant` |

共用架構的重點：
- 所有資料以 `brand_id` 隔離；每個請求先解析出工作區，未解析出工作區時拒絕讀寫（`src/db.ts`）。有 7 項跨工作區隔離測試（`tests/tenancy.test.ts`）。
- 客戶以「工作區代號」登入（`/?w=代號` 會自動帶入）。LINE Webhook 為 `/line/webhook/<代號>`；Threads 授權回呼只有一個固定網址 `/threads/callback`。
- LINE、Threads 憑證一律來自各工作區自己的設定，不會沿用平台層 secret；Gemini 可用平台金鑰或客戶自有金鑰。
- 營運總後台 `/ops.html`：所有工作區的健康狀態、本月留資／發文／AI 用量、開通、暫停、重設管理員密碼、下載計費用量 CSV。營運人員看不到顧客留資內容。
- 排程每 5 分鐘輪替處理工作區（`CRON_BATCH`，預設 25），單一工作區出錯不影響其他工作區。
- 客戶可在「設定 → 匯出我的資料」隨時下載全部資料。
- **留資為加購項目（預設關閉）**：由營運總後台逐一開通。未開通時 LINE 選單沒有「立即詢問」、不蒐集顧客填寫的資料、伺服器拒絕留資 API；改以不含個資的「新好友數」「轉真人次數」（`metrics_daily`）作為成效依據。

## 導流成效（公域 → 私域）

產品主打「免廣告費提升曝光與轉換」，因此系統量測整條導流漏斗（全部為計數，不含個資）：

| 階段 | 來源 | 需要 |
|---|---|---|
| 曝光、互動 | Threads 官方成效數據（每串首則，發布後 14 天內每 6 小時更新） | Meta App 加入 `threads_manage_insights` 並重新連結 |
| 點擊 LINE 連結 | 發布時把 LINE 連結換成追蹤短連結 `/go/<代碼>`，只計次數、排除平台預覽爬蟲 | 設定 `PUBLIC_BASE_URL` |
| 新好友、轉真人 | LINE Webhook 的加好友事件與轉真人次數（`metrics_daily`） | 無 |

後台首頁顯示近 30 天漏斗；「設定 → 成效報告」為每月報告，可列印或另存 PDF；營運總後台與計費 CSV 也包含這些數字。

## 排程用量保護

Cloudflare 對每次執行的對外請求有上限（免費方案 50 次，資料庫查詢也算在內）。排程期間所有資料庫查詢與對外呼叫都會被計數（`src/budget.ts`，上限 `CRON_SUBREQUEST_LIMIT`，預設 45）；額度不足時不會開始發一串貼文，剩下的工作留到下一輪，順序為：核對 → 發布 → 生成 → 成效數據。同一工作區同一輪的品牌與設定只查一次；每個工作區各自每小時清理一次。改用 Workers 付費方案後，可把上限調到 5000。

## 營運人員

營運總後台有兩種角色：**營運管理者**（全部權限）與**維護人員**（查看狀態、協助客戶重設密碼）。管理者可在總後台新增、停用人員與重設其密碼；每人可自行變更密碼。

## 矩陣帳號與串文（2026-11-10 新增）

- 一個企業可連結多個 Threads 帳號（`threads_accounts`），每個帳號有自己的人設、語氣、主題、發文時段；未設定的項目沿用品牌預設，共用預設時段時自動錯開 20 分鐘。
- 貼文為串文（`posts.parts`），第一則鉤子、最後一則 CTA；以 `reply_to_id` 回覆上一則串起來，逐則記錄已發出的 ID（`posts.part_ids`），中斷後只補發剩下的。需要 Meta 權限 `threads_manage_replies`。
- 「改寫分發」：以其他帳號的人設改寫同一串，建立草稿並錯開 45 分鐘。
- 內容策略（品牌層級）：寫作原則（預設「爭議化、數據化、具體化」）、每串則數、可引用數據。AI 不得自行編造數字，缺數據時留下【待補數據】，補上前無法核准。
- 舊版單帳號資料會在第一次讀取時自動搬入帳號表。

## 重要設計決定

- **防重複發文**：`posts.slot_key` 唯一約束 + 原子狀態搶佔（`scheduled→publishing`）+ 保存 `creation_id` 重用；請求結果不明時標記 `unknown`，先向 Threads 列表核對文字再決定是否重試。
- **LINE 去重**：`processed_events(brand_id, webhookEventId)` 唯一；尚未寫入狀態前失敗才釋放佔位讓 LINE 重送，已寫入（例如只是回覆失敗）則不重送，避免重複處理；留資另以 `flow_id` 唯一防重複提交。
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
