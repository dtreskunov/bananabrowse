import { parse } from 'acorn';

const MAX_SNIPPET = 300;
const TOP_LEVEL = { allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };

function snippetAt(script, line) {
  const text = String(script).split('\n')[line - 1];
  return typeof text === 'string' ? text.trim().slice(0, MAX_SNIPPET) : undefined;
}

/** Attach 1-based script line/column (and the offending line) to an error. */
export function locateScriptError(error, script, line, column) {
  if (!Number.isSafeInteger(line) || line < 1) return error;
  const snippet = snippetAt(script, line);
  return Object.assign(error, { line, ...(Number.isSafeInteger(column) && column > 0 ? { column } : {}),
    ...(snippet ? { snippet } : {}) });
}

/**
 * Locate the first frame of the wrapped script in a native stack, translated back to a
 * script line. Columns are omitted: wrapper text shifts them on the first and last lines.
 */
export function stackLocation(stack, marker, lineOffset = 0) {
  if (typeof stack !== 'string' || typeof marker !== 'string') return null;
  const escaped = marker.replace(/[^0-9A-Za-z-]/g, '');
  const match = new RegExp(`domagent-script-${escaped}\\.js:(\\d+):(\\d+)`).exec(stack);
  if (!match) return null;
  const line = Number(match[1]) - lineOffset;
  return line >= 1 ? { line } : null;
}

/**
 * Parse page script. Plain scripts keep their exact semantics; scripts that only
 * parse with top-level await/return are wrapped in an async function whose
 * final expression statement becomes the return value.
 */
function parseScript(script) {
  try {
    return { program: parse(script, { ecmaVersion: 'latest', sourceType: 'script' }), async: false };
  } catch (error) {
    try {
      return { program: parse(script, { ecmaVersion: 'latest', sourceType: 'script', ...TOP_LEVEL }), async: true };
    } catch {
      // Report the original error; acorn columns are 0-based.
      throw locateScriptError(error, script, error.loc?.line, (error.loc?.column ?? -1) + 1);
    }
  }
}

function asyncBody(script, program) {
  const last = program.body.at(-1);
  // No newline after the opening brace keeps script line numbers unchanged.
  if (last?.type === 'ExpressionStatement') {
    return '(async () => {' + script.slice(0, last.start) +
      `return (${script.slice(last.expression.start, last.expression.end)});` + script.slice(last.end) + '\n})()';
  }
  return `(async () => {${script}\n})()`;
}

/** Source for the Chrome CDP MAIN-world path, which awaits a final promise itself. */
export function prepareEvaluateExpression(script) {
  const marker = crypto.randomUUID();
  let parsed = null;
  try { parsed = parseScript(script); } catch { parsed = null; }
  // When acorn rejects the source, let V8 report its own syntax error.
  const body = parsed?.async ? asyncBody(script, parsed.program) : script;
  return { expression: `${body}\n//# sourceURL=domagent-script-${marker}.js`, marker, async: !!parsed?.async };
}

export function compileScriptSource(script) {
  const { program, async } = parseScript(script);
  const strict = program.body.some(statement => statement.directive === 'use strict');
  const marker = crypto.randomUUID();
  const prefix = strict ? '"use strict";\n' : '';
  const capture = `(function capture(error, depth) {
      const details = { name: "Error", message: "", stack: "" };
      for (const field of ["name", "message", "stack", "fileName", "lineNumber", "columnNumber"]) {
        try {
          const value = error?.[field];
          if (typeof value === "string") {
            const maximum = field === "stack" ? 8192 : 4096;
            details[field] = value.slice(0, maximum);
            if (value.length > maximum) details.truncated = true;
          } else if (typeof value === "number" && Number.isFinite(value)) details[field] = value;
        } catch {
          (details.unavailable_fields ||= []).push(field);
        }
      }
      if (typeof error === "string") details.message = error.slice(0, 4096);
      try {
        if (error?.cause !== undefined) {
          if (depth < 3) details.cause = capture(error.cause, depth + 1).details;
          else details.truncated = true;
        }
      } catch { (details.unavailable_fields ||= []).push("cause"); }
      return { __domagent_script_failure: ${JSON.stringify(marker)}, details };
    })`;
  const last = program.body.at(-1);
  let body = script;
  const settle = expression => `Promise.resolve((${expression})).then(value => {
        if (["function", "symbol", "bigint"].includes(typeof value)) {
          const failure = ${capture}(new TypeError("Script result cannot be serialized as JSON."), 0);
          failure.serialization_error = true;
          return failure;
        }
        return value;
      }, error => ${capture}(error, 0));`;
  if (async) body = settle(asyncBody(script, program));
  else if (last?.type === 'ExpressionStatement') {
    body = script.slice(0, last.start) + settle(script.slice(last.expression.start, last.expression.end)) +
      script.slice(last.end);
  }
  const code = `${prefix}try {\n${body}\n} catch (__domagent_exception) {
    ${capture}(__domagent_exception, 0);
  }\n//# sourceURL=domagent-script-${marker}.js`;
  return { code, marker, async, wrapper_line_offset: strict ? 2 : 1 };
}
