// This packaged helper runs in an isolated world. No remote source is evaluated here.
export function pageHelper(operation, args = {}) {
  const documentKey = '__domagentDocumentNonce';
  if (!globalThis[documentKey]) globalThis[documentKey] = crypto.randomUUID();
  if (args.document_nonce && args.document_nonce !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  const marker = '[data-domagent-sharing]';
  const visible = element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  };
  if (operation === 'inspect') return { url: location.href, document_nonce: globalThis[documentKey] };
  const selector = args.selector;
  let element;
  try {
    element = selector ? document.querySelector(selector) : document.body;
  } catch (error) {
    if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
    throw error;
  }
  if (['click', 'type_text', 'get_text'].includes(operation) && !element) {
    return { error: 'ELEMENT_NOT_FOUND' };
  }
  if (element?.closest(marker)) return { error: 'ELEMENT_NOT_FOUND' };
  if (operation === 'click') {
    const labelControl = element.closest('label')?.control;
    if (!visible(element) || element.matches('input[type="file"]') ||
        labelControl?.matches('input[type="file"]')) {
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
        element.matches('input[type="file"]')) {
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
  if (operation === 'get_text') {
    // Read rendered text in place: detached clones fall back to textContent
    // and expose scripts/hidden text that innerText would omit.
    if (element.querySelector?.(marker)) {
      const read = node => {
        if (node.nodeType === 3) return node.textContent;
        if (node.nodeType !== 1 || node.matches(marker)) return '';
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return '';
        return [...node.childNodes].map(read).join('') +
          (style.display === 'block' || node.tagName === 'BR' ? '\n' : '');
      };
      return { text: read(element).slice(0, 200_000) };
    }
    return { text: (element.innerText || element.textContent || '').slice(0, 200_000) };
  }
  if (operation === 'get_interactive_elements') {
    return { elements: [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
      .filter(element => !element.closest(marker) && visible(element)).slice(0, 500).map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName.toLowerCase(), id: element.id, type: element.getAttribute('type'),
          text: (element.innerText || element.getAttribute('aria-label') || '').slice(0, 500),
          x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }) };
  }
  // Remove only DomAgent's own markers; never guess which site UI is safe to remove.
  if (operation === 'clear_overlays') {
    document.querySelectorAll('[data-domagent-overlay]').forEach(element => {
      if (!element.closest(marker) && !element.querySelector(marker)) element.remove();
    });
    return { cleared: true };
  }
  return { error: 'CAPABILITY_UNAVAILABLE' };
}

export function sharingIndicator(details) {
  const old = document.querySelector('[data-domagent-sharing]');
  if (!details) { old?.remove(); return { url: location.href }; }
  if (details.remove) {
    if (old?.getAttribute('data-domagent-sharing') === details.token) old.remove();
    return { url: location.href };
  }
  old?.remove();
  const host = document.createElement('div');
  host.setAttribute('data-domagent-sharing', details.token);
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;border:4px solid #ffb000!important;box-sizing:border-box!important;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{color-scheme:light}div{position:absolute;top:4px;right:12px;max-width:min(90vw,440px);padding:8px 12px;background:#17202a;color:#fff;border:2px solid #ffb000;border-radius:6px;font:14px/1.5 system-ui;pointer-events:auto;box-shadow:0 2px 8px #0008}button{margin-left:10px;padding:6px 10px;background:#fff;color:#17202a;border:0;border-radius:4px;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #ffb000}';
  const banner = document.createElement('div');
  banner.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = `${details.label} can use this tab.`;
  banner.append(label);
  const api = typeof browser === 'undefined' ? chrome : browser;
  // Capture the isolated-world runtime method, never a page-world bridge.
  const send = api.runtime.sendMessage.bind(api.runtime);
  const add = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', event => {
      // Page scripts can reach this cosmetic DOM, but cannot supply a user gesture.
      if (action !== 'stop' && !event.isTrusted) return;
      button.disabled = true;
      send({ type: action === 'stop' ? 'page.stop' : 'page.decision',
        target_id: details.target_id, token: details.token,
        request_id: details.command?.request_id, action })
        .then(response => { if (!response?.ok) button.disabled = false; })
        .catch(() => { button.disabled = false; });
    });
    banner.append(button);
  };
  if (details.command) {
    const description = document.createElement('p');
    description.textContent = `${details.command.operation}: ${details.command.description}`;
    banner.append(description);
    if (details.command.state === 'pending') {
      if (details.command.operation === 'request_handoff') {
        add('Done', 'done');
        add('Cancel', 'decline');
      } else {
        add('Approve', 'approve');
        add('Decline', 'decline');
        add('Allow all while sharing', 'allow_all');
      }
    } else {
      const waiting = document.createElement('p');
      waiting.textContent = details.command.state === 'executing' ? 'Action running…' : 'Approved; waiting for service…';
      banner.append(waiting);
    }
  }
  add('Stop sharing', 'stop');
  root.append(style, banner);
  document.documentElement.append(host);
  return { url: location.href };
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
