import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { start, paired, DESCRIPTION, AGENT_KEY, OTHER_KEY } from './helpers.js';
import { resultBytes } from '../../shared/results.js';

const extracted = (rows) => ({
  document: 'fixture-document',
  scope: 'top-level-and-open-shadow-roots',
  rows,
  matched_count: rows.length,
  returned_count: rows.length,
  rows_truncated: false,
  field_issues: [],
  truncated: false,
});
const args = {
  description: DESCRIPTION,
  selector: '.listing',
  fields: { title: { selector: '.title' }, href: { selector: 'a', attribute: 'href' } },
};

test('query_all uses normal authority, validation, capabilities and error projection', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.2' });
  let commands = 0;
  extension.serve((command) => {
    commands++;
    if (command.args.selector === '.ambiguous')
      return { error: { code: 'ELEMENT_AMBIGUOUS', query_field: 'title', row_index: 0, secret: 'not-for-agent' } };
    if (command.args.selector === '.invalid-result') return { rows: [] };
    if (command.args.selector === '.large')
      return extracted(Array.from({ length: 10 }, () => ({ title: 'x'.repeat(400), href: 'https://example.test/' })));
    return extracted([{ title: 'Listing', href: 'https://example.test/item/1' }]);
  });
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Extract listings' });
  await extension.approveNext([
    { key: 801, title: 'Listings', url: 'https://example.test/listings' },
    { key: 802, title: 'Older extension', url: 'https://example.test/old', capabilities: ['get_text'] },
  ]);
  const session = await pending;
  const tab_id = session.tabs[0].tab_id;
  const call = (overrides = {}) => agent.call('query_all', { tab_id, ...args, ...overrides });
  assert.deepEqual((await call()).rows, [{ title: 'Listing', href: 'https://example.test/item/1' }]);
  const beforeInvalid = commands;
  await assert.rejects(call({ fields: { title: { selector: '.title', attribute: 'value' } } }), /INVALID_ARGUMENTS/);
  await assert.rejects(
    call({ fields: { title: { selector: '.title', javascript: 'do not run' } } }),
    /INVALID_ARGUMENTS/,
  );
  await assert.rejects(call({ description: 'too short' }), /INVALID_ARGUMENTS/);
  await assert.rejects(call({ tab_id: session.tabs[1].tab_id }), /CAPABILITY_UNAVAILABLE/);
  const foreign = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(foreign.call('query_all', { tab_id, ...args }), /NOT_FOUND/);
  assert.equal(commands, beforeInvalid);
  await assert.rejects(call({ selector: '.ambiguous' }), (error) => {
    assert.equal(error.code, 'ELEMENT_AMBIGUOUS');
    assert.equal(error.details.query_field, 'title');
    assert.equal(error.details.row_index, 0);
    assert(!JSON.stringify(error.details).includes('not-for-agent'));
    return true;
  });
  await assert.rejects(call({ selector: '.invalid-result' }), /INVALID_RESULT/);
  const compact = await call({ selector: '.large', max_output_bytes: 1024 });
  assert.equal(compact.returned_count, 1);
  assert.equal(compact.matched_count, 10);
  assert.equal(compact.rows_truncated, true);
  assert(resultBytes(compact) <= 1024);
});

test('query_all artifacts preserve JSON, integrity, source and agent isolation', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.2' });
  const data = extracted(
    Array.from({ length: 80 }, (_, index) => ({
      title: `Listing ${index} ${'x'.repeat(1000)}`,
      href: `https://example.test/item/${index}`,
    })),
  );
  extension.serve((command) => (command.args.selector === '.invalid-result' ? { rows: [] } : data));
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Export listings' });
  await extension.approveNext([{ key: 803, title: 'Listings', url: 'https://example.test/listings' }]);
  const tab_id = (await pending).tabs[0].tab_id;
  const stored = await agent.call('query_all', {
    tab_id,
    ...args,
    limit: 100,
    return_as: 'artifact',
    artifact_name: 'listings.json',
    max_output_bytes: 1024,
  });
  const body = JSON.stringify(data);
  assert.equal(stored.matched_count, 80);
  assert.equal(stored.returned_count, 80);
  assert.equal(stored.truncated, false);
  assert.equal(stored.artifact.mime, 'application/json');
  assert.equal(stored.artifact.bytes, Buffer.byteLength(body));
  assert.equal(stored.artifact.sha256, createHash('sha256').update(body).digest('hex'));
  const meta = fixture.hub.artifacts.list('atlas')[0];
  assert.equal(meta.source, 'query_all');
  const path = `/mcp/atlas?artifact=${stored.artifact.artifact_id}`;
  const download = await fetch(`${fixture.base}${path}`, {
    headers: { Authorization: ['Bearer', AGENT_KEY].join(' ') },
  });

  assert.equal(await download.text(), body);
  assert.equal(download.headers.get('x-content-sha256'), stored.artifact.sha256);
  assert.equal((await fetch(`${fixture.base}${path}`)).status, 401);
  const foreign = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(foreign.call('read_artifact', { artifact_id: stored.artifact.artifact_id }), /NOT_FOUND/);
  await assert.rejects(
    agent.call('query_all', { tab_id, ...args, selector: '.invalid-result', return_as: 'artifact' }),
    /INVALID_RESULT/,
  );
});

test('query_all on beta 1 requests an extension update before dispatch', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.1' });
  let commands = 0;
  extension.serve(() => {
    commands++;
    return extracted([{ title: 'Must not run' }]);
  });
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Old extension' });
  await extension.approveNext([
    { key: 804, title: 'Listings', url: 'https://example.test/listings', capabilities: ['get_text'] },
  ]);
  const tab_id = (await pending).tabs[0].tab_id;
  await assert.rejects(
    agent.call('query_all', { tab_id, ...args }),
    (error) =>
      error.code === 'CAPABILITY_UNAVAILABLE' &&
      error.details.required_extension_version === '0.9.0.2' &&
      error.details.dispatch_status === 'not_dispatched',
  );
  assert.equal(commands, 0);
});
