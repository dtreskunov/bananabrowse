import assert from 'node:assert/strict';
import { test } from 'node:test';
const {
  connectionNotice,
  windowTitle,
  agentRows,
  splitUrl,
  hostOf,
  countdown,
  tabStatus,
  sessionSummary,
  feedStatus,
  failureMessage,
  operationLabel,
} = await import(process.env.DOMAGENT_UI_TEST_BUNDLE);

const atlas = { id: 'atlas', name: 'Atlas', url: 'https://atlas.example/', color: 'blue' };
const orion = { id: 'orion', name: 'Orion', url: null, color: 'red' };
const tab = (patch) => ({
  tabId: 1,
  id: 't1',
  title: 'T',
  url: 'https://a.example/',
  page_state: 'ready',
  working: false,
  help: false,
  ...patch,
});
const session = (agent, patch = {}) => ({
  client_id: crypto.randomUUID(),
  session_id: 's1',
  agent,
  title: 'Flights',
  purpose: 'Compare fares',
  state: 'attached',
  candidates: [],
  tabs: [],
  excluded: 0,
  ...patch,
});

test('a healthy connection is silent; only abnormal states produce a notice', () => {
  assert.equal(connectionNotice({ phase: 'online', error: null }), null);
  assert.deepEqual(connectionNotice({ phase: 'loading', error: null }), { kind: 'connecting' });
  assert.deepEqual(connectionNotice({ phase: 'connecting', error: null }), { kind: 'connecting' });
  // Once a connection has dropped, retries keep the offline notice instead of flickering.
  assert.deepEqual(connectionNotice({ phase: 'connecting', error: 'BROWSER_OFFLINE' }), {
    kind: 'offline',
    code: null,
  });
  assert.deepEqual(connectionNotice({ phase: 'offline', error: 'SERVICE_UNREACHABLE' }), {
    kind: 'offline',
    code: null,
  });
  assert.deepEqual(connectionNotice({ phase: 'offline', error: 'UPGRADE_REQUIRED' }), {
    kind: 'offline',
    code: 'UPGRADE_REQUIRED',
  });
  assert.deepEqual(connectionNotice({ phase: 'offline', error: 'TAB_LIMIT_REACHED' }), { kind: 'offline', code: null });
});

test('the window title carries offline and pending state', () => {
  assert.equal(windowTitle({ phase: 'online', error: null, pending_count: 0 }), 'DomAgent');
  assert.equal(windowTitle({ phase: 'online', error: null, pending_count: 2 }), 'DomAgent (2)');
  assert.equal(windowTitle({ phase: 'offline', error: 'BROWSER_OFFLINE', pending_count: 2 }), 'DomAgent: offline');
  assert.equal(windowTitle({ phase: 'connecting', error: null, pending_count: 0 }), 'DomAgent');
});

test('agents form one flat list with a one-word status', () => {
  const rows = agentRows([atlas, orion], [session(atlas, { tabs: [tab()] })]);
  assert.deepEqual(
    rows.map((row) => [row.agent.id, row.status]),
    [
      ['atlas', '1 session'],
      ['orion', 'Idle'],
    ],
  );
  assert.equal(agentRows([atlas], [session(atlas), session(atlas)])[0].status, '2 sessions');
  assert.deepEqual(
    agentRows([atlas], [session(atlas, { tabs: [tab({ working: true })] })]).map((r) => [r.status, r.tone]),
    [['Working', 'busy']],
  );
  assert.deepEqual(
    agentRows([atlas], [session(atlas, { tabs: [tab({ working: true }), tab({ help: true })] })]).map((r) => [
      r.status,
      r.tone,
    ]),
    [['Needs you', 'help']],
  );
  // Unconfirmed sessions are handled by the reconnect card, not counted on the row.
  assert.equal(agentRows([atlas], [session(atlas, { state: 'unconfirmed' })])[0].status, 'Idle');
  // A session whose agent was unpaired meanwhile still appears.
  assert.equal(agentRows([], [session({ id: 'gone', name: 'Gone' })])[0].agent.name, 'Gone');
});

test('URLs emphasize the host and fall back safely', () => {
  assert.deepEqual(splitUrl('https://bank.example/login?x=1'), { origin: 'bank.example', rest: '/login?x=1' });
  assert.deepEqual(splitUrl('not a url'), { origin: 'not a url', rest: '' });
  assert.equal(hostOf('https://da.example:8443/x'), 'da.example:8443');
  assert.equal(hostOf(null), '');
});

test('countdown, tab status, session summaries and labels are compact', () => {
  assert.equal(countdown(1_000_000 + 272_000, 1_000_000), '4:32');
  assert.equal(tabStatus(tab({ help: true, working: true })), 'Needs you');
  assert.equal(tabStatus(tab()), '');
  assert.equal(sessionSummary(session(atlas, { tabs: [tab()], excluded: 2 })), '1 tab · 2 not shared');
  assert.equal(feedStatus('uncertain'), 'Unconfirmed');
  assert.match(failureMessage('SOMETHING_NEW'), /SOMETHING_NEW/);
  assert.equal(operationLabel('request_handoff'), 'Asked for your help');
});
