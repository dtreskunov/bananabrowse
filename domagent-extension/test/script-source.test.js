import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScriptSource, prepareEvaluateExpression, stackLocation } from '../src/script-source.js';

test('browser-compiled source preserves expression, statement and async values without page eval', async () => {
  for (const [script, expected] of [
    ['1 + 1', 2], ['const value = 40; value + 2', 42], ['Promise.resolve(42)', 42],
    ['(() => ({ value: 42 }))()', { value: 42 }],
  ]) {
    const compiled = compileScriptSource(script);
    assert(!compiled.code.includes('eval('));
    const result = await runInNewContext(compiled.code);
    assert.equal(JSON.stringify(result), JSON.stringify(expected));
  }
  const context = {};
  await runInNewContext(compileScriptSource('var exposed = 42; globalThis.exposed').code, context);
  assert.equal(context.exposed, 42);
  assert.equal(compileScriptSource('1 + 1').async, false);
});

test('top-level await and return run in an async wrapper that preserves script lines', async () => {
  for (const [script, expected] of [
    ['return 42', 42], ['const r = await Promise.resolve(41);\nr + 1', 42],
    ['await null; return { a: 1 }', { a: 1 }], ['"use strict";\nconst v = await 5; v', 5],
    ['await 0;\nconst x = 1;\n// trailing comment', null],
  ]) {
    const compiled = compileScriptSource(script);
    assert.equal(compiled.async, true);
    assert.equal(JSON.stringify((await runInNewContext(compiled.code)) ?? null), JSON.stringify(expected));
    const prepared = prepareEvaluateExpression(script);
    assert.equal(prepared.async, true);
    assert.equal(JSON.stringify((await runInNewContext(prepared.expression)) ?? null), JSON.stringify(expected));
  }
  const plain = prepareEvaluateExpression('const a = 1; a');
  assert.equal(plain.async, false);
  assert(plain.expression.startsWith('const a = 1; a\n//# sourceURL=domagent-script-'));
  const compiled = compileScriptSource('await 0;\nconst a = 1;\nnull.boom');
  const failure = await runInNewContext(compiled.code);
  assert.equal(failure.details.name, 'TypeError');
  assert.deepEqual(stackLocation(failure.details.stack, compiled.marker, compiled.wrapper_line_offset), { line: 3 });
  assert.equal(stackLocation('no frames', compiled.marker, 1), null);
});

test('syntax errors carry 1-based line, column and the offending line', () => {
  assert.throws(() => compileScriptSource('const a = 1;\nconst b = ;\n'), error =>
    error.name === 'SyntaxError' && error.line === 2 && error.column === 11 && error.snippet === 'const b = ;');
  assert.equal(prepareEvaluateExpression('const = ;').async, false);
});

test('native exception details are serialized before browser cloning, including rejected final promises', async () => {
  for (const script of ['throw new Error("Synchronous failure")', 'Promise.reject(new Error("Asynchronous failure"))']) {
    const compiled = compileScriptSource(script);
    const result = await runInNewContext(compiled.code);
    assert.equal(result.__domagent_script_failure, compiled.marker);
    assert.equal(result.details.name, 'Error');
    assert(result.details.stack.includes('failure'));
  }
  const strict = compileScriptSource('"use strict"; accidentalGlobal = 1');
  const result = await runInNewContext(strict.code);
  assert.equal(result.details.name, 'ReferenceError');
});

test('unsupported primitive/function results fail explicitly before native result cloning', async () => {
  for (const script of ['() => 1', 'Symbol("fixture")', '1n']) {
    const compiled = compileScriptSource(script);
    const result = await runInNewContext(compiled.code);
    assert.equal(result.__domagent_script_failure, compiled.marker);
    assert.equal(result.serialization_error, true);
    assert.equal(result.details.name, 'TypeError');
  }
});
