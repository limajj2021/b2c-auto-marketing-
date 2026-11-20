#!/usr/bin/env node
// 用法：npm run backup -- --config .generated/wrangler.<brand>.toml
// 還原：npx wrangler d1 execute DB --remote --config <toml> --file backups/<file>.sql （見 docs/DEPLOY.md）
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const i = process.argv.indexOf('--config');
const config = i >= 0 ? process.argv[i + 1] : null;
if (!config) { console.error('需要 --config <wrangler toml>'); process.exit(1); }
mkdirSync('backups', { recursive: true });
const out = `backups/backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
execFileSync('npx', ['wrangler', 'd1', 'export', 'DB', '--remote', '--config', config, '--output', out], {
  stdio: 'inherit', env: { ...process.env, CI: 'true' },
});
console.log(`備份完成：${out}（內含個資，請加密保存）`);
