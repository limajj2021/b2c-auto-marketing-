# 部署、備份與還原

## 前置（企業／開發者先備妥）

- Cloudflare 帳號（企業專屬，或交接用專屬帳號）。
- LINE Messaging API channel：Channel Secret、Channel Access Token。
- Meta Threads App：`THREADS_USER_ID`、長效 `THREADS_ACCESS_TOKEN`。
- Gemini API key（確認免費額度與條款，見 PHASE0）。
- 企業 LINE 加好友網址（`https://line.me/R/ti/p/@xxxx`）。

## 共用架構（標準版）：部署一次、之後在總後台開通客戶

1. 建立 `brands/platform.json`（可複製 example.json），加上 `"multiTenant": true`、`"slug": "<第一個工作區代號>"`、`"threadsAppId": "<Threads App ID>"`。
2. `npm run provision -- --brand platform`（之後更新程式也是同一個指令，所有工作區一起生效）。
3. 建立營運帳號：`node scripts/create-operator.mjs --config .generated/wrangler.platform.toml --username ops`（密碼只顯示一次）。
4. 打開 `<部署網址>/ops.html` →「開通新工作區」→ 把登入網址（含 `?w=代號`）與一次性密碼交給客戶。
5. 客戶登入後依首頁「開通進度」貼上 LINE 憑證（系統自動把 Webhook 設為 `/line/webhook/<代號>`）、AI 金鑰、連結 Threads。
6. Meta 只需登記一次回呼網址：`<部署網址>/threads/callback`。

> 規模提醒：Cloudflare 免費方案每次執行的對外請求數有限，工作區變多時請改用 Workers 付費方案，並視需要調整 `CRON_BATCH`。

## Threads「一鍵連結」前置（開發者一次性）

所有客戶共用同一個 Meta App（由開發者持有）：
1. Meta for Developers 建立 App，加入 Threads 使用案例，權限 `threads_basic`、`threads_content_publish`、`threads_manage_replies`（串文需要）。
2. 在 Threads 設定登記 **重新導向回呼網址**：`https://<管理網址>/threads/callback`；解除安裝與刪除回呼網址分別為 `https://<管理網址>/threads/deauthorize`、`https://<管理網址>/threads/delete`。
3. 基本資料填入隱私政策 `https://<管理網址>/privacy`、服務條款 `/terms`、資料刪除說明 `/data-deletion`。
4. 把 Threads App ID 寫進 `brands/<brand>.json` 的 `threadsAppId`，App secret 放 `.secrets/<brand>.env` 的 `THREADS_APP_SECRET`。
5. 審核通過前，客戶的 Threads 帳號須先在 App 角色中加為 Threads 測試人員並接受邀請，才能按後台「連結 Threads」。
> 每家客戶的管理網址不同，目前每個客戶網址都需在 Meta 登記回呼網址；客戶多時建議改用固定中繼網域（待實作）。

## 部署新企業

1. `cp brands/example.json brands/<brand>.json` 並編輯（受監管業務可參考 `brands/example-lending.json`；`industry: "lending"` 會強制人工審核）。
2. （選填）建立 `.secrets/<brand>.env`。LINE／Gemini／Threads 憑證**可部署後在後台「設定 → 連線」填入**（加密存入資料庫），此檔僅作後備：
   ```
   LINE_CHANNEL_SECRET=...
   LINE_CHANNEL_ACCESS_TOKEN=...
   THREADS_USER_ID=...
   THREADS_ACCESS_TOKEN=...
   GEMINI_API_KEY=...
   ```
   `SESSION_SECRET`、`CRED_ENC_KEY` 首次部署自動產生，重跑**不會覆蓋**。**切勿更換 `CRED_ENC_KEY`，否則已加密的憑證無法解開。**此檔已被 `.gitignore`，腳本不會輸出其值。
3. `npx wrangler login`（或使用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）。
4. `npm run provision -- --brand <brand>`。腳本是冪等的：重跑只會補齊資源與 Secrets，不會重設既有管理員密碼。
5. 記下輸出的管理網址與一次性管理員密碼，登入後立即於後台變更。
6. 在 LINE Developers 設定 Webhook URL（`<管理網址>/line/webhook`）並開啟 Use webhook、關閉內建自動回應。
7. 第二家企業：複製另一份 `brands/*.json`，使用不同 `workerName`／`d1Name`（建議不同 Cloudflare 帳號）。

## 資料庫更新

新增 `migrations/000N_*.sql`，再執行 `npx wrangler d1 migrations apply DB --remote --config .generated/wrangler.<brand>.toml`（或重跑 provision）。

## 備份與還原

```bash
npm run backup -- --config .generated/wrangler.<brand>.toml     # → backups/backup-*.sql（含個資，請加密）
# 還原到「新的空 D1」：先 migrations apply 建 schema 不可重複建表，因此建議還原前使用全新 D1：
npx wrangler d1 execute DB --remote --config <toml> --file backups/<file>.sql
```
`d1 export` 的 SQL 已含建表語句，還原時請使用**尚未套用遷移的空資料庫**。
備份／還原需於測試環境實際演練一次後才算驗收（PRD 10.3）。

## 停用企業

`npx wrangler delete --config .generated/wrangler.<brand>.toml` 停止 Worker 與 Cron；資料庫保留。
快速暫停：後台首頁關閉「自動發文」與「自動接待」。

## 移除憑證

- 更新 Secret：`npx wrangler secret put <NAME> --config <toml>`。
- Threads 憑證失效：後台首頁會顯示警示；更新 `THREADS_ACCESS_TOKEN` 後執行
  `UPDATE brand_settings SET threads_status='ok'`（`wrangler d1 execute`）。


## 自訂網域（2026-11-14）

正式網址：`https://login.ego-office.org`（`brands/app.json` 的 `customDomain`，provision 會寫成 `routes = [{ pattern, custom_domain = true }]`）。
網域必須在同一個 Cloudflare 帳號且由 Cloudflare 管理 DNS；部署時 Cloudflare 會自動建立 DNS 紀錄與憑證。
`workers_dev = true` 保留舊網址 `app.vucamade.workers.dev`，已發出的貼文短連結、LINE Webhook 與 Meta 舊設定照常可用。

改用新網址後需要在 Meta App 加上（舊網址可先保留）：
- 重新導向回呼：`https://login.ego-office.org/threads/callback`
- 解除安裝／刪除回呼：`/threads/deauthorize`、`/threads/delete`
- 應用程式網域、隱私政策、服務條款、資料刪除網址
