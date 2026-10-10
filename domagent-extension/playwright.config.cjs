const path = require('node:path');
const { createRequire } = require('node:module');
const localRequire = createRequire(path.join(__dirname, '../domagent-mcp/package.json'));
const { defineConfig } = localRequire('@playwright/test');

module.exports = defineConfig({
  testDir: './test/browser',
  outputDir: './test-results',
  testMatch: '**/*.spec.cjs',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  reporter: 'line',
});
