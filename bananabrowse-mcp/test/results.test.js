import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactResult, resultBytes, textResult } from '../../shared/results.js';
import { DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES } from '../../shared/protocol.js';

test('text is compact by default and truncation is never silently hidden', () => {
  const result = compactResult('get_text', { text: 'x'.repeat(200_000) });
  assert.equal(result.text.length, 4000);
  assert.equal(result.truncated, true);
  assert.equal(result.text_truncated, true);
  assert(resultBytes(result) <= DEFAULT_OUTPUT_BYTES);
  assert.equal(compactResult('get_text', { text: 'small', truncated: true }).truncated, true);
  assert.equal(compactResult('get_text', { text: 'small' }).truncated, false);
});

test('UTF-8 budgets include MCP JSON escaping and never split a surrogate pair', () => {
  for (const text of ['😀'.repeat(100_000), '\u0001"\\\n'.repeat(100_000), '界'.repeat(100_000)]) {
    for (const max_output_bytes of [1024, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES]) {
      const result = compactResult('get_text', { text }, { max_output_bytes, max_text_chars: 16_000 });
      const wire = JSON.stringify(textResult(result));
      assert(Buffer.byteLength(wire) <= max_output_bytes);
      assert.equal(result.truncated, true);
      assert.equal(result.text_truncated, true);
      assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/);
    }
  }
});

test('snapshot/list limits preserve document identity and whole rows with explicit truncation', () => {
  const elements = Array.from({ length: 500 }, (_, i) => ({ ref: `e${i + 1}`, name: '😀'.repeat(500) }));
  const snapshot = { document: 'document-one', url: 'https://site.example/', text: 'x'.repeat(10_000), elements };
  const result = compactResult('get_page_snapshot', snapshot);
  assert(resultBytes(result) <= DEFAULT_OUTPUT_BYTES);
  assert.equal(result.document, 'document-one');
  assert(result.elements.length <= 50);
  assert.equal(result.elements_truncated, true);
  assert.equal(result.text_truncated, true);
  assert.equal(snapshot.elements.length, 500);
  const small = compactResult('get_interactive_elements', { elements: [{ ref: 'e1' }] });
  assert.equal(small.truncated, false);
  assert.deepEqual(small.elements, [{ ref: 'e1' }]);
});

test('query_all budgets preserve complete rows, field issues and honest counts', () => {
  const rows = Array.from({ length: 10 }, () => ({ title: '😀"\\\n'.repeat(20), price: null }));
  const input = {
    document: 'fixture-document',
    scope: 'top-level-and-open-shadow-roots',
    rows,
    matched_count: 12,
    returned_count: 10,
    rows_truncated: true,
    field_issues: rows.map((_, row) => ({ row, field: 'price', reason: 'missing' })),
    truncated: true,
  };
  for (const max_output_bytes of [1024, 4096, DEFAULT_OUTPUT_BYTES]) {
    const output = compactResult('query_all', input, { max_output_bytes });
    assert(resultBytes(output) <= max_output_bytes);
    assert(output.rows.length > 0);
    assert.equal(output.returned_count, output.rows.length);
    assert.equal(output.matched_count, 12);
    assert.equal(output.rows_truncated, true);
    assert.equal(output.truncated, true);
    assert.deepEqual(output.rows, rows.slice(0, output.rows.length));
    assert(output.field_issues.every((issue) => issue.row < output.rows.length));
  }
  assert.equal(input.rows.length, 10);
  assert.equal(input.field_issues.length, 10);
  const limited = compactResult('query_all', input, { limit: 2 });
  assert.equal(limited.returned_count, 2);
  assert.deepEqual(
    limited.field_issues.map((issue) => issue.row),
    [0, 1],
  );
  const enormous = { ...input, rows: [{ title: 'x'.repeat(70000) }], returned_count: 1, field_issues: [] };
  assert.throws(() => compactResult('query_all', enormous), /RESULT_TOO_LARGE/);
  assert.deepEqual(compactResult('query_all', enormous, { return_as: 'artifact' }), enormous);
  for (const value of [
    null,
    { ...input, returned_count: 9 },
    { ...input, field_issues: [{ row: 10, field: 'price', reason: 'missing' }] },
    { ...input, rows: [{ title: 1 }], returned_count: 1, field_issues: [] },
  ])
    assert.throws(() => compactResult('query_all', value), /INVALID_RESULT/);
});

test('script/mutation values are never truncated into a success-shaped partial result', () => {
  for (const max_output_bytes of [DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES]) {
    const overhead = resultBytes({ value: '' });
    const exact = { value: 'x'.repeat(max_output_bytes - overhead) };
    assert.equal(resultBytes(exact), max_output_bytes);
    assert.deepEqual(compactResult('evaluate_script', exact, { max_output_bytes }), exact);
    assert.throws(
      () => compactResult('evaluate_script', { value: exact.value + 'x' }, { max_output_bytes }),
      /RESULT_TOO_LARGE/,
    );
  }
  for (const operation of ['evaluate_script', 'click', 'list_browser_targets']) {
    assert.throws(() => compactResult(operation, { value: 'x'.repeat(100_000) }), /RESULT_TOO_LARGE/);
  }
  const value = { value: 'x'.repeat(20_000) };
  assert.throws(() => compactResult('evaluate_script', value), /RESULT_TOO_LARGE/);
  assert.deepEqual(compactResult('evaluate_script', value, { max_output_bytes: MAX_OUTPUT_BYTES }), value);
  for (const limit of [0, 1023, MAX_OUTPUT_BYTES + 1, NaN, '16384']) {
    assert.throws(() => compactResult('get_text', { text: 'small' }, { max_output_bytes: limit }), /INVALID_ARGUMENT/);
  }
  assert.throws(() => compactResult('get_text', { text: 12 }), /INVALID_RESULT/);
  assert.throws(() => compactResult('get_text', { text: 'small' }, { max_text_chars: 16001 }), /INVALID_ARGUMENT/);
  assert.throws(
    () => compactResult('get_interactive_elements', { elements: [] }, { max_elements: 101 }),
    /INVALID_ARGUMENT/,
  );
  assert.throws(() => compactResult('click', undefined), /INVALID_RESULT/);
  assert.throws(() => compactResult('get_page_snapshot', { text: 'small', elements: null }), /INVALID_RESULT/);
  assert.throws(
    () => compactResult('get_text', { text: 'small', unexpected: 'x'.repeat(100_000) }),
    /RESULT_TOO_LARGE/,
  );
});
