#!/usr/bin/env node
// 用法：npm run provision -- --brand example [--dry-run]
// 前置：已 `npx wrangler login`（或設定 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）。
// 憑證檔：.secrets/<brand>.env（KEY=VALUE；不會被提交，也不會被印出）。
// 注意：本腳本尚未對真實 Cloudflare 帳號驗證，見 docs/PHASE0.md。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const dry = args.includes('--dry-run');
const brand = opt('brand');
if (!brand || !/^[a-z0-9-]+$/.test(brand)) { console.error('需要 --brand <name>（對應 brands/<name>.json）'); process.exit(1); }

const cfgPath = `brands/${brand}.json`;
if (!existsSync(cfgPath)) { console.error(`找不到 ${cfgPath}`); process.exit(1); }
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
for (const k of ['brandId', 'name', 'workerName', 'd1Name', 'timezone', 'adminUsername']) {
  if (!cfg[k]) { console.error(`設定缺少 ${k}`); process.exit(1); }
}

// 後台「設定 → 連線」可直接填入 LINE / Gemini / Threads 憑證（加密存入資料庫）；以下 Secrets 為選填的後備或系統層設定。
const SECRET_KEYS = ['SESSION_SECRET', 'CRED_ENC_KEY', 'THREADS_APP_SECRET', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'THREADS_ACCESS_TOKEN', 'THREADS_USER_ID', 'GEMINI_API_KEY'];
const AUTO_KEYS = ['SESSION_SECRET', 'CRED_ENC_KEY']; // 未提供且 Worker 上尚無時自動產生；已存在時絕不覆蓋
const secrets = {};
const secretFile = `.secrets/${brand}.env`;
if (existsSync(secretFile)) {
  for (const line of readFileSync(secretFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) secrets[m[1]] = m[2];
  }
}
for (const k of SECRET_KEYS) if (!secrets[k] && process.env[`LEADGEN_${k}`]) secrets[k] = process.env[`LEADGEN_${k}`]; // 允許以環境變數傳入，不落地成檔案
const threadsAppId = cfg.threadsAppId ?? process.env.LEADGEN_THREADS_APP_ID ?? '';

const dir = '.generated';
const tomlPath = `${dir}/wrangler.${brand}.toml`;
const wr = (a, o = {}) =>
  execFileSync('npx', ['wrangler', ...a], { encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['pipe', 'pipe', 'pipe'], ...o });
const step = (n, t) => console.log(`[${n}/9] ${t}`);

if (dry) {
  console.log(`DRY RUN — brand=${brand} worker=${cfg.workerName} d1=${cfg.d1Name}`);
  [
    '讀取企業設定', '驗證雲端權限 (wrangler whoami)', '建立／取得 D1', '產生 wrangler 設定並執行遷移', '寫入品牌種子資料與管理員',
    '部署 Worker + 管理頁', '設定 Secrets（值不會顯示）', '健康檢查', '輸出管理網址與待完成授權',
  ].forEach((t, i) => console.log(` ${i + 1}. ${t}`));
  console.log('憑證（LINE / Gemini / Threads）部署後於後台「設定 → 連線」填入。');
  process.exit(0);
}

const q = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
const now = new Date().toISOString();

step(1, '已讀取企業設定');
step(2, '驗證雲端權限');
try { wr(['whoami']); } catch { console.error('Cloudflare 未登入或權限不足。請先執行 npx wrangler login。'); process.exit(1); }

step(3, '建立／取得 D1');
const findDb = () => JSON.parse(wr(['d1', 'list', '--json'])).find((d) => d.name === cfg.d1Name);
let db = findDb();
if (!db) { wr(['d1', 'create', cfg.d1Name]); db = findDb(); }
if (!db) { console.error('無法取得 D1 id'); process.exit(1); }
const dbId = db.uuid ?? db.id;

step(4, '產生 wrangler 設定並執行遷移');
mkdirSync(dir, { recursive: true });
writeFileSync(tomlPath, `name = "${cfg.workerName}"
main = "../src/index.ts"
compatibility_date = "2025-01-01"
${cfg.customDomain ? `workers_dev = true\nroutes = [{ pattern = "${cfg.customDomain}", custom_domain = true }]\n` : ''}
[vars]
GEMINI_MODEL = "${cfg.geminiModel ?? 'gemini-3.5-flash-lite'}"
THREADS_APP_ID = "${threadsAppId}"
THREADS_APP_MODE = "${cfg.threadsAppMode ?? 'development'}"
MULTI_TENANT = "${cfg.multiTenant ? '1' : ''}"
PUBLIC_BASE_URL = "${cfg.publicBaseUrl ?? ''}"
CRON_SUBREQUEST_LIMIT = "${cfg.cronSubrequestLimit ?? ''}"

[assets]
directory = "../public"
binding = "ASSETS"
run_worker_first = ["/api/*", "/line/*", "/threads/*"]

[observability]
enabled = true

[triggers]
crons = ["*/5 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "${cfg.d1Name}"
database_id = "${dbId}"
migrations_dir = "../migrations"
`);
wr(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', tomlPath]);

step(5, '寫入種子資料');
const s = cfg.settings ?? {};
const cols = {
  services: s.services ?? '', audience: s.audience ?? '', content_tone: s.content_tone ?? '專業、親切、清楚',
  content_topics: JSON.stringify(s.content_topics ?? []), banned_words: JSON.stringify(s.banned_words ?? []),
  cta_text: s.cta_text ?? '', line_add_url: s.line_add_url ?? '', posting_mode: s.posting_mode ?? 'B',
  posts_per_day: s.posts_per_day ?? 1, line_config: JSON.stringify(cfg.lineConfig ?? {}), updated_at: now,
};
let seed = `INSERT OR IGNORE INTO brands(id,slug,name,industry,description,timezone,created_at) VALUES(${q(cfg.brandId)},${q(cfg.slug ?? cfg.brandId)},${q(cfg.name)},${q(cfg.industry ?? 'general')},${q(cfg.description ?? '')},${q(cfg.timezone)},${q(now)});\n`;
seed += `INSERT OR IGNORE INTO brand_settings(brand_id,${Object.keys(cols).join(',')}) VALUES(${q(cfg.brandId)},${Object.values(cols).map((v) => (typeof v === 'number' ? v : q(v))).join(',')});\n`;
let adminPassword = null;
const exists = JSON.parse(wr(['d1', 'execute', 'DB', '--remote', '--config', tomlPath, '--json', '--command',
  `SELECT COUNT(*) AS c FROM admin_users WHERE authentication_id=${q(cfg.adminUsername)}`]));
if (!(exists[0]?.results?.[0]?.c > 0)) {
  adminPassword = randomBytes(12).toString('base64url');
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(adminPassword, salt, 100000, 32, 'sha256'); // 與 src/util/crypto.ts 相同格式
  seed += `INSERT INTO admin_users(brand_id,role,authentication_id,password_hash) VALUES(${q(cfg.brandId)},'admin',${q(cfg.adminUsername)},${q(`pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`)});\n`;
}
writeFileSync(`${dir}/seed.${brand}.sql`, seed);
wr(['d1', 'execute', 'DB', '--remote', '--config', tomlPath, '--file', `${dir}/seed.${brand}.sql`]);

step(6, '部署 Worker 與管理頁');
const out = wr(['deploy', '--config', tomlPath]);
const url = (out.match(/https:\/\/[^\s]+\.workers\.dev/) ?? [])[0];

step(7, '設定 Secrets（不輸出值）');
let existing = new Set();
try { existing = new Set(JSON.parse(wr(['secret', 'list', '--config', tomlPath])).map((x) => x.name)); } catch { /* 首次部署 */ }
for (const k of AUTO_KEYS) {
  if (!secrets[k] && !existing.has(k)) { secrets[k] = randomBytes(32).toString('hex'); console.log(`   （${k} 已自動產生並設定）`); }
}
for (const k of SECRET_KEYS) if (secrets[k]) wr(['secret', 'put', k, '--config', tomlPath], { input: secrets[k] });

step(8, '健康檢查');
let healthy = false;
if (url) {
  try { const r = await fetch(`${url}/api/health`); healthy = r.ok && (await r.json()).ok === true; } catch { /* 可能尚在生效 */ }
}
console.log(healthy ? '   OK' : '   未通過（網址可能尚在生效，請稍後開啟 /api/health 確認）');

step(9, '完成');
console.log(`\n管理網址：${url ?? '（請至 Cloudflare 後台查看）'}`);
console.log(`LINE Webhook URL：${url ? url + '/line/webhook' : '<管理網址>/line/webhook'}`);
if (adminPassword) console.log(`管理員帳號：${cfg.adminUsername}\n一次性初始密碼：${adminPassword}\n（僅顯示一次，登入後請立即至後台變更）`);
else console.log(`管理員 ${cfg.adminUsername} 已存在，未重設密碼。`);
console.log(`\n下一步：登入後台 → 設定 → 連線，貼上 LINE 憑證與 Gemini key，並按「連結 Threads」。`);
if (!threadsAppId || !existing.has('THREADS_APP_SECRET') && !secrets.THREADS_APP_SECRET) console.log('提醒：尚未設定 Threads App（brands/*.json 的 threadsAppId 與 .secrets 的 THREADS_APP_SECRET），「連結 Threads」按鈕將無法使用。');
