import assert from 'node:assert/strict';
import { test } from 'node:test';
const { statusLabel, groupByAgent, splitUrl, hostOf, countdown, tabStatus, sessionSummary, feedStatus,
  failureMessage, operationLabel } = await import(process.env.DOMAGENT_UI_TEST_BUNDLE);

const atlas = { id: 'atlas', name: 'Atlas', url: 'https://atlas.example/', color: 'blue' };
const orion = { id: 'orion', name: 'Orion', url: null, color: 'red' };
const session = (agent, patch = {}) => ({ client_id: crypto.randomUUID(), session_id: 's1', agent, title: 'Flights',
  purpose: 'Compare fares', state: 'attached', candidates: [], tabs: [], excluded: 0, ...patch });

test('connection status maps to three plain states', () => {
  assert.deepEqual(statusLabel('online'), { text: 'Connected', tone: 'ok' });
  assert.equal(statusLabel('connecting').tone, 'busy');
  assert.equal(statusLabel('offline').text, 'Offline');
});

test('agents with attached sessions are active; the rest are inactive', () => {
  const { active, inactive } = groupByAgent([atlas, orion], [session(atlas)]);
  assert.deepEqual(active.map(group => group.agent.id), ['atlas']);
  assert.deepEqual(inactive.map(group => group.agent.id), ['orion']);
  const unpaired = groupByAgent([], [session({ id: 'gone', name: 'Gone' })]);
  assert.equal(unpaired.active[0].agent.name, 'Gone');
});

test('URLs emphasize the host and fall back safely', () => {
  assert.deepEqual(splitUrl('https://bank.example/login?x=1'), { origin: 'bank.example', rest: '/login?x=1' });
  assert.deepEqual(splitUrl('https://bank.example/'), { origin: 'bank.example', rest: '' });
  assert.deepEqual(splitUrl('not a url'), { origin: 'not a url', rest: '' });
  assert.equal(hostOf('https://da.example:8443/x'), 'da.example:8443');
  assert.equal(hostOf(null), '');
});

test('countdown, tab status and session summaries are compact', () => {
  assert.equal(countdown(1_000_000 + 272_000, 1_000_000), '4:32');
  assert.equal(countdown(1, 1_000_000), '0:00');
  assert.equal(tabStatus({ help: true, working: true, page_state: 'ready' }), 'Needs you');
  assert.equal(tabStatus({ help: false, working: true, page_state: 'ready' }), 'Working');
  assert.equal(tabStatus({ help: false, working: false, page_state: 'ready' }), '');
  assert.equal(sessionSummary(session(atlas, { tabs: [{}], excluded: 2 })), '1 tab · 2 not shared');
  assert.match(sessionSummary(session(atlas, { state: 'unconfirmed' })), /reconnect/);
});

test('feed labels and failure messages never fall back to raw blank text', () => {
  assert.equal(feedStatus('uncertain'), 'Unconfirmed');
  assert.equal(feedStatus('info'), '');
  assert.match(failureMessage('BROWSER_REVOKED'), /set it up again/i);
  assert.match(failureMessage('SOMETHING_NEW'), /SOMETHING_NEW/);
  assert.equal(operationLabel('request_handoff'), 'Asked for your help');
  assert.equal(operationLabel('mystery_op'), 'mystery op');
});
