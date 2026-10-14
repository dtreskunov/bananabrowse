#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { audit, failureCode } from './errors.js';

process.umask(0o077);
let app;
let store;
try {
  const config = loadConfig();
  store = new Store(config.db);
  app = createApp(store, config);
  await app.listen();
  audit('service_started');
} catch (error) {
  audit('service_start_failed', { code: failureCode(error) });
  store?.close();
  process.exitCode = 1;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    if (app) await app.close();
    store?.close();
    audit('service_stopped');
  } catch (error) {
    audit('service_stop_failed', { code: failureCode(error) });
    process.exitCode = 1;
  }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
