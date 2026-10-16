// This packaged helper runs in an isolated world. No remote source is evaluated here.
export async function pageHelper(operation, args = {}) {
  const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const documentKey = '__domagentDocumentNonce';
  if (!globalThis[documentKey]) globalThis[documentKey] = nonce();
  if (args.document_nonce && args.document_nonce !== globalThis[documentKey]) return { error: 'TARGET_STALE' };
  if (args.document && args.document !== globalThis[documentKey]) {
    return { error: 'TARGET_STALE', stale_reason: 'document_changed', snapshot_document: args.document,
      current_document: globalThis[documentKey] };
  }
  if (operation === 'inspect') return { url: location.href, title: document.title,
    content_type: document.contentType, document_nonce: globalThis[documentKey], ready_state: document.readyState };
  // Ref numbers keep rising across documents in a tab (ref_base), so a ref from an earlier
  // document can never name an element here; first classifies stale refs.
  const state = globalThis.__domagentPageRefs ||= { entries: new Map(), next: 1, first: null };
  const bindings = globalThis.__domagentActionBindings ||= new Map();
  if (operation === 'release_action') {
    bindings.delete(args.approval_token);
    return { released: true };
  }
  const marker = '[data-domagent-sharing],[data-domagent-control-frame]';
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
  const hidingNode = element => {
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return { node, reason: 'DISPLAY_NONE' };
      if (style.opacity === '0') return { node, reason: 'OPACITY_ZERO' };
      if (['hidden', 'collapse'].includes(style.visibility) &&
          (!parent(node) || getComputedStyle(parent(node)).visibility !== style.visibility)) {
        return { node, reason: 'VISIBILITY_HIDDEN' };
      }
    }
    return null;
  };
  const metadata = element => ({
    tag: element.tagName.toLowerCase(), id: element.id?.slice(0, 80) || null,
    role: roleOf(element)?.slice(0, 80) || null, name: nameOf(element).slice(0, 80),
  });
  const activationLabel = element => {
    if (!element.matches('input[type="checkbox"],input[type="radio"]') || visible(element)) return {};
    const hiding = hidingNode(element);
    if (hiding && hiding.node !== element) return {};
    const labels = [...(element.labels || [])].filter(label =>
      label.control === element && label.isConnected && !ignored(label) && visible(label));
    if (labels.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
    return { label: labels[0] };
  };
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
    const hiding = hidingNode(element);
    let hiddenDetails = {};
    if (hiding) {
      const controls = hiding.node.id ? all.filter(control =>
        control.getRootNode() === hiding.node.getRootNode() &&
        control.getAttribute('aria-controls')?.split(/\s+/).includes(hiding.node.id) &&
        visible(control) && !disabled(control)).slice(0, 3) : [];
      hiddenDetails = {
        hidden_by: { ...metadata(hiding.node), reason: hiding.reason, is_target: hiding.node === element },
        reveal_controls: controls.map(control => ({
          ...metadata(control), expanded: control.getAttribute('aria-expanded'),
        })),
      };
    }
    const activation = activationLabel(element);
    return { matches: 1, state: reason ? 'not_ready' : 'ready', reason, document: globalThis[documentKey],
      tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element),
      ...flags, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport,
      value_redacted: element.matches('input,textarea,select') || element.isContentEditable,
      ...hiddenDetails,
      ...(activation.label ? { activation: { ...metadata(activation.label), kind: 'associated_label' } } : {}),
    };
  };
  const snapshot = () => {
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
    if (state.first === null && Number.isSafeInteger(args.ref_base) && args.ref_base > state.next &&
        args.ref_base < 900_000_000) state.next = args.ref_base;
    // Recycle numbers before they outgrow the ref pattern (e + at most nine digits).
    if (state.next > 999_000_000) { state.next = 1; state.first = null; }
    state.first ??= state.next;
    state.entries.clear();
    const decorative = element => {
      const role = roleOf(element);
      if (['presentation', 'none'].includes(role)) return true;
      if (element.closest('[aria-hidden="true"]')) return true;
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
        const owner = element.ownerSVGElement;
        return Boolean(owner) || !nameOf(element);
      }
      return false;
    };
    const interactiveRoles = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
      'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'treeitem']);
    const candidates = all.filter(element => inScope(element) && roleOf(element) && !decorative(element) &&
      visible(element));
    const limit = args.max_elements ?? 50;
    let chosen = candidates;
    if (candidates.length > limit) {
      const order = new Map(candidates.map((element, index) => [element, index]));
      const interactive = candidates.filter(element => interactiveRoles.has(roleOf(element)));
      const rest = candidates.filter(element => !interactiveRoles.has(roleOf(element)));
      chosen = [...interactive, ...rest].slice(0, limit).sort((a, b) => order.get(a) - order.get(b));
    }
    const elements = chosen.map(element => {
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
      if (row.role === 'link' && typeof element.href === 'string' && /^https?:/i.test(element.href)) {
        row.href = element.href.slice(0, 500);
      }
      return row;
    });
    const text = textData(scope, true);
    const elementsTruncated = candidates.length > elements.length;
    return { document: globalThis[documentKey], url: location.href, title: document.title.slice(0, 500),
      ...text, elements, elements_truncated: elementsTruncated, next_ref: state.next, truncated: elementsTruncated || text.text_truncated,
      scope: 'top-level-and-open-shadow-roots', input_mode: 'dom', viewport };
  };
  const interactiveElements = () => {
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
  };
  const contentReadiness = () => {
    try {
      const matches = roots.flatMap(root => [...root.querySelectorAll(args.selector)]);
      return { ready: matches.some(element => !ignored(element) && visible(element)) };
    } catch (error) {
      if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
      throw error;
    }
  };
  const resolveTarget = () => {
    let element;
    let activator;
    if (args.approval_token && operation !== 'prepare_action') {
      const binding = bindings.get(args.approval_token);
      if (!binding || binding.operation !== operation) return { error: 'ELEMENT_STALE' };
      element = binding.element;
      activator = binding.activator;
      if (!element.isConnected || element.getRootNode({ composed: true }) !== document || ignored(element)) {
        return { error: 'ELEMENT_STALE' };
      }
      if (activator && activator !== element && (!activator.isConnected || activator.control !== element || ignored(activator))) {
        return { error: 'ELEMENT_STALE' };
      }
    } else if (args.ref) {
      element = state.entries.get(args.ref);
      if (!element) {
        const number = Number(args.ref.slice(1));
        const stale_reason = state.first === null || number < state.first || number >= state.next
          ? 'ref_from_other_document' : 'ref_superseded';
        return { error: 'ELEMENT_STALE', stale_reason, current_document: globalThis[documentKey] };
      }
      if (!element.isConnected || element.getRootNode({ composed: true }) !== document || ignored(element)) {
        return { error: 'ELEMENT_STALE', stale_reason: 'element_detached', current_document: globalThis[documentKey] };
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
    return { found: true, element, activator };
  };
  const readText = element => {
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
  };
  const actionBlocker = (element, activator) => {
    if (!visible(activator)) return { error: 'ELEMENT_NOT_VISIBLE' };
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
    return null;
  };
  const hitBlocker = (element, activator) => {
    const link = element.closest('a[href]');
    const labelControl = element.closest('label')?.control;
    if (element.matches('input[type="file"]') || labelControl?.matches('input[type="file"]') ||
        (link && (link.hasAttribute('download') || link.target === '_blank'))) return { error: 'HANDOFF_REQUIRED' };
    activator.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (!element.isConnected) return { error: 'ELEMENT_STALE' };
    const rect = activator.getBoundingClientRect();
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
      if (node === activator) { reached = true; break; }
    }
    if (!reached && activator.matches('label') && hit === activator.control &&
        hit?.matches('input[type="checkbox"],input[type="radio"]')) reached = true;
    if (!reached) return { error: 'ELEMENT_OBSCURED' };
    return null;
  };
  const actions = {
    click: (element, activator) => {
      if (element.matches('input,textarea,select,button,a[href],[tabindex]')) {
        element.focus({ preventScroll: true });
        if (!element.isConnected) return { error: 'ELEMENT_STALE' };
        if (disabled(element)) return { error: 'OPERATION_FAILED' };
      }
      element.click();
      return { clicked: true, input_mode: 'dom' };
    },
    set_checked: (element, activator) => {
      if (element.checked !== args.checked) activator.click();
      if (!element.isConnected || (activator !== element && activator.control !== element)) return { error: 'ELEMENT_STALE' };
      if (element.checked !== args.checked) return { error: 'OPERATION_FAILED' };
      return { checked: element.checked, input_mode: 'dom' };
    },
    select_option: (element, activator) => {
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
    },
    press_key: (element, activator) => {
      element.focus();
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      element.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, bubbles: true, composed: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: args.key, bubbles: true, composed: true, cancelable: true }));
      return { key: args.key, events_dispatched: true, native_input: false, default_action_performed: false };
    },
    type_text: async (element, activator) => {
      element.focus();
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      let inputMode = 'dom';
      if (element.isContentEditable) {
        const selection = document.getSelection();
        if (!selection || typeof document.execCommand !== 'function') return { error: 'INPUT_REJECTED' };
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges(); selection.addRange(range);
        const accepted = document.execCommand('insertText', false, args.text);
        if (!accepted && element.textContent !== args.text) return { error: 'INPUT_REJECTED' };
        inputMode = 'dom_editing';
      } else {
        const before = new InputEvent('beforeinput', {
          bubbles: true, composed: true, cancelable: true, inputType: 'insertReplacementText', data: args.text,
        });
        if (!element.dispatchEvent(before)) return { error: 'INPUT_REJECTED' };
        if (!element.isConnected) return { error: 'ELEMENT_STALE' };
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, args.text);
        element.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertReplacementText', data: args.text,
        }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      if ((element.isContentEditable ? element.textContent : element.value) !== args.text) {
        return { error: 'INPUT_NOT_APPLIED' };
      }
      return { typed: true, input_mode: inputMode, verification: 'dom_after_reconciliation' };
    },
  };
  if (operation === 'get_page_snapshot') return snapshot();
  if (operation === 'get_interactive_elements') return interactiveElements();
  if (operation === 'clear_overlays') {
    all.filter(element => element.matches('[data-domagent-overlay]') && !element.querySelector(marker))
      .forEach(element => element.remove());
    return { cleared: true };
  }
  if (operation === 'content_readiness') return contentReadiness();
  const resolved = resolveTarget();
  if (!resolved.found) return resolved;
  const { element } = resolved;
  let { activator } = resolved;
  if (operation === 'inspect_element') return diagnostic(element);
  if (operation === 'prepare_action') {
    if (bindings.size >= 32) return { error: 'QUEUE_FULL' };
    const activation = args.action === 'set_checked' ? activationLabel(element) : {};
    if (activation.error) return { error: activation.error };
    const token = nonce();
    bindings.set(token, { element, activator: activation.label || element, operation: args.action });
    return { ...diagnostic(element), approval_token: token };
  }
  if (operation === 'get_text') return readText(element);
  if (!activator && operation === 'set_checked') {
    const activation = activationLabel(element);
    if (activation.error) return { error: activation.error };
    activator = activation.label;
  }
  activator ||= element;
  const blocked = actionBlocker(element, activator);
  if (blocked) return blocked;
  if (operation === 'scroll') {
    element.scrollBy({ left: args.delta_x || 0, top: args.delta_y, behavior: 'instant' });
    return { x: element.scrollLeft, y: element.scrollTop };
  }
  const obstruction = hitBlocker(element, activator);
  if (obstruction) return obstruction;
  if (Object.hasOwn(actions, operation)) return actions[operation](element, activator);
  return { error: 'CAPABILITY_UNAVAILABLE' };
}
