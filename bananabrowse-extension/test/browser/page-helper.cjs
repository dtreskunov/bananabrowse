// Loads pageHelper the way the extension ships it: page.ts compiled by esbuild.
const path = require('node:path');
const { createRequire } = require('node:module');
const { transform } = createRequire(path.join(__dirname, '../../../bananabrowse-mcp/package.json'))('esbuild');
const { readFile } = require('node:fs/promises');

let loaded;
exports.loadPageHelper = () =>
  (loaded ??= (async () => {
    const source = await readFile(path.resolve(__dirname, '../../src/page.ts'), 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  })());
