import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageEvaluate, pageHelper } from '../src/page.js';

test('trusted helper conservatively requests handoff before touching a password/CAPTCHA page', () => {
  const originalDocument = globalThis.document;
  const originalComputed = globalThis.getComputedStyle;
  let modified = false;
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  globalThis.document = {
    querySelectorAll: () => [{ getBoundingClientRect() { return { width: 20, height: 20 }; } }],
    querySelector() { modified = true; },
  };
  try {
    for (const operation of ['inspect', 'click', 'type_text', 'get_text', 'clear_overlays']) {
      assert.deepEqual(pageHelper(operation, { selector: 'input', text: 'private' }), { error: 'HANDOFF_REQUIRED' });
    }
    assert.equal(modified, false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalComputed;
  }
});

test('page eval returns structured data or an explicit unavailable result without privileged fallback', async () => {
  assert.deepEqual(await pageEvaluate('1 + 1'), { value: 2 });
  assert.deepEqual(await pageEvaluate('undefined'), { value: null });
  assert.deepEqual(await pageEvaluate('throw new Error("CSP or runtime failure")'), { error: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await pageEvaluate('({ data: "<script>not markup</script>" })'),
    { value: { data: '<script>not markup</script>' } });
});
