# 部署、備份與還原

## 前置（企業／開發者先備妥）

- Cloudflare 帳號（企業專屬，或交接用專屬帳號）。
- LINE Messaging API channel：Channel Secret、Channel Access Token。
- Meta Threads App：`THREADS_USER_ID`、長效 `THREADS_ACCESS_TOKEN`。
- Gemini API key（確認免費額度與條款，見 PHASE0）。
- 企業 LINE 加好友網址（`https://line.me/R/ti/p/@xxxx`）。

## 部署新企業

1. `cp brands/example.json brands/<brand>.json` 並編輯（受監管業務可參考 `brands/example-lending.json`；`industry: "lending"` 會強制人工審核）。
2. 建立 `.secrets/<brand>.env`：
   ```
   LINE_CHANNEL_SECRET=...
   LINE_CHANNEL_ACCESS_TOKEN=...
   THREADS_USER_ID=...
   THREADS_ACCESS_TOKEN=...
   GEMINI_API_KEY=...
   ```
   缺少的可稍後補上再重跑；`SESSION_SECRET` 會自動產生。此檔已被 `.gitignore`，腳本不會輸出其值。
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
