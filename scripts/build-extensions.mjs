import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'bananabrowse-mcp/package.json'));
const { build } = require('esbuild');
const source = path.join(root, 'bananabrowse-extension');
const typecheck = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', source], {
  stdio: 'inherit',
});
if (typecheck.status !== 0) process.exit(typecheck.status || 1);
const uiBuild = spawnSync('npm', ['run', 'build'], { cwd: path.join(source, 'ui'), stdio: 'inherit' });
if (uiBuild.status !== 0) process.exit(uiBuild.status || 1);

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/.gitignore'), '*\n');

for (const browser of ['chrome', 'firefox']) {
  const output = path.join(root, 'dist', browser);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: { background: path.join(source, 'src/background.ts') },
    bundle: true,
    outdir: output,
    format: 'iife',
    platform: 'browser',
    target: browser === 'chrome' ? 'chrome118' : 'firefox128',
    define: { BUILD_BROWSER: JSON.stringify(browser) },
    legalComments: 'none',
    logLevel: 'warning',
  });
  await cp(path.join(source, browser, 'icons'), path.join(output, 'icons'), { recursive: true });
  await cp(path.join(source, 'ui/dist'), output, { recursive: true });
  await cp(path.join(source, 'node_modules/acorn/LICENSE'), path.join(output, 'licenses/acorn.txt'));
  await cp(path.join(source, 'ui/app.html'), path.join(output, 'app.html'));
  const manifest = JSON.parse(await readFile(path.join(source, browser, 'manifest.json'), 'utf8'));
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built dist/${browser}`);
}
