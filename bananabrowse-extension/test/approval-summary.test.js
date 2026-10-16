import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionSummary } from '../src/approval-summary.js';

test('operation-derived summaries remain informative and redact values regardless of explanation length', () => {
  const args = { selector: '#account', text: 'private-entry' };
  const page = { url: 'https://site.example/account', title: 'Account' };
  const target = { role: 'textbox', name: 'Nickname', state: 'ready' };
  const summary = actionSummary('type_text', args, page, target);
  assert(summary.includes('Operation: type_text'));
  assert(summary.some((line) => line.includes('#account')));
  assert(summary.some((line) => line.includes('Nickname')));
  assert.equal(summary.join(' ').includes('private-entry'), false);
  assert(summary.some((line) => line.includes('value hidden')));
  assert(
    actionSummary('evaluate_script', { script: 'private script' }).some((line) => line.includes('May read or change')),
  );
  assert(!actionSummary('evaluate_script', { script: 'private script' }).join(' ').includes('private script'));
  assert(
    actionSummary('navigate', { url: 'https://site.example/checkout' }).includes(
      'Destination: https://site.example/checkout',
    ),
  );
});
