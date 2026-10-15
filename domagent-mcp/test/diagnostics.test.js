import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentDiagnostics, diagnosticDetails, sanitizeDiagnostics } from '../../shared/diagnostics.js';
import { errorDetails } from '../../shared/protocol.js';

test('beta7 diagnosticDetails returns the spread wrapper with complete stack/cause/native exception', () => {
  const cause = new TypeError('native browser exception');
  const error = new Error('execution failed', { cause });
  error.exception = { name: 'DOMException', message: 'SecurityError', stack: 'native frame\n  execute at line 12' };
  error.exceptionDetails = { lineNumber: 12, columnNumber: 9, exception: { description: 'Native detail' } };
  const { diagnostics } = diagnosticDetails(error, { layer: 'browser', phase: 'execution', execution_world: 'MAIN' });
  assert.equal(diagnostics.name, 'Error');
  assert.equal(diagnostics.message, error.message);
  assert.equal(diagnostics.stack, error.stack);
  assert.equal(diagnostics.cause.name, 'TypeError');
  assert.equal(diagnostics.cause.stack, cause.stack);
  assert.deepEqual(diagnostics.exception, error.exception);
  assert.deepEqual(diagnostics.exceptionDetails, error.exceptionDetails);
  assert.equal(diagnostics.layer, 'browser');
  assert.equal(diagnostics.execution_world, 'MAIN');
});

test('beta7 browser-provided diagnostics take precedence and remain safe to spread', () => {
  const original = { name: 'SyntaxError', message: 'Native parse failure', stack: 'full\nstack', cause: { message: 'nested' } };
  const result = diagnosticDetails({ message: 'do not use', diagnostics: original }, { execution_world: 'USER_SCRIPT' });
  assert.deepEqual(result, { diagnostics: { ...original, execution_world: 'USER_SCRIPT' } });
  assert.notEqual(result.diagnostics, original);
  for (const value of [null, false, '', [], 1, undefined]) assert.equal(sanitizeDiagnostics(value), undefined);
  assert.equal(sanitizeDiagnostics({}), undefined);
});

test('beta7 outer extension context cannot overwrite native diagnostic origin', () => {
  const error = new SyntaxError('native execution failed');
  assert.deepEqual(JSON.parse(JSON.stringify(error)), {});
  const native = diagnosticDetails(error, { layer: 'browser', phase: 'execution', execution_world: 'MAIN' });
  const wrapper = new Error('outer extension wrapper');
  wrapper.diagnostics = native.diagnostics;
  const result = diagnosticDetails(wrapper, { layer: 'extension', phase: 'dispatch', execution_world: 'USER_SCRIPT' });
  assert.deepEqual(result, native);
  assert.equal(result.diagnostics.name, 'SyntaxError');
  assert.equal(result.diagnostics.message, error.message);
  assert.equal(result.diagnostics.stack, error.stack);
});

test('beta7 diagnostics redact credentials, cookie/auth headers and arbitrary URL secrets', () => {
  const sentinel = 'superSecretCredential';
  const input = {
    message: `Failed https://user:${sentinel}@page.test/path?unexpected=${sentinel}#${sentinel}`,
    stack: `Error: request\n at https://page.test/app.js?access_token=${sentinel}:12:3`,
    cause: { message: `Bearer ${sentinel}\nCookie: session=${sentinel}\npassword="${sentinel}" token=${sentinel}`,
      quotedHeaders: `{"Authorization":"${sentinel}","Cookie":"${sentinel}"}` },
    native: { Authorization: sentinel, 'Set-Cookie': sentinel, cookie: { nested: sentinel },
      api_key: sentinel, clientKey: sentinel, headers: [{ name: 'Authorization', value: sentinel }],
      url: `https://page.test/token/${sentinel}`, ok: 'useful detail' },
  };
  const result = sanitizeDiagnostics(input), serialized = JSON.stringify(result);
  assert(!serialized.includes(sentinel));
  assert(!serialized.includes('https://user:'));
  assert(serialized.includes('redacted'));
  assert.equal(result.native.ok, 'useful detail');
  assert.equal(result.native.headers[0].value, '[redacted]');
  assert.deepEqual(input.native.headers[0], { name: 'Authorization', value: sentinel });
});

test('beta7 native diagnostics bound strings, depth, entries, cycles and getters explicitly', () => {
  const input = { name: 'NativeError', stack: 'frame\n'.repeat(10000), details: {} };
  input.details.self = input;
  let nested = input.details;
  for (let index = 0; index < 20; index++) nested = nested.child = {};
  input.native = Array.from({ length: 1000 }, () => ({ message: 'x'.repeat(6000) }));
  Object.defineProperty(input, 'getter', { enumerable: true, get() { throw new Error('must not run'); } });
  const result = sanitizeDiagnostics(input);
  assert.equal(result.truncated, true);
  assert(result.truncation_reasons.includes('string'));
  assert(result.truncation_reasons.includes('depth'));
  assert(result.truncation_reasons.includes('cycle'));
  assert(JSON.stringify(result).length < 40000);
  assert(result.stack.endsWith('[truncated]'));
  assert(!Object.hasOwn(result, 'getter'));
  const many = sanitizeDiagnostics({ values: Array.from({ length: 100 }, (_, i) => i) });
  assert.equal(many.values.length, 32);
  assert(many.truncation_reasons.includes('entries'));
  const polluted = sanitizeDiagnostics(JSON.parse('{"__proto__":{"polluted":true},"message":"safe"}'));
  assert.deepEqual(polluted, { message: 'safe' });
  assert.equal({}.polluted, undefined);
});

test('agent-facing diagnostics drop stacks, causes and native objects and bound messages', () => {
  const error = new Error('x'.repeat(2000), { cause: new TypeError('inner') });
  error.exception = { name: 'DOMException', message: 'SecurityError', stack: 'native frame' };
  const { diagnostics } = diagnosticDetails(error, { layer: 'browser', phase: 'execution', execution_world: 'MAIN' });
  const compact = agentDiagnostics(diagnostics);
  assert.deepEqual(Object.keys(compact).sort(), ['execution_world', 'layer', 'message', 'name', 'phase']);
  assert(compact.message.length <= 520);
  assert(!JSON.stringify(compact).includes('native frame'));
  assert.equal(agentDiagnostics(undefined), undefined);
});

test('errorDetails projects only whitelisted, well-formed details per code', () => {
  assert.deepEqual(errorDetails({ code: 'ELEMENT_STALE', stale_reason: 'ref_superseded', current_document: 'abcdef0123',
    snapshot_document: 'not hex!', extra: 'x' }), { stale_reason: 'ref_superseded', current_document: 'abcdef0123' });
  assert.deepEqual(errorDetails({ code: 'ELEMENT_STALE', stale_reason: 'made_up' }), {});
  assert.deepEqual(errorDetails({ code: 'RESULT_TOO_LARGE', actual_bytes: 10, limit_bytes: 5 }), { actual_bytes: 10, limit_bytes: 5 });
  assert.deepEqual(errorDetails({ code: 'SCRIPT_SYNTAX_ERROR', line: 2, column: 11, snippet: 'const b = ;' }),
    { line: 2, column: 11, snippet: 'const b = ;' });
  assert.deepEqual(errorDetails({ code: 'SCRIPT_RUNTIME_ERROR', line: -1, snippet: 'x'.repeat(301) }), {});
  assert.deepEqual(errorDetails({ code: 'ELEMENT_NOT_FOUND', line: 3 }), {});
});
