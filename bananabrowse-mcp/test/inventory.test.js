import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start, paired, DESCRIPTION } from './helpers.js';

const page = (key, extra = {}) => ({ key, title: `Page ${key}`, url: `https://example.test/${key}`, ...extra });
async function session(extension, agent, key) {
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: `Inspect page ${key}` });
  const { group } = await extension.approveNext([page(key)]);
  return { group, result: await pending };
}
function databaseState(fixture) {
  return Object.fromEntries(
    ['sessions', 'tabs', 'metadata'].map((table) => [table, fixture.store.db.prepare(`SELECT * FROM ${table}`).all()]),
  );
}
function liveState(fixture) {
  return [...fixture.hub.live.values()].map((live) => ({
    session_id: live.session_id,
    state: live.state,
    firstSync: live.firstSync,
    tabs: [...live.tabs.values()].map((target) => fixture.hub.publicTab(target)),
  }));
}

test('server preserves reads from older extensions and rejects unknown capabilities without changing grants', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.1' });
  extension.serve(() => ({ text: 'Still readable', truncated: false }));
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Older extension' });
  const { group } = await extension.approveNext([page(901, { capabilities: ['get_text'] })]);
  const result = await pending;
  assert.equal(result.state, 'attached');
  assert.deepEqual(result.tabs[0].capabilities, ['get_text']);
  assert.equal(
    (await agent.call('get_text', { tab_id: result.tabs[0].tab_id, description: DESCRIPTION })).text,
    'Still readable',
  );
  group.tabs[0].capabilities = ['get_text', 'future_operation'];
  assert.throws(
    () => fixture.hub.sync(fixture.hub.online(extension.browser_id), { groups: extension.inventory() }),
    /INVALID_MESSAGE/,
  );
  assert.deepEqual((await agent.call('list_tabs', { session_id: result.session_id }))[0].capabilities, ['get_text']);
  assert.equal(
    (await agent.call('get_text', { tab_id: result.tabs[0].tab_id, description: DESCRIPTION })).text,
    'Still readable',
  );
  group.tabs[0].capabilities = [];
  await extension.sync();
  assert.deepEqual((await agent.call('list_tabs', { session_id: result.session_id }))[0].capabilities, []);
  await assert.rejects(
    agent.call('get_text', { tab_id: result.tabs[0].tab_id, description: DESCRIPTION }),
    /CAPABILITY_UNAVAILABLE/,
  );
});

test('a malformed later tab or group cannot partially change live grants or persisted inventory', async (t) => {
  let now = 1_800_000_000_000;
  const fixture = await start({ now: () => now });
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  await session(extension, agent, 902);
  await session(extension, agent, 903);
  const original = extension.inventory();
  const beforeDb = databaseState(fixture);
  const beforeLive = liveState(fixture);
  const conn = fixture.hub.online(extension.browser_id);
  const invalid = [
    (groups) => {
      groups[1].tabs[0].capabilities = [42];
    },
    (groups) => {
      groups[1].tabs[0].capabilities = ['invalid-operation'];
    },
    (groups) => {
      groups[1].tabs[0].capabilities = ['future_operation'.repeat(5)];
    },
    (groups) => {
      groups[1].tabs[0].capabilities = Array(129).fill('get_text');
    },
    (groups) => {
      groups[1].tabs[0].key = groups[0].tabs[0].key;
    },
    (groups) => {
      groups[1].tabs[0].id = groups[0].tabs[0].id;
    },
    (groups) => {
      groups[1].client_id = groups[0].client_id;
    },
    (groups) => {
      groups[1].state = 'invalid';
    },
    (groups) => {
      groups.push({ client_id: crypto.randomUUID(), title: 'Unknown', state: 'attached', tabs: [{ key: -1 }] });
    },
    (groups) => {
      groups[1].state = 'unconfirmed';
      groups[1].tabs[0].url = 42;
    },
  ];
  for (const corrupt of invalid) {
    now += 1000;
    const groups = structuredClone(original);
    groups[0].title = 'Must not publish';
    groups[0].tabs[0].title = 'Must not publish';
    groups[0].tabs[0].url = 'https://example.test/changed';
    groups[0].tabs.push({
      ...page(904),
      id: null,
      page_state: 'ready',
      capabilities: ['get_text'],
    });
    corrupt(groups);
    assert.throws(() => fixture.hub.sync(conn, { groups }), /INVALID_MESSAGE/);
    assert.deepEqual(databaseState(fixture), beforeDb);
    assert.deepEqual(liveState(fixture), beforeLive);
  }
  await extension.sync();
  assert.equal((await agent.call('list_sessions')).length, 2);
});

test('an invalid first inventory cannot publish an attached session or settle its request', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const conn = fixture.hub.online(extension.browser_id);
  const pending = fixture.hub.requestSession('atlas', { browser_id: extension.browser_id, purpose: 'First inventory' });
  const request = [...fixture.hub.sessionRequests.values()][0];
  const client_id = crypto.randomUUID();
  fixture.hub.sessionDecision(conn, { request_id: request.id, approved: true, client_id });
  const good = { ...page(905), id: null, page_state: 'ready', capabilities: ['get_text'] };
  const bad = { ...page(906), id: null, page_state: 'ready', capabilities: null };
  const group = { client_id, title: 'First inventory', state: 'attached', tabs: [good, bad] };
  const beforeDb = databaseState(fixture);
  assert.throws(() => fixture.hub.sync(conn, { groups: [group] }), /INVALID_MESSAGE/);
  assert.deepEqual(databaseState(fixture), beforeDb);
  assert.equal(fixture.hub.live.has(request.session_id), false);
  assert.equal((await agent.call('list_sessions'))[0].state, 'detached');
  await assert.rejects(agent.call('list_tabs', { session_id: request.session_id }), /SESSION_DETACHED/);
  assert(fixture.hub.sessionRequests.has(request.id));
  group.tabs = [good];
  fixture.hub.sync(conn, { groups: [group] });
  const result = await pending;
  assert.equal(result.state, 'attached');
  assert.equal(result.tabs.length, 1);
  const live = fixture.hub.live.get(result.session_id);
  live.firstSync = false;
  assert.equal((await agent.call('list_sessions'))[0].state, 'detached');
  await assert.rejects(agent.call('list_tabs', { session_id: result.session_id }), /SESSION_DETACHED/);
});
