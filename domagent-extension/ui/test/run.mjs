import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'domagent-ui-tests-'));
try {
  const outfile = path.join(directory, 'presentation.mjs');
  await build({ entryPoints: [path.join(root, 'src/presentation.ts')],
    bundle: true, outdir: directory, outExtension: { '.js': '.mjs' }, format: 'esm', platform: 'node', logLevel: 'warning' });
  const result = spawnSync(process.execPath, ['--test', path.join(root, 'test/presentation.test.mjs')], {
    stdio: 'inherit', env: { ...process.env, DOMAGENT_UI_TEST_BUNDLE: pathToFileURL(outfile).href },
  });
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally { await rm(directory, { recursive: true, force: true }); }
