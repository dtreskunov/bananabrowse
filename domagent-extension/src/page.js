// This packaged helper runs in an isolated world. No remote source is evaluated here.
export function pageHelper(operation, args = {}) {
  const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const documentKey = '__domagentDocumentNonce';
  if (!globalThis[documentKey]) globalThis[documentKey] = nonce();
  if (args.document_nonce && args.document_nonce !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  if (args.document && args.document !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  if (operation === 'inspect') return { url: location.href, title: document.title,
    content_type: document.contentType, document_nonce: globalThis[documentKey] };
  const state = globalThis.__domagentPageRefs ||= { entries: new Map(), next: 1 };
  const bindings = globalThis.__domagentActionBindings ||= new Map();
  if (operation === 'release_action') {
    bindings.delete(args.approval_token);
    return { released: true };
  }
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
  const textData = (element, redactEditable = false) => {
    const limit = args.max_text_chars ?? 4000;
    const sample = textOf(element, limit + 1, redactEditable);
    return { text: sample.slice(0, limit), text_truncated: sample.length > limit };
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
  const elementState = (element, rect) => ({
    disabled: disabled(element), readonly: Boolean(readonly(element)),
    editable: editable(element) && !readonly(element) && !disabled(element),
    in_viewport: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
  });
  const viewport = { width: innerWidth, height: innerHeight };
  const diagnostic = element => {
    const rect = element.getBoundingClientRect();
    let reason = null;
    if (!visible(element)) reason = rect.width <= 0 || rect.height <= 0 ? 'ZERO_SIZE' : 'CSS_HIDDEN';
    else if (disabled(element)) reason = 'DISABLED';
    else if (readonly(element)) reason = 'READONLY';
    const flags = elementState(element, rect);
    if (!reason && !flags.in_viewport) reason = 'OFF_SCREEN';
    if (!reason && flags.in_viewport) {
      const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
      const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const deeper = hit.shadowRoot.elementFromPoint?.(x, y);
        if (!deeper || deeper === hit) break;
        hit = deeper;
      }
      let reached = false;
      for (let node = hit; node; node = parent(node)) if (node === element) { reached = true; break; }
      if (!reached) reason = ignored(hit) ? 'SHARING_INDICATOR' : 'OBSCURED';
    }
    return { matches: 1, state: reason ? 'not_ready' : 'ready', reason, document: globalThis[documentKey],
      tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element),
      ...flags, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport,
      value_redacted: element.matches('input,textarea,select') || element.isContentEditable };
  };
  if (operation === 'get_page_snapshot') {
    let scope = document.body;
    if (args.selector) {
      let matches;
      try {
        matches = roots.flatMap(root => [...root.querySelectorAll(args.selector)]).filter(element => !ignored(element));
      } catch (error) {
        if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
        throw error;
      }
      if (matches.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
      if (!matches.length) return { error: 'ELEMENT_NOT_FOUND' };
      [scope] = matches;
    }
    const inScope = element => {
      for (let node = element; node; node = parent(node)) if (node === scope) return true;
      return false;
    };
    state.entries.clear();
    const candidates = all.filter(element => inScope(element) && roleOf(element) && visible(element));
    const elements = candidates.slice(0, args.max_elements ?? 50).map(element => {
      const ref = `e${state.next++}`;
      state.entries.set(ref, element);
      const rect = element.getBoundingClientRect();
      const row = {
        ref, tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element),
        ...elementState(element, rect),
      };
      if (element.matches('input[type="checkbox"],input[type="radio"]')) row.checked = element.checked;
      if (element.hasAttribute('aria-checked')) row.checked = element.getAttribute('aria-checked') === 'true';
      if (element.matches('input,textarea,select') || element.isContentEditable) row.value_redacted = true;
      return row;
    });
    const text = textData(scope, true);
    const elementsTruncated = candidates.length > elements.length;
    return { document: globalThis[documentKey], url: location.href, title: document.title.slice(0, 500),
      ...text, elements, elements_truncated: elementsTruncated, truncated: elementsTruncated || text.text_truncated,
      scope: 'top-level-and-open-shadow-roots', input_mode: 'dom', viewport };
  }
  if (operation === 'get_interactive_elements') {
    const candidates = all.filter(element => element.matches('a,button,input,textarea,select,[role="button"]') &&
      !element.matches('input[type="hidden"]') && visible(element));
    const elements = candidates.slice(0, args.max_elements ?? 50).map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName.toLowerCase(), id: element.id, type: element.getAttribute('type'),
        text: nameOf(element), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        ...elementState(element, rect) };
    });
    return { coordinate_system: 'viewport', elements,
      truncated: candidates.length > elements.length, elements_truncated: candidates.length > elements.length };
  }
  if (operation === 'clear_overlays') {
    all.filter(element => element.matches('[data-domagent-overlay]') && !element.querySelector(marker))
      .forEach(element => element.remove());
    return { cleared: true };
  }
  let element;
  if (args.approval_token && operation !== 'prepare_action') {
    const binding = bindings.get(args.approval_token);
    if (!binding || binding.operation !== operation) return { error: 'ELEMENT_STALE' };
    element = binding.element;
    if (!element.isConnected || element.getRootNode({ composed: true }) !== document || ignored(element)) {
      return { error: 'ELEMENT_STALE' };
    }
  } else if (args.ref) {
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
    if (matches.length > 1) {
      if (operation === 'inspect_element') return { matches: matches.length, state: 'ambiguous', reason: 'ELEMENT_AMBIGUOUS', viewport };
      return { error: 'ELEMENT_AMBIGUOUS' };
    }
    element = matches[0];
  } else element = operation === 'scroll' ? document.scrollingElement : document.body;
  if (!element) {
    if (['inspect_element', 'prepare_action'].includes(operation)) {
      return { matches: 0, state: 'missing', reason: 'ELEMENT_NOT_FOUND', viewport };
    }
    return { error: 'ELEMENT_NOT_FOUND' };
  }
  if (operation === 'inspect_element') return diagnostic(element);
  if (operation === 'prepare_action') {
    if (bindings.size >= 32) return { error: 'QUEUE_FULL' };
    const token = nonce();
    bindings.set(token, { element, operation: args.action });
    return { ...diagnostic(element), approval_token: token };
  }
  if (operation === 'get_text') {
    if (element.tagName === 'TITLE' && element.parentElement?.tagName === 'HEAD') {
      const limit = args.max_text_chars ?? 4000;
      const value = document.title;
      return { text: value.slice(0, limit), truncated: value.length > limit,
        text_truncated: value.length > limit, rendered: false, text_source: 'document_title' };
    }
    if (!visible(element)) {
      return { text: '', truncated: false, text_truncated: false,
        rendered: false, text_source: 'rendered', empty_reason: 'NOT_RENDERED' };
    }
    const text = textData(element);
    return { ...text, truncated: text.text_truncated, rendered: true, text_source: 'rendered' };
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
  const hitAtPoint = () => {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const deeper = hit.shadowRoot.elementFromPoint?.(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  };
  let hit = hitAtPoint();
  const indicator = globalThis.__domagentSharingHost;
  if (indicator?.isConnected && ignored(hit)) {
    // Ignore only our own cosmetic banner, never a site's blocking overlay.
    const display = indicator.style.getPropertyValue('display');
    const priority = indicator.style.getPropertyPriority('display');
    try {
      indicator.style.setProperty('display', 'none', 'important');
      hit = hitAtPoint();
    } finally {
      if (display) indicator.style.setProperty('display', display, priority);
      else indicator.style.removeProperty('display');
    }
  }
  let reached = false;
  for (let node = hit; node; node = parent(node)) {
    if (node === element) { reached = true; break; }
  }
  if (!reached) return { error: 'ELEMENT_OBSCURED' };
  if (operation === 'click') {
    if (element.matches('input,textarea,select,button,a[href],[tabindex]')) {
      element.focus({ preventScroll: true });
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      if (disabled(element)) return { error: 'OPERATION_FAILED' };
    }
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
  const old = globalThis.__domagentSharingHost || document.querySelector('[data-domagent-sharing]');
  if (!details) {
    old?.remove();
    globalThis.__domagentSharingHost = null;
    return { url: location.href };
  }
  if (details.remove) {
    if (old?.getAttribute('data-domagent-sharing') === details.token) {
      old.remove();
      globalThis.__domagentSharingHost = null;
    }
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
    for (const summary of details.command.summary || []) {
      const line = document.createElement('p');
      line.textContent = summary;
      banner.append(line);
    }
    const description = document.createElement('p');
    description.textContent = `Agent explanation (unverified): ${details.command.description}`;
    banner.append(description);
    if (details.command.state === 'pending' && !details.command.preparing) {
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
      waiting.textContent = details.command.preparing ? 'Inspecting target before approval…' :
        details.command.state === 'executing' ? 'Action running…' : 'Approved; waiting for service…';
      banner.append(waiting);
    }
  }
  add('Stop sharing', 'stop');
  root.append(style, banner);
  document.documentElement.append(host);
  globalThis.__domagentSharingHost = host;
  return { url: location.href };
}

// Only injected into MAIN. A CSP denying page eval is an unsupported capability,
// not a reason to fall back to the extension or content-script realm.
export async function pageEvaluate(script, maxOutputBytes = 16 * 1024) {
  let result;
  try {
    result = await (0, eval)(script);
  } catch (error) {
    if (error?.name === 'EvalError' && /unsafe-eval|content security policy|csp|code generation/i.test(error.message || '')) {
      return { error: 'SCRIPT_POLICY_BLOCKED' };
    }
    return { error: error?.name === 'SyntaxError' ? 'SCRIPT_SYNTAX_ERROR' : 'SCRIPT_RUNTIME_ERROR' };
  }
  try {
    if (typeof result === 'function' || typeof result === 'symbol') return { error: 'SCRIPT_SERIALIZATION_ERROR' };
    const json = JSON.stringify({ value: result === undefined ? null : result });
    const wrapped = JSON.stringify({ content: [{ type: 'text', text: json }] });
    if (new TextEncoder().encode(wrapped).length > maxOutputBytes) return { error: 'RESULT_TOO_LARGE' };
    return JSON.parse(json);
  } catch {
    return { error: 'SCRIPT_SERIALIZATION_ERROR' };
  }
}
