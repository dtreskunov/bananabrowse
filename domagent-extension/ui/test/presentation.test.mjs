import assert from 'node:assert/strict';
import { test } from 'node:test';
const { deriveView, suggestedSelection, taskGroups, groupDetail, failureMessage } = await import(process.env.DOMAGENT_UI_TEST_BUNDLE);
const { decodeSnapshot } = await import(new URL('types.mjs', process.env.DOMAGENT_UI_TEST_BUNDLE));
const workspace = { workspace_id: 'task-1', windowId: 1, groupId: 1, state: 'inactive', tabs: [], acknowledged: false };
function state(patch = {}) {
  return { phase: 'authenticated', identity: { client_label: 'Atlas' }, config: {}, pairing: null,
    failures: [], current_error: null, activity: [], saved_connections: [], workspaces: [workspace],
    available_groups: [{ groupId: 1, title: 'DomAgent - Atlas', tab_count: 2, tab_titles: ['Invoice', 'Account'] }], ...patch };
}
test('one derived status and primary action distinguish transport, activation, user pause and help', () => {
  for (const phase of ['connecting', 'authenticating', 'proving']) assert.equal(deriveView(state({ phase }), '1').action, null);
  assert.equal(deriveView(state({ identity: null }), '').action, 'Connect assistant');
  assert.equal(deriveView(state({ phase: 'disconnected' }), '1').action, 'Continue');
  assert.equal(deriveView(state({ phase: 'disconnected' }), '').action, 'Reconnect');
  assert.equal(deriveView(state(), '').mode, 'choose');
  assert.equal(deriveView(state(), 'new').action, 'Start');
  assert.equal(deriveView(state(), '1').action, 'Continue');
  assert.equal(deriveView(state({ workspaces: [{ ...workspace, state: 'paused' }] }), '1').label, 'Paused by you');
  assert.equal(deriveView(state({ workspaces: [{ ...workspace, state: 'active' }] }), '1').mode, 'starting');
  const active = { ...workspace, state: 'active', acknowledged: true };
  assert.equal(deriveView(state({ workspaces: [active] }), '1').action, 'Pause');
  assert.equal(deriveView(state({ workspaces: [{ ...active, tabs: [{ commands: [{ human: true }] }] }] }), '1').action, 'Go to task');
});
test('historical connection loss and uncertainty never override a healthy active task', () => {
  const snapshot = state({ last_session_end: { reason: 'CONNECTION_LOST', at: 1 }, failures: ['NOT_AUTHORIZED', 'OUTCOME_UNKNOWN'],
    workspaces: [{ ...workspace, state: 'active', acknowledged: true }] });
  const view = deriveView(snapshot, '1');
  assert.equal(view.label, 'Ready');
  assert(!view.message.includes('connection'));
  assert.equal(view.action, 'Pause');
  assert.match(failureMessage('OUTCOME_UNKNOWN'), /before repeating/);
});
test('native IDs, not duplicate names, determine remembered selection and vanished-group recovery', () => {
  const duplicate = state({ available_groups: [
    { groupId: 1, title: 'DomAgent - Atlas' }, { groupId: 2, title: 'DomAgent - Atlas' },
    { groupId: 3, title: 'Personal' },
  ] });
  assert.equal(suggestedSelection(duplicate, '2'), '2');
  assert.equal(suggestedSelection(duplicate, null), '1');
  assert.equal(suggestedSelection(duplicate, ''), '');
  assert.equal(suggestedSelection(duplicate, 'new'), 'new');
  assert.deepEqual(taskGroups(duplicate).map(group => group.groupId), [1, 2]);
  assert.equal(suggestedSelection({ ...duplicate, workspaces: [] }, '999'), '');
  assert.equal(suggestedSelection(state({ workspaces: [] }), '999'), '');
  assert.equal(suggestedSelection(state({ available_groups: [], workspaces: [] }), null), 'new');
  assert.match(groupDetail(state().available_groups[0], 0), /2 tabs.*Invoice, Account/);
  assert(!groupDetail(state().available_groups[0], 0).includes('#1'));
});
test('snapshot boundary rejects malformed actionable state and preserves explicit failures', () => {
  assert.equal(decodeSnapshot(state()).phase, 'authenticated');
  for (const patch of [
    { workspaces: [{ ...workspace, state: 'guess' }] }, { workspaces: [{ ...workspace, tabs: [{ commands: [] }] }] },
    { activity: [{ event: 'connected', time: 1 }] }, { available_groups: [{ groupId: '1', title: 'DomAgent' }] },
    { pairing: {} }, { failures: [null] },
  ]) assert.throws(() => decodeSnapshot(state(patch)), /INVALID_MESSAGE/);
});
