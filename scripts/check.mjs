import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const tsc = createRequire(resolve(root, 'domagent-mcp/package.json')).resolve('typescript/bin/tsc');
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const project of ['domagent-mcp', 'domagent-extension', 'domagent-extension/ui']) {
  run([tsc, '-p', resolve(root, project), '--noEmit']);
}
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      check(path);
      continue;
    }
    if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) run(['--check', path]);
  }
}
for (const directory of ['shared', 'domagent-mcp', 'domagent-extension', 'scripts']) check(resolve(root, directory));
console.log('TypeScript and JavaScript checks passed.');
