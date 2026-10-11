import {
  DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, DEFAULT_TEXT_CHARS, DEFAULT_ELEMENTS, MAX_TEXT_CHARS, MAX_ELEMENTS,
} from './protocol.js';

function failure(code) {
  throw Object.assign(new Error(code), { code });
}

export function textResult(value) {
  const text = JSON.stringify(value);
  if (text === undefined) failure('INVALID_RESULT');
  return { content: [{ type: 'text', text }] };
}

export function resultBytes(value) {
  return new TextEncoder().encode(JSON.stringify(textResult(value))).length;
}

function prefix(text, length) {
  const end = Math.min(length, text.length);
  return text.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end);
}

export function compactResult(operation, value, args = {}) {
  const maximum = operation === 'inspect_element' ? 4096 : MAX_OUTPUT_BYTES;
  const limit = args.max_output_bytes ?? (operation === 'inspect_element' ? 4096 : DEFAULT_OUTPUT_BYTES);
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > maximum) failure('INVALID_ARGUMENT');
  let result = value;
  const hasText = ['get_text', 'get_page_snapshot'].includes(operation);
  const hasElements = ['get_interactive_elements', 'get_page_snapshot'].includes(operation);
  const textLimit = args.max_text_chars ?? DEFAULT_TEXT_CHARS;
  const elementLimit = args.max_elements ?? DEFAULT_ELEMENTS;
  if ((hasText && (!Number.isSafeInteger(textLimit) || textLimit < 0 || textLimit > MAX_TEXT_CHARS)) ||
      (hasElements && (!Number.isSafeInteger(elementLimit) || elementLimit < 1 || elementLimit > MAX_ELEMENTS))) {
    failure('INVALID_ARGUMENT');
  }
  if (hasText || hasElements) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (hasText && typeof value.text !== 'string') ||
        (hasElements && !Array.isArray(value.elements))) failure('INVALID_RESULT');
    result = { ...value, truncated: value.truncated === true };
    if (hasText) {
      result.text = prefix(value.text, textLimit);
      result.truncated ||= result.text.length < value.text.length;
      result.text_truncated = value.text_truncated === true || result.text.length < value.text.length;
    }
    if (hasElements) {
      result.elements = value.elements.slice(0, elementLimit);
      result.truncated ||= result.elements.length < value.elements.length;
      result.elements_truncated = value.elements_truncated === true || result.elements.length < value.elements.length;
    }
    // Trim only complete rows/text, never arbitrary JSON or mutation receipts.
    while (resultBytes(result) > limit && hasElements && result.elements.length) {
      result.elements.pop();
      result.elements_truncated = result.truncated = true;
    }
    if (resultBytes(result) > limit && hasText && result.text.length) {
      const original = result.text;
      let low = 0, high = original.length;
      result.text_truncated = result.truncated = true;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        result.text = prefix(original, middle);
        if (resultBytes(result) <= limit) low = middle;
        else high = middle - 1;
      }
      result.text = prefix(original, low);
    }
  }
  if (resultBytes(result) > limit) failure('RESULT_TOO_LARGE');
  return result;
}
