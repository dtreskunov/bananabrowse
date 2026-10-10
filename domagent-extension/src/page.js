// This packaged helper runs in an isolated world. No remote source is evaluated here.
export function pageHelper(operation, args = {}) {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  const handoff = [...document.querySelectorAll(
    'input[type="password"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[data-sitekey]')]
    .some(visible);
  if (handoff) return { error: 'HANDOFF_REQUIRED' };
  if (operation === 'inspect') return { url: location.href };
  const selector = args.selector;
  const element = selector ? document.querySelector(selector) : document.body;
  if (['click', 'type_text', 'get_text'].includes(operation) && !element) {
    return { error: 'TARGET_STALE' };
  }
  if (operation === 'click') {
    const labelControl = element.closest('label')?.control;
    if (!visible(element) || element.matches('input[type="file"],input[type="password"]') ||
        labelControl?.matches('input[type="file"],input[type="password"]')) {
      return { error: 'HANDOFF_REQUIRED' };
    }
    const target = element.closest('a[href]');
    if (target && (target.hasAttribute('download') || target.target === '_blank')) {
      return { error: 'HANDOFF_REQUIRED' };
    }
    element.scrollIntoView({ block: 'center' });
    element.click();
    return { clicked: true };
  }
  if (operation === 'type_text') {
    if (!visible(element) || !element.matches('input,textarea,[contenteditable="true"]') ||
        element.matches('input[type="password"],input[type="file"]')) {
      return { error: 'HANDOFF_REQUIRED' };
    }
    element.focus();
    if (element.isContentEditable) element.textContent = args.text;
    else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, args.text);
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: true };
  }
  if (operation === 'get_text') return { text: (element.innerText || element.textContent || '').slice(0, 200_000) };
  if (operation === 'get_interactive_elements') {
    return { elements: [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
      .filter(visible).slice(0, 500).map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), id: element.id, type: element.getAttribute('type'),
          text: (element.innerText || element.getAttribute('aria-label') || '').slice(0, 500),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }) };
  }
  // Remove only DomAgent's own markers; never guess which site UI is safe to remove.
  if (operation === 'clear_overlays') {
    document.querySelectorAll('[data-domagent-overlay]').forEach(element => element.remove());
    return { cleared: true };
  }
  return { error: 'CAPABILITY_UNAVAILABLE' };
}

// Only injected into MAIN. A CSP denying page eval is an unsupported capability,
// not a reason to fall back to the extension or content-script realm.
export async function pageEvaluate(script) {
  try {
    const result = await (0, eval)(script);
    const json = JSON.stringify(result === undefined ? null : result);
    if (json.length > 4_000_000) return { error: 'RESULT_TOO_LARGE' };
    return { value: JSON.parse(json) };
  } catch {
    return { error: 'CAPABILITY_UNAVAILABLE' };
  }
}
