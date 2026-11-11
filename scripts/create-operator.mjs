#!/usr/bin/env node
// 建立營運總後台帳號（你與維護人員）。密碼只顯示一次。
// 用法：node scripts/create-operator.mjs --config .generated/wrangler.<deploy>.toml --username ops
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const opt = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const config = opt('config'), username = opt('username');
if (!config || !username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) { console.error('需要 --config <toml> 與 --username <3–32 字英數>'); process.exit(1); }
const password = randomBytes(12).toString('base64url');
const salt = randomBytes(16);
const hash = `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64')}`; // 與 src/util/crypto.ts 相同格式
const sql = `INSERT INTO operators(username,password_hash,created_at) VALUES('${username}','${hash}','${new Date().toISOString()}') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, enabled=1`;
execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--config', config, '--command', sql], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CI: 'true' } });
console.log(`營運帳號：${username}\n一次性密碼：${password}\n（只顯示一次；登入網址為 <部署網址>/ops.html）`);
