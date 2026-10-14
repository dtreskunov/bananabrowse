import { build } from 'esbuild';
import { mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/index.tsx')],
  bundle: true, outfile: path.join(output, 'ui.js'), format: 'iife', platform: 'browser',
  target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
  // The window bundles the controller; acorn (Firefox user-script source checks) resolves from the runtime package.
  nodePaths: [path.join(root, '../node_modules')],
  legalComments: 'eof', logLevel: 'warning',
});
await cp(path.join(root, 'THIRD-PARTY-NOTICES.txt'), path.join(output, 'THIRD-PARTY-NOTICES.txt'));
await mkdir(path.join(output, 'licenses'));
for (const [name, file] of [['preact', 'preact'], ['@preact/signals', 'preact-signals'], ['@preact/signals-core', 'preact-signals-core']]) {
  await cp(path.join(root, 'node_modules', name, 'LICENSE'), path.join(output, 'licenses', `${file}.txt`));
}
