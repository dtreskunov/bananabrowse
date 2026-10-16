import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, paired, DESCRIPTION, AGENT_KEY, OTHER_KEY } from './helpers.js';
import { ArtifactStore } from '../artifacts.js';

const auth = (key) => ({ Authorization: ['Bearer', key].join(' ') });
const sha = (data) => createHash('sha256').update(data).digest('hex');

test('artifact store scopes, evicts, expires and persists blobs', () => {
  let clock = 1_000;
  const store = new ArtifactStore({ now: () => clock, quotaBytes: 10, quotaCount: 3, maxBytes: 8, ttlMs: 100 });
  const first = store.put('atlas', Buffer.from('aaaa'), { mime: 'text/plain' });
  assert.match(first.id, /^a[0-9A-Za-z_-]{22}$/);
  assert.equal(first.sha256, sha('aaaa'));
  assert.equal(store.read('atlas', first.id).data.toString(), 'aaaa');
  assert.throws(
    () => store.read('orion', first.id),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
  );
  assert.throws(() => store.read('atlas', 'a' + 'x'.repeat(22)), /NOT_FOUND/);
  assert.throws(
    () => store.put('atlas', Buffer.alloc(9), { mime: 'text/plain' }),
    (error) => error.code === 'RESULT_TOO_LARGE' && error.actual_bytes === 9 && error.limit_bytes === 8,
  );
  clock++;
  const second = store.put('atlas', Buffer.from('bbbb'), { mime: 'text/plain' });
  clock++;
  store.put('atlas', Buffer.from('cccc'), { mime: 'text/plain' });
  // Byte quota (10) evicts the oldest first.
  assert.throws(() => store.read('atlas', first.id), /NOT_FOUND/);
  assert.equal(store.read('atlas', second.id).data.toString(), 'bbbb');
  assert.equal(store.list('atlas').length, 2);
  store.put('orion', Buffer.from('dd'), { mime: 'text/plain' });
  assert.equal(store.list('orion').length, 1);
  clock += 200;
  assert.equal(store.list('atlas').length, 0);
  assert.throws(() => store.read('orion', store.index.keys().next().value ?? 'a' + 'x'.repeat(22)), /NOT_FOUND/);

  const directory = mkdtempSync(join(tmpdir(), 'bananabrowse-artifacts-'));
  try {
    const disk = new ArtifactStore({ directory, now: () => clock });
    const saved = disk.put('atlas', Buffer.from('persisted'), { mime: 'text/plain', name: 'data.txt' });
    assert.equal(statSync(join(directory, `${saved.id}.bin`)).mode & 0o777, 0o600);
    const reloaded = new ArtifactStore({ directory, now: () => clock });
    assert.equal(reloaded.read('atlas', saved.id).data.toString(), 'persisted');
    reloaded.prune(['orion']);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('evaluate_script return_as artifact stores bytes for HTTP download and paged reads', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.1' });
  const rows = Array.from({ length: 400 }, (_, index) => ({ id: index, name: `Run ✓ ${index}` }));
  extension.serve((command) => {
    if (command.args.artifact_encoding === 'base64')
      return { value: Buffer.from([0, 1, 2, 255]).toString('base64'), execution_world: 'MAIN' };
    if (command.args.artifact_name === 'rows.json') return { value: rows, execution_world: 'MAIN' };
    if (command.args.artifact_name === 'too-big.txt')
      return { error: { code: 'RESULT_TOO_LARGE', actual_bytes: 9_000_000, limit_bytes: 8_384_512 } };
    return { value: 'x', execution_world: 'MAIN' };
  });
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Export data' });
  await extension.approveNext([{ key: 31, title: 'Data', url: 'https://example.test/data' }]);
  const tab = (await pending).tabs[0].tab_id;
  const evaluate = (args) =>
    agent.call('evaluate_script', { tab_id: tab, description: DESCRIPTION, script: 'rows', ...args });

  const stored = await evaluate({ return_as: 'artifact', artifact_name: 'rows.json' });
  const body = JSON.stringify(rows);
  assert.deepEqual(stored.shape, { type: 'array', length: 400, item_keys: ['id', 'name'] });
  assert.equal(stored.artifact.mime, 'application/json');
  assert.equal(stored.artifact.bytes, Buffer.byteLength(body));
  assert.equal(stored.artifact.sha256, sha(body));
  assert(stored.preview.startsWith('[{"id":0'));
  assert.equal(stored.artifact.download_url, `https://service.test/mcp/atlas?artifact=${stored.artifact.artifact_id}`);

  const path = `/mcp/atlas?artifact=${stored.artifact.artifact_id}`;
  const download = await fetch(`${fixture.base}${path}`, { headers: auth(AGENT_KEY) });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(download.headers.get('x-content-sha256'), stored.artifact.sha256);
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="rows.json"');
  assert.equal(await download.text(), body);
  assert.equal((await fetch(`${fixture.base}${path}`, { method: 'HEAD', headers: auth(AGENT_KEY) })).status, 200);
  assert.equal((await fetch(`${fixture.base}${path}`)).status, 401);
  assert.equal((await fetch(`${fixture.base}${path}`, { headers: auth(OTHER_KEY) })).status, 401);
  assert.equal(
    (await fetch(`${fixture.base}/mcp/orion?artifact=${stored.artifact.artifact_id}`, { headers: auth(OTHER_KEY) }))
      .status,
    404,
  );
  assert.equal((await fetch(`${fixture.base}${path}&x=1`, { headers: auth(AGENT_KEY) })).status, 400);
  assert.equal((await fetch(`${fixture.base}/mcp/atlas?artifact=nope`, { headers: auth(AGENT_KEY) })).status, 400);
  assert.equal((await fetch(`${fixture.base}/health?artifact=${stored.artifact.artifact_id}`)).status, 400);
  assert.equal((await fetch(`${fixture.base}/mcp/atlas`, { headers: auth(AGENT_KEY) })).status, 405);
  assert.equal((await fetch(`${fixture.base}${path}`, { method: 'POST', headers: auth(AGENT_KEY) })).status, 405);

  // Paged reads never split a UTF-8 sequence and reassemble exactly.
  let offset = 0,
    assembled = '';
  for (;;) {
    const page = await agent.call('read_artifact', {
      artifact_id: stored.artifact.artifact_id,
      offset,
      max_bytes: 999,
    });
    assert.equal(page.encoding, 'utf8');
    assembled += page.data;
    offset = page.next_offset;
    if (page.eof) break;
  }
  assert.equal(assembled, body);

  const binary = await evaluate({ return_as: 'artifact', artifact_name: 'blob.png', artifact_encoding: 'base64' });
  assert.equal(binary.artifact.mime, 'image/png');
  assert.equal(binary.preview, undefined);
  const raw = await agent.call('read_artifact', { artifact_id: binary.artifact.artifact_id });
  assert.deepEqual([raw.encoding, raw.data], ['base64', 'AAEC/w==']);

  const listed = await agent.call('list_artifacts');
  assert.deepEqual(
    listed.map((item) => item.artifact_id).sort(),
    [stored.artifact.artifact_id, binary.artifact.artifact_id].sort(),
  );
  const other = await fixture.mcp('orion', OTHER_KEY);
  assert.deepEqual(await other.call('list_artifacts'), []);
  await assert.rejects(other.call('read_artifact', { artifact_id: stored.artifact.artifact_id }), /NOT_FOUND/);

  await assert.rejects(
    evaluate({ return_as: 'artifact', artifact_name: 'too-big.txt' }),
    (error) =>
      error.code === 'RESULT_TOO_LARGE' &&
      error.details.actual_bytes === 9_000_000 &&
      error.details.limit_bytes === 8_384_512 &&
      typeof error.details.hint === 'string',
  );

  assert.equal((await fetch(`${fixture.base}${path}`, { method: 'DELETE', headers: auth(AGENT_KEY) })).status, 204);
  assert.equal((await fetch(`${fixture.base}${path}`, { headers: auth(AGENT_KEY) })).status, 404);
  extension.close();
});

test('artifact requests to an older extension fail before dispatch with the required version', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  extension.serve(() => ({ value: 1, execution_world: 'MAIN' }));
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Export data' });
  await extension.approveNext([{ key: 32, title: 'Data', url: 'https://example.test/data' }]);
  const tab = (await pending).tabs[0].tab_id;
  await assert.rejects(
    agent.call('evaluate_script', { tab_id: tab, description: DESCRIPTION, script: '1', return_as: 'artifact' }),
    (error) =>
      error.code === 'CAPABILITY_UNAVAILABLE' &&
      error.details.required_extension_version === '0.9.0.1' &&
      error.details.dispatch_status === 'not_dispatched',
  );
  assert.equal([...(extension.pending?.values() || [])].length, 0);
  // Plain results keep working on the older extension.
  assert.equal((await agent.call('evaluate_script', { tab_id: tab, description: DESCRIPTION, script: '1' })).value, 1);
  extension.close();
});

test('unexpected argument errors name the key, list allowed fields and suggest a fix', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const agent = await fixture.mcp();
  await assert.rejects(agent.call('get_text', { tab_id: 't1', selectr: '#a', description: DESCRIPTION }), (error) => {
    const field = error.details.argument_errors.find((item) => item.reason === 'unexpected_field');
    return (
      error.code === 'INVALID_ARGUMENTS' &&
      field.field === 'selectr' &&
      field.did_you_mean === 'selector' &&
      field.allowed.includes('selector') &&
      typeof error.details.hint === 'string'
    );
  });
});
