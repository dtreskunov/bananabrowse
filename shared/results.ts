import {
  DEFAULT_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  DEFAULT_TEXT_CHARS,
  DEFAULT_ELEMENTS,
  MAX_TEXT_CHARS,
  MAX_ELEMENTS,
  QUERY_FIELD_PATTERN,
} from './protocol.js';
import type { QueryAllResult, Wire } from './protocol.js';

function failure(code: string, details: Wire = {}): never {
  throw Object.assign(new Error(code), { code, ...details });
}

export function textResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  const text = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined, functions and symbols despite its declared type.
  if ((text as string | undefined) === undefined) failure('INVALID_RESULT');
  return { content: [{ type: 'text', text }] };
}

export function resultBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(textResult(value))).length;
}

function prefix(text: string, length: number): string {
  const end = Math.min(length, text.length);
  return text.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end);
}

export function queryResult(value: unknown): QueryAllResult {
  const input = value as QueryAllResult | null;
  const fieldName = new RegExp(QUERY_FIELD_PATTERN);
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.document !== 'string' ||
    !input.document.length ||
    input.document.length > 128 ||
    input.scope !== 'top-level-and-open-shadow-roots' ||
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > MAX_ELEMENTS ||
    !Number.isSafeInteger(input.matched_count) ||
    input.matched_count < input.rows.length ||
    input.matched_count > 20_000 ||
    input.returned_count !== input.rows.length ||
    input.rows_truncated !== input.matched_count > input.rows.length ||
    !Array.isArray(input.field_issues) ||
    input.field_issues.length > input.rows.length * 20 ||
    input.rows.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length < 1 ||
        Object.keys(row).length > 20 ||
        Object.entries(row).some(
          ([key, field]) => !fieldName.test(key) || (field !== null && typeof field !== 'string'),
        ),
    ) ||
    input.field_issues.some(
      (issue) =>
        !issue ||
        !Number.isSafeInteger(issue.row) ||
        issue.row < 0 ||
        issue.row >= input.rows.length ||
        !Object.hasOwn(input.rows[issue.row]!, issue.field) ||
        !['missing', 'redacted', 'text_truncated', 'unsupported_url'].includes(issue.reason),
    ) ||
    input.truncated !== (input.rows_truncated || input.field_issues.some((issue) => issue.reason === 'text_truncated'))
  )
    failure('INVALID_RESULT');
  return input;
}

export function compactResult(operation: string, value: unknown, args: Wire = {}): unknown {
  const maximum = operation === 'inspect_element' ? 4096 : MAX_OUTPUT_BYTES;
  const limit = args.max_output_bytes ?? (operation === 'inspect_element' ? 4096 : DEFAULT_OUTPUT_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > maximum) failure('INVALID_ARGUMENT');
  if (operation === 'query_all') {
    const input = queryResult(value);
    if (args.return_as === 'artifact') return input;
    const rowLimit = args.limit ?? DEFAULT_ELEMENTS;
    if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_ELEMENTS) failure('INVALID_ARGUMENT');
    const out: QueryAllResult = {
      ...input,
      rows: input.rows.slice(0, rowLimit),
      field_issues: input.field_issues.filter((issue) => issue.row < rowLimit),
    };
    const update = () => {
      out.returned_count = out.rows.length;
      out.rows_truncated = out.matched_count > out.rows.length;
      out.truncated = out.rows_truncated || out.field_issues.some((issue) => issue.reason === 'text_truncated');
    };
    update();
    while (out.rows.length > 1 && resultBytes(out) > limit) {
      out.rows.pop();
      out.field_issues = out.field_issues.filter((issue) => issue.row < out.rows.length);
      update();
    }
    const bytes = resultBytes(out);
    if (bytes > limit) failure('RESULT_TOO_LARGE', { actual_bytes: bytes, limit_bytes: limit });
    return out;
  }
  let result: unknown = value;
  const hasText = ['get_text', 'get_page_snapshot'].includes(operation);
  const hasElements = ['get_interactive_elements', 'get_page_snapshot'].includes(operation);
  const textLimit = args.max_text_chars ?? DEFAULT_TEXT_CHARS;
  const elementLimit = args.max_elements ?? DEFAULT_ELEMENTS;
  if (
    (hasText && (!Number.isSafeInteger(textLimit) || textLimit < 0 || textLimit > MAX_TEXT_CHARS)) ||
    (hasElements && (!Number.isSafeInteger(elementLimit) || elementLimit < 1 || elementLimit > MAX_ELEMENTS))
  ) {
    failure('INVALID_ARGUMENT');
  }
  if (hasText || hasElements) {
    const input = value as Wire;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (hasText && typeof input.text !== 'string') ||
      (hasElements && !Array.isArray(input.elements))
    )
      failure('INVALID_RESULT');
    const out: Wire = { ...input, truncated: input.truncated === true };
    result = out;
    if (hasText) {
      out.text = prefix(input.text, textLimit);
      out.truncated ||= out.text.length < input.text.length;
      out.text_truncated = input.text_truncated === true || out.text.length < input.text.length;
    }
    if (hasElements) {
      out.elements = input.elements.slice(0, elementLimit);
      out.truncated ||= out.elements.length < input.elements.length;
      out.elements_truncated = input.elements_truncated === true || out.elements.length < input.elements.length;
    }
    // Trim only complete rows/text, never arbitrary JSON or mutation receipts.
    while (resultBytes(out) > limit && hasElements && out.elements.length) {
      out.elements.pop();
      out.elements_truncated = out.truncated = true;
    }
    if (resultBytes(out) > limit && hasText && out.text.length) {
      const original = out.text;
      let low = 0,
        high = original.length;
      out.text_truncated = out.truncated = true;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        out.text = prefix(original, middle);
        if (resultBytes(out) <= limit) low = middle;
        else high = middle - 1;
      }
      out.text = prefix(original, low);
    }
  }
  const bytes = resultBytes(result);
  if (bytes > limit) failure('RESULT_TOO_LARGE', { actual_bytes: bytes, limit_bytes: limit });
  return result;
}
