import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tools } from '../mcp.js';
import { hash } from '../store.js';
import { OPERATIONS } from '../../shared/protocol.js';
import { start, paired, DESCRIPTION, OTHER_KEY, delay } from './helpers.js';

const page = (key) => ({ key, title: `Page ${key}`, url: `https://example.test/${key}` });
const requestArgs = (browserId, purpose = 'Task-owned browsing') => ({
  browser_id: browserId,
  request_key: crypto.randomUUID(),
  purpose,
});
const approved = async (agent, extension, args, key) => {
  const pending = agent.rawCall('request_session', args);
  const { group } = await extension.approveNext([page(key)]);
  return { session: await pending, group };
};

test('all session and tab tools require a private capability; new tasks require a request key', async (t) => {
  for (const tool of tools) {
    const properties = tool.inputSchema.properties;
    if (properties.session_id || properties.tab_id) {
      assert(tool.inputSchema.required.includes('session_token'), tool.name);
      assert(properties.session_token.pattern, tool.name);
    }
  }
  const fixture = await start();
  t.after(() => fixture.close());
  const { agent, extension } = await paired(fixture);
  const args = requestArgs(extension.browser_id);
  for (const request_key of [undefined, '', 'not-a-uuid', `${args.request_key}\n`]) {
    await assert.rejects(
      agent.rawCall('request_session', { ...args, request_key }),
      (error) =>
        error.code === 'INVALID_ARGUMENTS' &&
        error.details.argument_errors.some((entry) => entry.field === 'request_key'),
    );
  }
  assert.equal(extension.messages.filter((message) => message.type === 'session.request').length, 0);
});

test("tasks sharing agent credentials cannot operate on or end each other's groups", async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { agent, extension } = await paired(fixture, { extensionVersion: '0.9.0.2' });
  const otherTask = await fixture.mcp();
  const firstArgs = requestArgs(extension.browser_id, 'First task');
  const secondArgs = requestArgs(extension.browser_id, 'Second task');
  const { session: first, group } = await approved(agent, extension, firstArgs, 11);
  const { session: second } = await approved(otherTask, extension, secondArgs, 12);
  assert.notEqual(first.session_id, second.session_id);
  assert.notEqual(first.session_token, second.session_token);
  const tab_id = first.tabs[0].tab_id;
  const selector = '#target';
  const operationArgs = {
    navigate: { url: 'https://example.test/next' },
    click: { selector },
    inspect_element: { selector },
    type_text: { selector, text: 'value' },
    evaluate_script: { script: '1' },
    query_all: { selector, fields: { title: { selector: ':scope' } } },
    select_option: { selector, value: 'value' },
    set_checked: { selector, checked: true },
    press_key: { selector, key: 'Enter' },
    scroll: { delta_y: 1 },
  };
  const cases = [
    ['list_tabs', { session_id: first.session_id }],
    ['create_tab', { session_id: first.session_id, description: DESCRIPTION }],
    ['report_progress', { session_id: first.session_id, message: 'Not my task' }],
    ['end_session', { session_id: first.session_id }],
    ['end_session', { session_id: first.session_id, close_tabs: true, description: DESCRIPTION }],
    ['close_tab', { tab_id, description: DESCRIPTION }],
    ['request_handoff', { tab_id, instructions: 'Please log in' }],
    ...OPERATIONS.map((name) => [name, { tab_id, description: DESCRIPTION, ...operationArgs[name] }]),
  ];
  const commandsBefore = extension.messages.filter((message) => message.type === 'command').length;
  for (const [name, args] of cases) {
    await assert.rejects(otherTask.rawCall(name, args), { code: 'INVALID_ARGUMENTS' }, name);
    await assert.rejects(
      otherTask.rawCall(name, { ...args, session_token: second.session_token }),
      { code: 'NOT_FOUND' },
      name,
    );
  }
  assert.equal(extension.messages.filter((message) => message.type === 'command').length, commandsBefore);
  const listed = await otherTask.rawCall('list_sessions');
  assert.equal(listed.length, 2);
  for (const secret of [first.session_token, second.session_token, firstArgs.request_key, secondArgs.request_key]) {
    assert(!JSON.stringify(listed).includes(secret));
    assert(!JSON.stringify(extension.messages).includes(secret));
    assert(!JSON.stringify(fixture.store.db.prepare('SELECT * FROM session_requests').all()).includes(secret));
  }
  assert.equal(fixture.store.sessionAccessHash(first.session_id), hash(first.session_token));

  const foreignAgent = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(
    foreignAgent.rawCall('list_tabs', { session_id: first.session_id, session_token: first.session_token }),
    { code: 'NOT_FOUND' },
  );
  extension.serve((command) => {
    assert(!Object.hasOwn(command, 'session_token'));
    assert(!Object.hasOwn(command.args, 'session_token'));
    return { text: 'Owned task content' };
  });
  assert.equal(
    (
      await agent.rawCall('get_text', {
        tab_id,
        session_token: first.session_token,
        description: DESCRIPTION,
      })
    ).text,
    'Owned task content',
  );
  group.tabs = [];
  await extension.sync();
  await assert.rejects(
    otherTask.rawCall('get_text', { tab_id, session_token: second.session_token, description: DESCRIPTION }),
    { code: 'NOT_FOUND' },
  );
  await assert.rejects(
    agent.rawCall('get_text', { tab_id, session_token: first.session_token, description: DESCRIPTION }),
    { code: 'TAB_NOT_IN_SESSION' },
  );
  await agent.rawCall('end_session', { session_id: first.session_id, session_token: first.session_token });
  assert(fixture.store.session(second.session_id));
  assert.equal(
    (await otherTask.rawCall('list_tabs', { session_id: second.session_id, session_token: second.session_token }))
      .length,
    1,
  );
});

test('request keys recover uncertain results, reject conflicts and never duplicate pending or ended groups', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { agent, extension } = await paired(fixture);
  const args = { ...requestArgs(extension.browser_id), urls: ['https://example.test/21'], title: 'This task' };
  const pending = agent.rawCall('request_session', args);
  await extension.next('session.request');
  await assert.rejects(agent.rawCall('request_session', args), { code: 'SESSION_REQUEST_PENDING' });
  await assert.rejects(agent.rawCall('request_session', { ...args, purpose: 'A different task' }), {
    code: 'SESSION_REQUEST_CONFLICT',
  });
  // approveNext needs the already observed request again.
  extension.messages.find((message) => message.type === 'session.request').consumed = false;
  await extension.approveNext([page(21)]);
  const session = await pending;
  const recovered = await agent.rawCall('request_session', args);
  assert.equal(recovered.session_id, session.session_id);
  assert.equal(recovered.session_token, session.session_token);
  assert.deepEqual(recovered.tabs, session.tabs);
  for (const changed of [{ purpose: 'Changed' }, { title: 'Changed' }, { urls: [] }]) {
    await assert.rejects(agent.rawCall('request_session', { ...args, ...changed }), {
      code: 'SESSION_REQUEST_CONFLICT',
    });
  }
  extension.close();
  await delay(50);
  const offline = await agent.rawCall('request_session', args);
  assert.equal(offline.session_id, session.session_id);
  assert.equal(offline.session_token, session.session_token);
  assert.equal(offline.state, 'detached');
  await agent.rawCall('end_session', { session_id: session.session_id, session_token: session.session_token });
  await assert.rejects(agent.rawCall('request_session', args), { code: 'SESSION_ENDED' });
  assert.equal(extension.messages.filter((message) => message.type === 'session.request').length, 1);
});

test('session tokens and request recovery survive service restart without exposing credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bananabrowse-session-'));
  const db = join(directory, 'service.db');
  let fixture;
  try {
    fixture = await start({ db });
    const { agent, extension } = await paired(fixture);
    const args = requestArgs(extension.browser_id);
    const { session } = await approved(agent, extension, args, 31);
    await fixture.close();
    fixture = await start({ db });
    const resumed = await fixture.mcp();
    const recovered = await resumed.rawCall('request_session', args);
    assert.equal(recovered.session_id, session.session_id);
    assert.equal(recovered.session_token, session.session_token);
    assert.equal(recovered.state, 'detached');
    await assert.rejects(
      resumed.rawCall('list_tabs', { session_id: session.session_id, session_token: 'x'.repeat(43) }),
      { code: 'NOT_FOUND' },
    );
    await assert.rejects(
      resumed.rawCall('list_tabs', { session_id: session.session_id, session_token: session.session_token }),
      { code: 'BROWSER_OFFLINE' },
    );
    extension.base = fixture.base;
    await extension.refresh();
    await extension.connect();
    await extension.sync();
    assert.equal(
      (
        await resumed.rawCall('list_tabs', {
          session_id: session.session_id,
          session_token: session.session_token,
        })
      )[0].tab_id,
      session.tabs[0].tab_id,
    );
    await resumed.rawCall('end_session', { session_id: session.session_id, session_token: session.session_token });
    await fixture.close();
    fixture = await start({ db });
    const afterEnd = await fixture.mcp();
    await assert.rejects(afterEnd.rawCall('request_session', args), { code: 'SESSION_ENDED' });
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cancellation after approval can recover the committed session without another prompt', async (t) => {
  const fixture = await start();
  t.after(() => fixture.close());
  const { agent, extension } = await paired(fixture);
  const args = requestArgs(extension.browser_id);
  const abort = new AbortController();
  const pending = fixture.hub.requestSession('atlas', args, abort.signal);
  const request = [...fixture.hub.sessionRequests.values()][0];
  fixture.hub.sessionDecision(fixture.hub.online(extension.browser_id), {
    request_id: request.id,
    approved: true,
    client_id: crypto.randomUUID(),
  });
  abort.abort();
  await assert.rejects(pending, { code: 'COMMAND_CANCELLED' });
  const recovered = await agent.rawCall('request_session', args);
  assert.equal(recovered.session_id, request.session_id);
  assert.equal(recovered.session_token.length, 43);
  assert.equal(fixture.store.listSessions().length, 1);
  assert.equal(fixture.hub.sessionRequests.size, 0);
});

test('recovery records follow live sessions, retain ended keys for seven days and cascade on unpair', async (t) => {
  let now = 1_800_000_000_000;
  const fixture = await start({ now: () => now });
  t.after(() => fixture.close());
  const { agent, extension } = await paired(fixture);
  const args = requestArgs(extension.browser_id);
  const { session } = await approved(agent, extension, args, 41);
  now += 6 * 86_400_000;
  await extension.sync();
  now += 2 * 86_400_000;
  fixture.store.sweep();
  assert.equal((await agent.rawCall('request_session', args)).session_token, session.session_token);
  await agent.rawCall('end_session', { session_id: session.session_id, session_token: session.session_token });
  const record = fixture.store.sessionRequest('atlas', args.request_key);
  assert.equal(record.session_id, null);
  assert.equal(record.expires_at, now + 7 * 86_400_000);
  now += 6 * 86_400_000;
  fixture.store.sweep();
  await assert.rejects(agent.rawCall('request_session', args), { code: 'SESSION_ENDED' });
  now += 86_400_000;
  fixture.store.sweep();
  assert.equal(fixture.store.sessionRequest('atlas', args.request_key), undefined);
  extension.groups.clear();
  await extension.sync();
  const another = requestArgs(extension.browser_id, 'Another task');
  await approved(agent, extension, another, 42);
  await agent.rawCall('unpair_browser', { browser_id: extension.browser_id });
  assert.equal(fixture.store.sessionRequest('atlas', another.request_key), undefined);
});

test('existing schema-6 sessions remain visible but cannot be claimed by listing after upgrade', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bananabrowse-legacy-session-'));
  const db = join(directory, 'service.db');
  let fixture;
  try {
    fixture = await start({ db });
    const { agent, extension } = await paired(fixture);
    const args = requestArgs(extension.browser_id);
    const { session } = await approved(agent, extension, args, 51);
    await fixture.close();
    const legacy = new DatabaseSync(db);
    legacy.exec('DROP TABLE session_requests');
    legacy.close();
    fixture = await start({ db });
    const resumed = await fixture.mcp();
    assert.equal((await resumed.rawCall('list_sessions'))[0].session_id, session.session_id);
    assert.equal(fixture.store.db.prepare('PRAGMA user_version').get().user_version, 6);
    await assert.rejects(
      resumed.rawCall('end_session', { session_id: session.session_id, session_token: session.session_token }),
      { code: 'NOT_FOUND' },
    );
    assert(fixture.store.session(session.session_id));
  } finally {
    if (fixture) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
