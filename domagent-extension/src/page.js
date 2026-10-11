// This packaged helper runs in an isolated world. No remote source is evaluated here.
export function pageHelper(operation, args = {}) {
  const documentKey = '__domagentDocumentNonce';
  if (!globalThis[documentKey]) globalThis[documentKey] = crypto.randomUUID();
  if (args.document_nonce && args.document_nonce !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  if (args.document && args.document !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  if (operation === 'inspect') return { url: location.href, document_nonce: globalThis[documentKey] };
  const state = globalThis.__domagentPageRefs ||= { entries: new Map(), next: 1 };
  const marker = '[data-domagent-sharing]';
  const parent = node => node.parentElement || node.getRootNode()?.host;
  const ignored = element => {
    for (let node = element; node; node = parent(node)) {
      if (node.matches(marker)) return true;
    }
    return false;
  };
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return false;
    for (let node = element; node; node = parent(node)) {
      if (getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  };
  const textOf = (element, limit = 10_000, redactEditable = false) => {
    let remaining = limit;
    const read = node => {
      if (remaining <= 0) return '';
      if (node.nodeType === 3) {
        const value = node.textContent.slice(0, remaining);
        remaining -= value.length;
        return value;
      }
      if (node.nodeType !== 1 || ignored(node) || (redactEditable && node.isContentEditable) ||
          node.matches('script,style,noscript,input,textarea,select')) return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
      const assigned = node.assignedNodes?.({ flatten: true });
      const children = assigned?.length ? assigned : (node.shadowRoot || node).childNodes;
      return [...children].map(read).join('') +
        (style.display === 'block' || node.tagName === 'BR' ? '\n' : '');
    };
    return read(element).trim().slice(0, limit);
  };
  const roots = [document];
  const all = [];
  const needsTree = !args.ref && (args.selector ||
    ['get_page_snapshot', 'get_interactive_elements', 'clear_overlays'].includes(operation));
  for (let index = 0; needsTree && index < roots.length; index++) {
    const elements = roots[index].querySelectorAll('*');
    if (all.length + elements.length > 20_000 || roots.length > 1000) return { error: 'RESULT_TOO_LARGE' };
    for (const element of elements) {
      if (ignored(element)) continue;
      all.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const roleOf = element => element.getAttribute('role')?.trim().split(/\s+/)[0] || ({
    A: element.hasAttribute('href') ? 'link' : null, BUTTON: 'button',
    TEXTAREA: 'textbox', SELECT: element.multiple ? 'listbox' : 'combobox',
    INPUT: { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button',
      submit: 'button', reset: 'button' }[element.type] || 'textbox',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  })[element.tagName] || (element.isContentEditable ? 'textbox' : null);
  const nameOf = element => {
    const labelled = element.getAttribute('aria-labelledby')?.split(/\s+/)
      .map(id => element.getRootNode().getElementById(id)).filter(Boolean).map(label => textOf(label)).join(' ');
    return (labelled || element.getAttribute('aria-label') ||
      [...(element.labels || [])].map(label => textOf(label)).join(' ') ||
      element.getAttribute('alt') || element.getAttribute('title') ||
      (element.matches('input,textarea,select') || element.isContentEditable
        ? element.getAttribute('placeholder') : textOf(element)) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  };
  const disabled = element => element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
  const readonly = element => element.readOnly || element.getAttribute('aria-readonly') === 'true';
  const editable = element => element.isContentEditable ||
    element.matches('textarea,input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"])');
  if (operation === 'get_page_snapshot') {
    state.entries.clear();
    const candidates = all.filter(element => roleOf(element) && visible(element));
    const elements = candidates.slice(0, 500).map(element => {
      const ref = `e${state.next++}`;
      state.entries.set(ref, element);
      const rect = element.getBoundingClientRect();
      const row = {
        ref, tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element),
        disabled: disabled(element), readonly: Boolean(readonly(element)),
        editable: editable(element) && !readonly(element) && !disabled(element),
        in_viewport: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      };
      if (element.matches('input[type="checkbox"],input[type="radio"]')) row.checked = element.checked;
      if (element.hasAttribute('aria-checked')) row.checked = element.getAttribute('aria-checked') === 'true';
      if (element.matches('input,textarea,select') || element.isContentEditable) row.value_redacted = true;
      return row;
    });
    return { document: globalThis[documentKey], url: location.href, title: document.title.slice(0, 500),
      text: textOf(document.body, 10_000, true), elements, truncated: candidates.length > 500,
      scope: 'top-level-and-open-shadow-roots', input_mode: 'dom' };
  }
  if (operation === 'get_interactive_elements') {
    return { elements: all.filter(element => element.matches('a,button,input,textarea,select,[role="button"]') &&
      visible(element)).slice(0, 500).map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName.toLowerCase(), id: element.id, type: element.getAttribute('type'),
        text: nameOf(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }) };
  }
  if (operation === 'clear_overlays') {
    all.filter(element => element.matches('[data-domagent-overlay]') && !element.querySelector(marker))
      .forEach(element => element.remove());
    return { cleared: true };
  }
  let element;
  if (args.ref) {
    element = state.entries.get(args.ref);
    if (!element?.isConnected || element.getRootNode({ composed: true }) !== document || ignored(element)) {
      return { error: 'ELEMENT_STALE' };
    }
  } else if (args.selector) {
    let matches;
    try {
      matches = roots.flatMap(root => [...root.querySelectorAll(args.selector)]).filter(element => !ignored(element));
    } catch (error) {
      if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
      throw error;
    }
    if (matches.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
    element = matches[0];
  } else element = operation === 'scroll' ? document.scrollingElement : document.body;
  if (!element) return { error: 'ELEMENT_NOT_FOUND' };
  if (operation === 'get_text') {
    return { text: textOf(element, 200_000) };
  }
  if (!visible(element)) return { error: 'ELEMENT_NOT_VISIBLE' };
  if (disabled(element)) return { error: 'ELEMENT_DISABLED' };
  if (operation === 'type_text' && (!editable(element) || element.matches('input[type="file"]'))) {
    return { error: 'ELEMENT_NOT_EDITABLE' };
  }
  if (operation === 'type_text' && readonly(element)) return { error: 'ELEMENT_READONLY' };
  if (operation === 'select_option' && !element.matches('select')) return { error: 'ELEMENT_NOT_EDITABLE' };
  if (operation === 'set_checked' && !element.matches('input[type="checkbox"],input[type="radio"]')) {
    return { error: 'ELEMENT_NOT_EDITABLE' };
  }
  if (operation === 'set_checked' && element.type === 'radio' && !args.checked) return { error: 'HANDOFF_REQUIRED' };
  if (operation === 'scroll') {
    element.scrollBy({ left: args.delta_x || 0, top: args.delta_y, behavior: 'instant' });
    return { x: element.scrollLeft, y: element.scrollTop };
  }
  const link = element.closest('a[href]');
  const labelControl = element.closest('label')?.control;
  if (element.matches('input[type="file"]') || labelControl?.matches('input[type="file"]') ||
      (link && (link.hasAttribute('download') || link.target === '_blank'))) return { error: 'HANDOFF_REQUIRED' };
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  if (!element.isConnected) return { error: 'ELEMENT_STALE' };
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return { error: 'ELEMENT_NOT_VISIBLE' };
  const x = (left + right) / 2, y = (top + bottom) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const deeper = hit.shadowRoot.elementFromPoint?.(x, y);
    if (!deeper || deeper === hit) break;
    hit = deeper;
  }
  let reached = false;
  for (let node = hit; node; node = parent(node)) {
    if (node === element) { reached = true; break; }
  }
  if (!reached) return { error: 'ELEMENT_OBSCURED' };
  if (operation === 'click') {
    element.click();
    return { clicked: true, input_mode: 'dom' };
  }
  if (operation === 'set_checked') {
    if (element.checked !== args.checked) element.click();
    if (element.checked !== args.checked) return { error: 'OPERATION_FAILED' };
    return { checked: element.checked, input_mode: 'dom' };
  }
  if (operation === 'select_option') {
    const options = [...element.options].filter(option => option.value === args.value);
    if (!options.length) return { error: 'OPTION_NOT_FOUND' };
    if (options.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
    if (options[0].disabled || options[0].parentElement?.matches('optgroup:disabled')) {
      return { error: 'ELEMENT_DISABLED' };
    }
    if (element.multiple) return { error: 'HANDOFF_REQUIRED' };
    element.value = args.value;
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (element.value !== args.value) return { error: 'OPERATION_FAILED' };
    return { selected: args.value, input_mode: 'dom' };
  }
  if (operation === 'press_key') {
    element.focus();
    if (!element.isConnected) return { error: 'ELEMENT_STALE' };
    element.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, bubbles: true, composed: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: args.key, bubbles: true, composed: true, cancelable: true }));
    return { key: args.key, events_dispatched: true, native_input: false, default_action_performed: false };
  }
  if (operation === 'type_text') {
    element.focus();
    if (!element.isConnected) return { error: 'ELEMENT_STALE' };
    if (element.isContentEditable) element.textContent = args.text;
    else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, args.text);
    }
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if ((element.isContentEditable ? element.textContent : element.value) !== args.text) {
      return { error: 'OPERATION_FAILED' };
    }
    return { typed: true, input_mode: 'dom' };
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
