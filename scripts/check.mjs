import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { check(path); continue; }
    if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue;
    const checked = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    if (checked.status !== 0) process.exit(checked.status || 1);
  }
  for (const directory of ['shared', 'domagent-mcp', 'domagent-extension', 'scripts']) check(resolve(root, directory));
}
console.log('JavaScript syntax checks passed.');
