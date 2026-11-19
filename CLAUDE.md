# 開發守則（給之後改這個專案的人與 AI）

正式環境：https://login.ego-office.org（Cloudflare Workers + D1）。客戶的 Threads 授權、LINE 憑證都在正式資料庫裡，
**重新授權要請客戶本人一個一個操作，很麻煩，任何改版都不可以讓它們消失或失效。**

## 受保護的資料（不可刪、不可清空、不可改結構）

| 資料 | 內容 | 遺失的後果 |
|---|---|---|
| `threads_accounts` | 每個 Threads 帳號的授權（`token_enc`）、人設、發文設定 | 客戶要重新授權 |
| `integrations` | LINE、Gemini 等串接憑證（`value_enc`） | 要重新設定串接 |
| `threads_accounts_archive`、`integrations_archive` | 上面兩張表被刪除或換掉時的自動封存 | 失去還原能力 |
| `post_links` | 已發布貼文裡的追蹤短連結 | 已發出的貼文連結全部失效 |
| `oauth_clients`、`oauth_tokens` | 客戶 ChatGPT／Codex 連接器的授權 | 客戶要重新連接 |
| Cloudflare secret `CRED_ENC_KEY`（沒有時用 `SESSION_SECRET`） | 所有授權與憑證的加密金鑰 | **所有授權一次全部失效** |

### 規則
1. **新的 migration 不可以** `DROP TABLE`、`DELETE FROM`、`ALTER TABLE ... RENAME` 上面任何一張表，不可以改寫 `token_enc`／`value_enc`，不可以 `DROP TRIGGER`。
   `tests/protection.test.ts` 會檢查，違反就測試失敗。要加欄位用 `ALTER TABLE ... ADD COLUMN`。
2. **程式碼裡只有指定的函式可以刪除授權**：`removeAccounts`（src/threads/accounts.ts）與 `deleteCreds`（src/integrations.ts）。測試同樣會檢查。
3. **不可以更換或刪除 `CRED_ENC_KEY`、`SESSION_SECRET`、`THREADS_APP_SECRET`**。`wrangler secret put` 這幾個之前一定要先問負責人。
4. **不要在 Meta App 更換 App ID**，所有授權都綁在現在這個 App 上。
5. 部署只用 `npx wrangler deploy -c .generated/wrangler.app.toml`，不要刪掉重建 Worker 或 D1。
6. 授權過期或權限不足時用「重新連結」，它會就地更新 token，設定與歷史都保留；不要叫客戶先中斷再連結。

## 多重防護（已上線）
1. **資料庫觸發器封存**（migrations/0021）：`threads_accounts`、`integrations` 被刪除，或 token 被換掉時，舊的一份自動存進 `*_archive`。不靠程式碼記得做。
2. **重新連結自動還原**：同一個 Threads 帳號中斷後再連結，會從封存還原人設、發文設定，並把舊的發文紀錄接回來（`restoreFromArchive`）。
3. **防誤按**：中斷 Threads 帳號或 LINE 要輸入帳號名稱才能執行；「一次中斷全部帳號」的功能已移除。
4. **自動化測試**：`tests/protection.test.ts` 擋下會刪資料的 migration 與程式碼。
5. **D1 Time Travel**：Cloudflare 自動保留 30 天內任何時間點的資料庫狀態，最後一道防線：
   `npx wrangler d1 time-travel restore <資料庫名稱> --timestamp=<ISO 時間>`（會覆蓋整個資料庫，先問負責人）。

## 從封存還原一個被刪掉的 Threads 帳號
```sql
-- 找到封存（最新的在最後）
SELECT archive_id,id,brand_id,username,reason,archived_at FROM threads_accounts_archive ORDER BY archive_id;
-- 還原（把 <archive_id> 換掉）；token 仍有效時就能直接發文
INSERT INTO threads_accounts(brand_id,threads_user_id,username,token_enc,expires_at,status,persona,tone,topics,posts_per_day,publishing_times,cta_text,auto_post_enabled,created_at,updated_at)
SELECT brand_id,threads_user_id,username,token_enc,expires_at,'ok',persona,tone,topics,posts_per_day,publishing_times,cta_text,auto_post_enabled,created_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM threads_accounts_archive WHERE archive_id=<archive_id>;
```

## 貼文排版嚴格規則（客戶指定，不可改回）
- 只能在標點符號（，。？！：；…）或 emoji 後面換行，**絕對不能在一句話中間換行（不准斷句）**。
- 每一句都要有標點，換行處保留標點（不可以再自動刪掉行尾逗號）。
- 每行盡量寫滿約 12～18 字，不要三五個字就換行。
- 寫在 `buildPrompt` 的「斷行嚴格規則」，並由 `tidyPart`／`mergeShortLines` 在存檔前強制修正；`tests/matrix.test.ts` 有檢查。

## 代客戶操作的規則
- **幫客戶寫或試發的貼文，一律先放進草稿**，由客戶在後台審核後自己發布；除非客戶明確說「直接發布」，不可以代為公開發出。

## 開發
- 測試：`npx tsc --noEmit && npx vitest run`（全部要過才能部署）
- 正式資料庫：`npx wrangler d1 migrations apply DB --remote -c .generated/wrangler.app.toml`
- 回覆使用者用繁體中文。
