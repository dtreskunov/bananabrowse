import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  start,
  paired,
  FakeExtension,
  DESCRIPTION,
  AGENT_KEY,
  OTHER_KEY,
  THIRD_KEY,
  delay,
  ORIGIN,
} from './helpers.js';
import { parseAgents, loadConfig } from '../config.js';
import { hash } from '../store.js';
import { tools } from '../mcp.js';

const page = (key, extra = {}) => ({ key, title: `Page ${key}`, url: `https://example.test/${key}`, ...extra });

test('public metadata and the 28-tool catalogue', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const health = await (await fetch(`${fixture.base}/health`)).json();
  assert.equal(health.protocol_version, 6);
  const metadata = await (await fetch(`${fixture.base}/.well-known/bananabrowse`)).json();
  assert.deepEqual([metadata.service, metadata.origin], ['bananabrowse', ORIGIN]);
  const agent = await fixture.mcp();
  const listed = await agent.client.listTools();
  assert.equal(listed.tools.length, 28);
  assert.deepEqual(
    listed.tools.slice(0, 11).map((tool) => tool.name),
    [
      'pair_browser',
      'list_browsers',
      'unpair_browser',
      'request_session',
      'list_sessions',
      'end_session',
      'list_tabs',
      'create_tab',
      'close_tab',
      'report_progress',
      'request_handoff',
    ],
  );
  assert.equal(tools.length, 28);
});

test('agent authentication uses the path ID and a hashed bearer key', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const post = (path, key) =>
    fetch(`${fixture.base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.equal((await post('/mcp/atlas', AGENT_KEY)).status, 200);
  assert.equal((await post('/mcp/atlas', OTHER_KEY)).status, 401);
  assert.equal((await post('/mcp/nobody', AGENT_KEY)).status, 401);
  assert.equal((await post('/mcp/atlas', '')).status, 401);
});

test('agent configuration parses env entries and rejects malformed ones', () => {
  const agents = parseAgents({
    BANANABROWSE_AGENT_BANANA_CLAW: `Banana Claw|https://banana.example|sha256:${hash('k'.repeat(20))}`,
  });
  assert.deepEqual([...agents.keys()], ['banana-claw']);
  assert.equal(agents.get('banana-claw').url, 'https://banana.example/');
  assert.throws(() => parseAgents({ BANANABROWSE_AGENT_X: 'X|' }), /INVALID_AGENT_CONFIG/);
  assert.throws(() => parseAgents({ BANANABROWSE_AGENT_X: 'X||md5:abc' }), /INVALID_AGENT_CONFIG/);
  assert.throws(
    () => parseAgents({ BANANABROWSE_AGENT_X: `X|javascript:alert(1)|sha256:${'0'.repeat(64)}` }),
    /INVALID_AGENT_CONFIG/,
  );
  const config = loadConfig({
    BANANABROWSE_ORIGIN: 'https://da.example',
    BANANABROWSE_PROTECTED_ORIGINS: 'https://idp.example/x, https://a.example',
  });
  assert.deepEqual(config.protectedOrigins, ['https://da.example', 'https://idp.example', 'https://a.example']);
  assert.equal(config.agents.size, 0);
});

test('browser registration, key-bound token refresh and rotated-token reuse revocation', async (t) => {
  let now = 1_800_000_000_000;
  const fixture = await start({ now: () => now });
  t.after(() => fixture.close());
  const extension = new FakeExtension(fixture.base);
  const registered = await extension.register();
  assert.match(registered.browser_id, /^b[0-9a-z]+$/);
  assert(registered.access_token && registered.refresh_token);
  const first = extension.refresh_token;
  await extension.refresh();
  assert.notEqual(extension.refresh_token, first);
  // A lost response is tolerated briefly: the superseded token still works within the grace window.
  extension.refresh_token = first;
  await extension.refresh();
  // Two generations back is neither current nor previous.
  extension.refresh_token = first;
  await assert.rejects(extension.refresh(), /NOT_AUTHORIZED/);
  assert(fixture.store.browser(extension.browser_id));
  // Reuse of a superseded token after the grace window revokes the browser outright.
  const fresh = new FakeExtension(fixture.base);
  await fresh.register();
  const old = fresh.refresh_token;
  await fresh.refresh();
  now += 600_000;
  fresh.refresh_token = old;
  await assert.rejects(fresh.refresh(), /NOT_AUTHORIZED/);
  assert.equal(fixture.store.browser(fresh.browser_id), undefined);
  // Wrong key: a stolen refresh token alone is useless.
  const thief = new FakeExtension(fixture.base);
  await thief.register();
  thief.browser_id = extension.browser_id;
  await assert.rejects(thief.refresh(), /NOT_AUTHORIZED/);
});

test('WebSocket authentication requires a live access token, the registered origin and a key proof', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const extension = new FakeExtension(fixture.base);
  await extension.register();
  const welcome = await extension.connect();
  assert.equal(welcome.browser_id, extension.browser_id);
  assert.deepEqual(welcome.agents, []);
  const forged = new FakeExtension(fixture.base);
  Object.assign(forged, {
    browser_id: extension.browser_id,
    key: (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])).privateKey,
    access_token: extension.access_token,
  });
  await assert.rejects(forged.connect(), /Timed out|closed/);
  const wrongOrigin = new FakeExtension(fixture.base, {
    origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  Object.assign(wrongOrigin, {
    key: extension.key,
    browser_id: extension.browser_id,
    access_token: extension.access_token,
  });
  await assert.rejects(wrongOrigin.connect(), /Timed out|closed/);
  extension.close();
});

test('pairing: extension code, agent proposal, local approval, decline and non-enumeration', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  assert.deepEqual(
    (await extension.next('agents')).agents.map((a) => a.id),
    ['atlas'],
  );
  const [listed] = await agent.call('list_browsers');
  assert.deepEqual(
    { ...listed, last_seen: undefined, paired_at: undefined },
    {
      browser_id: extension.browser_id,
      name: "Bob's Chrome",
      online: true,
      last_seen: undefined,
      paired_at: undefined,
      browser_info: { extension_version: '0.9.0', browser_name: 'chrome', browser_version: '150.0' },
    },
  );
  assert.ok(Date.parse(listed.last_seen) >= Date.parse(listed.paired_at));
  await assert.rejects(agent.call('pair_browser', { code: 'ZZZZ-ZZZZ' }), /PAIRING_UNAVAILABLE/);
  const other = await fixture.mcp('orion', OTHER_KEY);
  const code = await extension.pairingCode('AB12-CD34');
  const declined = other.call('pair_browser', { code });
  const proposal = await extension.next('pairing.proposal');
  assert.equal(proposal.agent.name, 'Orion');
  // A competing agent cannot hijack a proposal already shown to the user.
  const third = await fixture.mcp('vega', THIRD_KEY);
  await assert.rejects(third.call('pair_browser', { code }), /PAIRING_UNAVAILABLE/);
  extension.send({ type: 'pairing.decision', request_id: proposal.request_id, approved: false });
  await assert.rejects(declined, /ACTION_DECLINED/);
  await assert.rejects(other.call('pair_browser', { code }), /PAIRING_UNAVAILABLE/);
  assert.deepEqual(await other.call('list_browsers'), []);
  extension.close();
});

test('sessions: offline fails fast, approval creates a session with server-issued tab IDs', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  await assert.rejects(agent.call('request_session', { browser_id: 'b999', purpose: 'Test' }), /NOT_FOUND/);
  await assert.rejects(
    agent.call('request_session', {
      browser_id: extension.browser_id,
      purpose: 'x',
      urls: ['https://control.test/admin'],
    }),
    /HANDOFF_REQUIRED/,
  );
  await assert.rejects(
    agent.call('request_session', {
      browser_id: extension.browser_id,
      purpose: 'x',
      urls: Array(9).fill('https://example.test/'),
    }),
    /INVALID_ARGUMENTS/,
  );
  const declined = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Compare flights' });
  const rejected = await extension.next('session.request');
  extension.send({ type: 'session.decision', request_id: rejected.request_id, approved: false });
  await assert.rejects(declined, /ACTION_DECLINED/);

  const pending = agent.call('request_session', {
    browser_id: extension.browser_id,
    purpose: 'Compare flights',
    urls: ['https://example.test/1'],
    title: 'Flights',
  });
  const { request, created } = await extension.approveNext([page(11), page(12)]);
  assert.deepEqual(
    [request.purpose, request.title, request.urls, request.agent.id],
    ['Compare flights', 'Flights', ['https://example.test/1'], 'atlas'],
  );
  assert(request.agent.color && request.agent.url === 'https://atlas.example/');
  const session = await pending;
  assert.equal(session.session_id, created.session_id);
  assert.match(session.session_id, /^s[0-9a-z]+$/);
  assert.equal(session.state, 'attached');
  assert.deepEqual(
    session.tabs.map((tab) => tab.tab_id).every((id) => /^t[0-9a-z]+$/.test(id)),
    true,
  );
  assert.equal(session.tabs.length, 2);

  extension.close();
  await delay(50);
  await assert.rejects(
    agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Again' }),
    /BROWSER_OFFLINE/,
  );
  assert.equal((await agent.call('list_sessions'))[0].state, 'detached');
  await assert.rejects(agent.call('list_tabs', { session_id: session.session_id }), /BROWSER_OFFLINE/);
  await assert.rejects(
    agent.call('get_text', { tab_id: session.tabs[0].tab_id, description: DESCRIPTION }),
    /BROWSER_OFFLINE/,
  );
});

test('page operations use the ready/execute handshake and stay caller-scoped', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  extension.serve((command) => (command.operation === 'get_text' ? { text: 'Hello', truncated: false } : { ok: true }));
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Read a page' });
  await extension.approveNext([page(21)]);
  const session = await pending;
  const tab = session.tabs[0].tab_id;
  const text = await agent.call('get_text', { tab_id: tab, description: DESCRIPTION });
  assert.equal(text.text, 'Hello');
  const command = [...extension.pending.values()].find((c) => c.operation === 'get_text');
  assert.deepEqual(
    [command.session_id, command.tab_id, command.description, command.agent_id],
    [session.session_id, tab, DESCRIPTION, 'atlas'],
  );
  await assert.rejects(agent.call('get_text', { tab_id: tab, description: 'short' }), /INVALID_ARGUMENTS/);
  await assert.rejects(
    agent.call('navigate', { tab_id: tab, url: 'https://control.test/', description: DESCRIPTION }),
    /HANDOFF_REQUIRED/,
  );
  const other = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(other.call('get_text', { tab_id: tab, description: DESCRIPTION }), /NOT_FOUND/);
  await assert.rejects(other.call('list_tabs', { session_id: session.session_id }), /NOT_FOUND/);
  await assert.rejects(other.call('end_session', { session_id: session.session_id }), /NOT_FOUND/);

  await agent.call('report_progress', { session_id: session.session_id, message: 'Halfway there' });
  const progress = await extension.next('progress');
  assert.deepEqual([progress.message, progress.agent_id], ['Halfway there', 'atlas']);

  // Website-opened tabs in the group are in scope; protected-origin tabs are not.
  const group = [...extension.groups.values()][0];
  group.tabs.push(page(22), page(23, { url: 'https://control.test/secret' }));
  await extension.sync();
  const tabs = await agent.call('list_tabs', { session_id: session.session_id });
  assert.deepEqual(
    tabs.map((t) => t.url),
    ['https://example.test/21', 'https://example.test/22'],
  );

  // Navigation-only documents only expose navigate.
  group.tabs[1].page_state = 'navigation_only';
  group.tabs[1].url = 'about:blank';
  await extension.sync();
  await assert.rejects(
    agent.call('get_text', { tab_id: group.tabs[1].id, description: DESCRIPTION }),
    /DOCUMENT_NOT_CONTROLLABLE/,
  );

  // A tab dragged out of the group loses scope with an explanatory tombstone.
  group.tabs = group.tabs.filter((t) => t.id !== tab);
  await extension.sync();
  await assert.rejects(agent.call('get_text', { tab_id: tab, description: DESCRIPTION }), /TAB_NOT_IN_SESSION/);
  extension.close();
});

test('create_tab publishes the new tab through inventory before returning its ID', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Open tabs' });
  const { group } = await extension.approveNext([page(31)]);
  const session = await pending;
  extension.serve(async (command) => {
    assert.equal(command.operation, 'create_tab');
    group.tabs.push(page(32, { url: command.args.url }));
    await extension.sync();
    return { tab_id: group.tabs.at(-1).id };
  });
  const created = await agent.call('create_tab', {
    session_id: session.session_id,
    url: 'https://example.test/new',
    description: DESCRIPTION,
  });
  assert.equal(created.url, 'https://example.test/new');
  assert.match(created.tab_id, /^t/);
  extension.close();
});

test('closing tabs waits for the user: declines keep tabs, approved closes end the session, old extensions are refused', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  // An extension older than the close_tabs minimum is refused.
  const old = await paired(fixture, { extensionVersion: '0.9.0' });
  let pending = old.agent.call('request_session', { browser_id: old.extension.browser_id, purpose: 'Old extension' });
  await old.extension.approveNext([page(91)]);
  let session = await pending;
  const tooOld = (error) =>
    error.code === 'CAPABILITY_UNAVAILABLE' &&
    error.details.required_extension_version === '0.9.0.1' &&
    error.details.dispatch_status === 'not_dispatched';
  await assert.rejects(
    old.agent.call('close_tab', { tab_id: session.tabs[0].tab_id, description: DESCRIPTION }),
    tooOld,
  );
  await assert.rejects(
    old.agent.call('end_session', { session_id: session.session_id, close_tabs: true, description: DESCRIPTION }),
    tooOld,
  );
  assert.equal((await old.agent.call('list_sessions')).length, 1);
  old.extension.close();

  const { extension, agent } = await paired(fixture, { extensionVersion: '0.9.0.1' });
  pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Close tabs' });
  const { group } = await extension.approveNext([page(92), page(93)]);
  session = await pending;
  const [first, second] = session.tabs.map((tab) => tab.tab_id);
  const listTabs = async () =>
    (await agent.call('list_tabs', { session_id: session.session_id })).map((tab) => tab.tab_id);

  // The user keeps the tab: nothing is closed and the session continues.
  let seen;
  extension.handlers.command = (command) => {
    seen = command;
    extension.send({ type: 'result', request_id: command.request_id, error: { code: 'ACTION_DECLINED' } });
  };
  await assert.rejects(
    agent.call('close_tab', { tab_id: first, description: DESCRIPTION, timeout_seconds: 120 }),
    (error) => error.code === 'ACTION_DECLINED',
  );
  assert.deepEqual(
    [seen.operation, seen.tab_id, seen.args, seen.description],
    ['close_tab', null, { tab_id: first }, DESCRIPTION],
  );
  assert.ok(seen.wait_timeout_ms > 60_000 && seen.wait_timeout_ms <= 120_000, 'waits for the person, not a page slot');
  assert.deepEqual(await listTabs(), [first, second]);
  await assert.rejects(
    agent.call('end_session', { session_id: session.session_id, close_tabs: true }),
    (error) =>
      error.code === 'INVALID_ARGUMENTS' && error.details.argument_errors.some((e) => e.field === 'description'),
  );
  await assert.rejects(
    agent.call('end_session', { session_id: session.session_id, close_tabs: true, description: DESCRIPTION }),
    (error) => error.code === 'ACTION_DECLINED',
  );
  assert.equal(seen.operation, 'close_session');
  assert.deepEqual(await listTabs(), [first, second]);

  // Approved: the extension closes the tab, then reports.
  extension.serve(async (command) => {
    group.tabs = group.tabs.filter((tab) => tab.id !== command.args.tab_id);
    await extension.sync();
    return { tab_id: command.args.tab_id, session_ended: false };
  });
  assert.deepEqual(await agent.call('close_tab', { tab_id: first, description: DESCRIPTION }), {
    tab_id: first,
    closed: true,
    session_ended: false,
  });
  await assert.rejects(agent.call('get_text', { tab_id: first, description: DESCRIPTION }), /TAB_NOT_IN_SESSION/);
  // The last tab: the extension ends the session itself after the receipt; the hub never sends a close order.
  extension.serve((command) => ({ tab_id: command.args.tab_id, session_ended: true }));
  assert.deepEqual(await agent.call('close_tab', { tab_id: second, description: DESCRIPTION }), {
    tab_id: second,
    closed: true,
    session_ended: true,
  });
  assert.equal(
    (await agent.call('list_sessions')).some((row) => row.session_id === session.session_id),
    false,
  );
  extension.groups.clear();
  await extension.sync();

  pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'End and close' });
  await extension.approveNext([page(94)]);
  session = await pending;
  extension.serve((command) => {
    assert.deepEqual([command.operation, command.args], ['close_session', {}]);
    return { tabs_closed: 1 };
  });
  assert.deepEqual(
    await agent.call('end_session', { session_id: session.session_id, close_tabs: true, description: DESCRIPTION }),
    { session_id: session.session_id, ended: true, tabs_closed: true },
  );
  assert.equal(
    (await agent.call('list_sessions')).some((row) => row.session_id === session.session_id),
    false,
  );
  assert.equal(
    extension.messages.some((m) => m.type === 'session.end'),
    false,
  );
  extension.close();
});

test('handoff waits for the user, only blocks its tab and resolves on Done', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Need a login' });
  await extension.approveNext([page(41), page(42)]);
  const session = await pending;
  extension.autoReady = false;
  extension.serve((command) =>
    command.operation === 'request_handoff' ? { state: 'completed', user_confirmed: true } : { text: 'x' },
  );
  const handoff = agent.call('request_handoff', { tab_id: session.tabs[0].tab_id, instructions: 'Please log in' });
  const command = await extension.next('command', (m) => m.operation === 'request_handoff');
  assert.deepEqual(command.args, { instructions: 'Please log in' });
  extension.autoReady = true;
  // The other tab keeps working while the human step is pending.
  const read = agent.call('get_text', { tab_id: session.tabs[1].tab_id, description: DESCRIPTION });
  const readCommand = await extension.next('command', (m) => m.operation === 'get_text');
  extension.send({ type: 'command.ready', request_id: readCommand.request_id });
  await read;
  extension.send({ type: 'command.ready', request_id: command.request_id });
  assert.deepEqual(await handoff, { state: 'completed', user_confirmed: true });
  extension.close();
});

test('group lifecycle: reattach after reconnect, unconfirmed detach, closed group deletes the session', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Long task' });
  await extension.approveNext([page(51)]);
  const session = await pending;
  const tabId = session.tabs[0].tab_id;
  extension.send({ type: 'bye' });
  extension.close();
  await delay(50);
  assert.equal((await agent.call('list_sessions'))[0].state, 'detached');

  // Reopening the window reattaches with the same tab IDs.
  await extension.refresh();
  const welcome = await extension.connect();
  assert.equal(welcome.sessions[0].session_id, session.session_id);
  await extension.sync();
  assert.deepEqual(
    (await agent.call('list_tabs', { session_id: session.session_id })).map((tab) => tab.tab_id),
    [tabId],
  );

  // Chrome restart awaiting confirmation keeps the session but detaches it.
  [...extension.groups.values()][0].state = 'unconfirmed';
  await extension.sync();
  await assert.rejects(agent.call('list_tabs', { session_id: session.session_id }), /SESSION_DETACHED/);
  assert.equal((await agent.call('list_sessions')).length, 1);

  // The group vanished while disconnected: the next inventory deletes the session.
  extension.close();
  await delay(50);
  extension.groups.clear();
  await extension.refresh();
  await extension.connect();
  await extension.sync();
  assert.deepEqual(await agent.call('list_sessions'), []);
  await assert.rejects(agent.call('list_tabs', { session_id: session.session_id }), /NOT_FOUND/);
  extension.close();
});

test('end_session, pairing revocation and forgetting the browser end sessions and notify the window', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  let pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'One' });
  const first = await extension.approveNext([page(61)]);
  const one = await pending;
  assert.deepEqual(await agent.call('end_session', { session_id: one.session_id }), {
    session_id: one.session_id,
    ended: true,
    tabs_closed: false,
  });
  const ended = await extension.next('session.end');
  assert.equal(ended.close_tabs, undefined);
  assert.deepEqual([ended.session_id, ended.client_id], [one.session_id, first.group.client_id]);
  extension.groups.delete(first.group.client_id);

  pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Two' });
  await extension.approveNext([page(62)]);
  const two = await pending;
  extension.send({ type: 'pairing.revoke', agent_id: 'atlas' });
  await extension.next('session.end', (m) => m.session_id === two.session_id);
  assert.deepEqual(await agent.call('list_browsers'), []);
  assert.deepEqual(await agent.call('list_sessions'), []);

  extension.send({ type: 'browser.forget' });
  const closed = await extension.closed;
  assert.equal(closed.reason, 'REVOKED');
  assert.equal(fixture.store.browser(extension.browser_id), undefined);
});

test('sessions expire after 7 days without the extension reporting the group alive', async (t) => {
  let now = 1_800_000_000_000;
  const fixture = await start({ now: () => now });
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Retention' });
  await extension.approveNext([page(71)]);
  const session = await pending;
  extension.close();
  await delay(50);
  now += 6 * 86_400_000;
  fixture.store.sweep();
  assert.equal((await agent.call('list_sessions')).length, 1);
  now += 2 * 86_400_000;
  fixture.store.sweep();
  assert.deepEqual(await agent.call('list_sessions'), []);
  assert.equal(fixture.store.session(session.session_id), undefined);
});

test('re-pairing a same-named browser gets a unique name; agents unpair stale browsers themselves', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const old = await paired(fixture);
  old.extension.close();
  const fresh = await paired(fixture);
  assert.equal((await fresh.extension.next('browser')).name, "Bob's Chrome (2)");
  const listed = await fresh.agent.call('list_browsers');
  assert.deepEqual(
    listed.map((b) => [b.browser_id, b.name, b.online]),
    [
      [old.extension.browser_id, "Bob's Chrome", false],
      [fresh.extension.browser_id, "Bob's Chrome (2)", true],
    ],
  );
  // Other agents' pairings and unknown IDs are indistinguishable.
  const other = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(other.call('unpair_browser', { browser_id: old.extension.browser_id }), /NOT_FOUND/);
  assert.deepEqual(await fresh.agent.call('unpair_browser', { browser_id: old.extension.browser_id }), {
    browser_id: old.extension.browser_id,
    unpaired: true,
  });
  assert.deepEqual(
    (await fresh.agent.call('list_browsers')).map((b) => b.browser_id),
    [fresh.extension.browser_id],
  );
  await assert.rejects(fresh.agent.call('unpair_browser', { browser_id: old.extension.browser_id }), /NOT_FOUND/);
  fresh.extension.close();
});

test('paired browsers offline for 30 days are removed with their pairings and sessions', async (t) => {
  let now = 1_800_000_000_000;
  const fixture = await start({ now: () => now });
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  extension.close();
  await delay(50);
  now += 29 * 86_400_000;
  assert.deepEqual(fixture.store.sweep().browsers, []);
  now += 2 * 86_400_000;
  assert.deepEqual(fixture.store.sweep().browsers, [extension.browser_id]);
  assert.deepEqual(await agent.call('list_browsers'), []);
  assert.deepEqual(fixture.store.listPairings(), []);
});

test('approved groups announced before commit survive; unknown groups are reported for cleanup', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Race' });
  const request = await extension.next('session.request');
  const client_id = crypto.randomUUID();
  extension.groups.set(client_id, { client_id, title: 'Atlas', request_id: request.request_id, tabs: [page(81)] });
  const ack = await extension.sync();
  assert.deepEqual(ack.unknown, []);
  extension.send({ type: 'session.decision', request_id: request.request_id, approved: true, client_id });
  await extension.next('session.created');
  delete extension.groups.get(client_id).request_id;
  await extension.sync();
  assert.equal((await pending).tabs.length, 1);
  const stray = crypto.randomUUID();
  extension.groups.set(stray, { client_id: stray, title: 'Stale', tabs: [] });
  assert.deepEqual((await extension.sync()).unknown, [stray]);
  extension.close();
});

test('a sync that races ahead of its acknowledgement keeps the same tab IDs', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Race IDs' });
  const { group } = await extension.approveNext([page(91)]);
  const session = await pending;
  const first = session.tabs[0].tab_id;
  // Resend the inventory as if the assignment had not arrived yet.
  group.tabs[0].id = null;
  const ack = await extension.sync();
  assert.deepEqual(
    ack.assignments.map((a) => a.id),
    [first],
  );
  assert.deepEqual(
    (await agent.call('list_tabs', { session_id: session.session_id })).map((tab) => tab.tab_id),
    [first],
  );
  extension.close();
});

test('a pending group reported after commit does not resolve request_session with an empty tab list', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture);
  const pending = agent.call('request_session', {
    browser_id: extension.browser_id,
    purpose: 'Pending race',
    urls: ['https://example.test/'],
  });
  const request = await extension.next('session.request');
  const client_id = crypto.randomUUID();
  extension.groups.set(client_id, { client_id, title: 'Atlas', request_id: request.request_id, tabs: [] });
  extension.send({ type: 'session.decision', request_id: request.request_id, approved: true, client_id });
  await extension.next('session.created');
  // The browser has not processed session.created yet and still reports the group as pending.
  await extension.sync();
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(100);
  assert.equal(settled, false);
  const group = extension.groups.get(client_id);
  delete group.request_id;
  group.tabs = [page(95)];
  await extension.sync();
  assert.equal((await pending).tabs.length, 1);
  extension.close();
});

test('a final bye followed immediately by close is recorded as a graceful disconnect', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const extension = new FakeExtension(fixture.base);
  await extension.register();
  await extension.connect();
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  try {
    extension.send({ type: 'bye' });
    extension.ws.close(1000);
    await extension.closed;
    await delay(50);
  } finally {
    process.stdout.write = write;
  }
  assert(
    lines.some((line) => line.includes('"browser_disconnected"') && line.includes('"GRACEFUL"')),
    lines.join(''),
  );
  assert(!lines.some((line) => line.includes('ws_failure')));
});
