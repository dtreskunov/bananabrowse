import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start, paired, DESCRIPTION, OTHER_KEY } from './helpers.js';
import { resultBytes } from '../../shared/results.js';

async function setup(t, extensionVersion = '0.9.0.5') {
  const fixture = await start();
  t.after(() => fixture.close());
  const { extension, agent } = await paired(fixture, { extensionVersion });
  const pending = agent.call('request_session', { browser_id: extension.browser_id, purpose: 'Disposable form' });
  await extension.approveNext([{ key: 901, title: 'Form', url: 'https://example.test/form' }]);
  const session = await pending;
  return { fixture, extension, agent, tab_id: session.tabs[0].tab_id };
}

test('discovery and ambiguity carry bounded actionable refs without bypassing authority', async (t) => {
  const { fixture, extension, agent, tab_id } = await setup(t);
  const document = 'a'.repeat(32);
  extension.serve((command) => {
    if (command.operation === 'click')
      return {
        error: {
          code: 'ELEMENT_AMBIGUOUS',
          document,
          matches: 8,
          candidates: Array.from({ length: 8 }, (_, index) => ({
            ref: `e${index + 1}`,
            name: 'Next',
            visible: index !== 0,
            secret: 'must-not-leak',
          })),
          candidates_truncated: true,
        },
      };
    return {
      document,
      elements: Array.from({ length: 20 }, (_, index) => ({ ref: `e${index + 1}`, name: 'x'.repeat(100) })),
      matched_count: 20,
      returned_count: 20,
      truncated: false,
    };
  });
  const found = await agent.call('find_elements', {
    tab_id,
    text: 'Next',
    description: 'Find Next',
    max_output_bytes: 1024,
  });
  assert(found.elements.length > 0 && found.elements.length < 20);
  assert.equal(found.returned_count, found.elements.length);
  assert.equal(found.matched_count, 20);
  assert.equal(found.truncated, true);
  assert(resultBytes(found) <= 1024);
  await assert.rejects(agent.call('click', { tab_id, selector: '.next', description: 'Next' }), (error) => {
    assert.equal(error.code, 'ELEMENT_AMBIGUOUS');
    assert.equal(error.details.document, document);
    assert.equal(error.details.candidates.length, 5);
    assert.equal(error.details.candidates[0].visible, false);
    assert(!JSON.stringify(error.details).includes('must-not-leak'));
    assert(error.details.hint.includes('find_elements'));
    return true;
  });
  const foreign = await fixture.mcp('orion', OTHER_KEY);
  await assert.rejects(foreign.call('find_elements', { tab_id, text: 'Next', description: DESCRIPTION }), /NOT_FOUND/);
});

test('fill_form validates the entire batch, fills sequentially, observes once and stops on uncertainty', async (t) => {
  const { extension, agent, tab_id } = await setup(t);
  const calls = [];
  extension.serve((command) => {
    calls.push({ operation: command.operation, selector: command.args.selector });
    if (command.args.selector === '#reject')
      return {
        error: {
          code: 'OUTCOME_UNKNOWN',
          input_state: { value_present: true, value_matches: false, value: 'must-not-leak' },
        },
      };
    if (command.operation === 'get_page_snapshot') return { text: 'Ready', elements: [], document: 'fixture-document' };
    return { typed: true, input_state: { value_matches: true, value_present: true } };
  });
  const fields = [
    { selector: '#name', text: 'Fixture' },
    { selector: '#amount', text: '12', expected_value: '12.00' },
  ];
  for (const invalid of [
    [],
    Array.from({ length: 21 }, () => fields[0]),
    [fields[0], { selector: '#amount' }],
    [fields[0], { text: 'private-value' }],
    [fields[0], { ref: 'e1', text: 'private-value' }],
    [fields[0], { selector: '#x', ref: 'e1', document: 'fixture-document', text: 'private-value' }],
  ]) {
    await assert.rejects(
      agent.call('fill_form', { tab_id, fields: invalid, description: 'Fill form' }),
      (error) => error.code === 'INVALID_ARGUMENTS' && !JSON.stringify(error.details).includes('private-value'),
    );
  }
  assert.deepEqual(calls, []);
  const result = await agent.call('fill_form', { tab_id, fields, description: 'Fill form' });
  assert.equal(result.completed_count, 2);
  assert.equal(result.fields.length, 2);
  assert.equal(result.snapshot.text, 'Ready');
  assert.deepEqual(calls, [
    { operation: 'type_text', selector: '#name' },
    { operation: 'type_text', selector: '#amount' },
    { operation: 'get_page_snapshot', selector: undefined },
  ]);
  calls.length = 0;
  await assert.rejects(
    agent.call('fill_form', {
      tab_id,
      fields: [fields[0], { selector: '#reject', text: 'private-value' }, fields[1]],
      description: 'Fill form',
    }),
    (error) => {
      assert.equal(error.code, 'OUTCOME_UNKNOWN');
      assert.deepEqual(error.details.fill_progress, { completed_count: 1, field_index: 1, phase: 'fill' });
      assert.deepEqual(error.details.input_state, { value_present: true, value_matches: false });
      assert(!JSON.stringify(error.details).includes('private-value'));
      assert(!JSON.stringify(error.details).includes('must-not-leak'));
      return true;
    },
  );
  assert.deepEqual(calls, [
    { operation: 'type_text', selector: '#name' },
    { operation: 'type_text', selector: '#reject' },
  ]);
  calls.length = 0;
  await agent.call('fill_form', { tab_id, fields, observe: false, description: 'Fill form' });
  assert.equal(calls.length, 2);
});

test('new discovery, formatted verification, short descriptions and batch fill require a capable extension', async (t) => {
  const { extension, agent, tab_id } = await setup(t, '0.9.0.4');
  let commands = 0;
  extension.serve(() => {
    commands++;
    return { typed: true };
  });
  for (const [name, args] of [
    ['find_elements', { text: 'Confirm', description: DESCRIPTION }],
    ['type_text', { selector: '#amount', text: '12', expected_value: '12.00', description: DESCRIPTION }],
    ...['id', 'class', 'type', 'name', 'role'].map((attribute) => [
      'query_all',
      { selector: 'input', fields: { metadata: { selector: ':scope', attribute } }, description: DESCRIPTION },
    ]),
    ['get_page_snapshot', { description: 'Read page' }],
    ['fill_form', { fields: [{ selector: '#amount', text: '12' }], description: DESCRIPTION }],
  ]) {
    await assert.rejects(
      agent.call(name, { tab_id, ...args }),
      (error) =>
        error.code === 'CAPABILITY_UNAVAILABLE' &&
        error.details.required_extension_version === '0.9.0.5' &&
        error.details.dispatch_status === 'not_dispatched',
    );
  }
  assert.equal(commands, 0);
});
