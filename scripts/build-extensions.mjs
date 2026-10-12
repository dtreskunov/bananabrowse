import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { build } = require('esbuild');
const source = path.join(root, 'domagent-extension');

await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/.gitignore'), '*\n');

for (const browser of ['chrome', 'firefox']) {
  const output = path.join(root, 'dist', browser);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: { background: path.join(source, 'src/background.js'), ui: path.join(source, 'ui/ui.js') },
    bundle: true, outdir: output, format: 'iife', platform: 'browser',
    target: browser === 'chrome' ? 'chrome118' : 'firefox128',
    define: { BUILD_BROWSER: JSON.stringify(browser) },
    legalComments: 'none', logLevel: 'warning',
  });
  await cp(path.join(source, browser, 'icons'), path.join(output, 'icons'), { recursive: true });
  for (const file of ['options.html', 'popup.html', 'request.html', 'panel.html', 'ui.css']) {
    await cp(path.join(source, 'ui', file), path.join(output, file));
  }
  const manifest = JSON.parse(await readFile(path.join(source, browser, 'manifest.json'), 'utf8'));
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Built dist/${browser}`);
}
