import { parse } from 'acorn';

export function compileScriptSource(script) {
  const program = parse(script, { ecmaVersion: 'latest', sourceType: 'script' });
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
  if (last?.type === 'ExpressionStatement') {
    const expression = script.slice(last.expression.start, last.expression.end);
    body = script.slice(0, last.start) +
      `Promise.resolve((${expression})).then(value => {
        if (["function", "symbol", "bigint"].includes(typeof value)) {
          const failure = ${capture}(new TypeError("Script result cannot be serialized as JSON."), 0);
          failure.serialization_error = true;
          return failure;
        }
        return value;
      }, error => ${capture}(error, 0));` +
      script.slice(last.end);
  }
  const code = `${prefix}try {\n${body}\n} catch (__domagent_exception) {
    ${capture}(__domagent_exception, 0);
  }\n//# sourceURL=domagent-script-${marker}.js`;
  return { code, marker, wrapper_line_offset: strict ? 2 : 1 };
}
