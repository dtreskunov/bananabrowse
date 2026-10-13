import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScriptSource } from '../src/script-source.js';

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
  assert.throws(() => compileScriptSource('return 42'), SyntaxError);
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
