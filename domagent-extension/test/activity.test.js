import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityHistory } from '../src/activity.js';

test('private history is bounded, metadata-only and persists across restarts', async () => {
  const saved = {};
  const storage = { async get() { return saved; }, async set(value) { Object.assign(saved, value); } };
  const history = new ActivityHistory(storage);
  for (let i = 0; i < 250; i++) history.record('command_requested', {
    request_id: `${i}`, operation: 'type_text', description: 'private explanation',
    text: 'private value', script: 'private source', url: 'https://site/?secret=yes', page: 'private contents',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(history.entries.length, 200);
  assert.equal(history.entries[0].request_id, '50');
  assert(!JSON.stringify(saved).includes('private'));
  assert(!JSON.stringify(saved).includes('secret'));
  const restored = new ActivityHistory(storage);
  await restored.load();
  assert.deepEqual(restored.entries, history.entries);
  assert.throws(() => history.record('unknown'), /INVALID_ACTIVITY_EVENT/);
});

test('history persistence errors are explicit and do not block control or lose in-memory events', async () => {
  const warnings = [];
  const history = new ActivityHistory({
    async get() { throw new Error('read denied'); },
    async set() { throw new Error('write denied'); },
  }, error => warnings.push(error.message));
  await history.load();
  history.record('approved', { operation: 'get_text' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(history.unavailable, true);
  assert.equal(history.entries.length, 1);
  assert.deepEqual(warnings, ['read denied', 'write denied']);
});
