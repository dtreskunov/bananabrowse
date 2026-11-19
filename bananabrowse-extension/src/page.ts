import type { QueryAllResult, QueryFieldIssue, Wire } from '../../shared/protocol.js';

// This packaged helper runs in an isolated world. No remote source is evaluated here.
export async function pageHelper(operation: string, args: Wire = {}): Promise<any> {
  const nonce = () =>
    [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const documentKey = '__bananabrowseDocumentNonce';
  if (!(globalThis as any)[documentKey]) (globalThis as any)[documentKey] = nonce();
  if (args.document_nonce && args.document_nonce !== (globalThis as any)[documentKey]) return { error: 'TARGET_STALE' };
  if (args.document && args.document !== (globalThis as any)[documentKey]) {
    return {
      error: 'TARGET_STALE',
      stale_reason: 'document_changed',
      snapshot_document: args.document,
      current_document: (globalThis as any)[documentKey],
    };
  }
  if (operation === 'inspect')
    return {
      url: location.href,
      title: document.title,
      content_type: document.contentType,
      document_nonce: (globalThis as any)[documentKey],
      ready_state: document.readyState,
    };
  // Ref numbers keep rising across documents in a tab (ref_base), so a ref from an earlier
  // document can never name an element here; first classifies stale refs.
  const state = ((globalThis as any).__bananabrowsePageRefs ||= { entries: new Map(), next: 1, first: null });
  if (state.first === null && Number.isSafeInteger(args.ref_base) && args.ref_base > state.next)
    state.next = args.ref_base;
  if (state.next > 999_000_000) {
    state.next = 1;
    state.first = null;
    state.entries.clear();
  }
  const remember = (element: any): string => {
    for (const [ref, existing] of state.entries) if (existing === element) return ref;
    state.first ??= state.next;
    const ref = `e${state.next++}`;
    state.entries.set(ref, element);
    return ref;
  };
  const bindings = ((globalThis as any).__bananabrowseActionBindings ||= new Map());
  if (operation === 'release_action') {
    bindings.delete(args.approval_token);
    return { released: true };
  }
  const marker = '[data-bananabrowse-sharing],[data-bananabrowse-control-frame]';
  const parent = (node: any) => node.parentElement || node.getRootNode()?.host;
  const ignored = (element: any) => {
    for (let node = element; node; node = parent(node)) {
      if (node.matches(marker)) return true;
    }
    return false;
  };
  const visible = (element: any) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return false;
    for (let node = element; node; node = parent(node)) {
      if (getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  };
  const textOf = (element: any, limit = 10_000, redactEditable = false, redactValues = redactEditable) => {
    let remaining = limit + (redactValues ? privateValues[0]?.length || 0 : 0);
    const read = (node: any): string => {
      if (remaining <= 0) return '';
      if (node.nodeType === 3) {
        const value = (redactValues ? redactText(node.textContent) : node.textContent).slice(0, remaining);
        remaining -= value.length;
        return value;
      }
      if (
        node.nodeType !== 1 ||
        ignored(node) ||
        (redactEditable && node.isContentEditable) ||
        node.matches('script,style,noscript,input,textarea,select')
      )
        return '';
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
      const assigned = node.assignedNodes?.({ flatten: true });
      const children = assigned?.length ? assigned : (node.shadowRoot || node).childNodes;
      return [...children].map(read).join('') + (style.display === 'block' || node.tagName === 'BR' ? '\n' : '');
    };
    const text = read(element).trim();
    return (redactValues ? redactText(text) : text).slice(0, limit);
  };
  const textData = (element: any, redactEditable = false) => {
    const limit = args.max_text_chars ?? 4000;
    const sample = textOf(element, limit + 1, redactEditable);
    return { text: sample.slice(0, limit), text_truncated: sample.length > limit };
  };
  const roots: (Document | ShadowRoot)[] = [document];
  const all: any[] = [];
  const needsTree =
    ['inspect_form', 'inspect_element', 'prepare_action', 'type_text', 'get_text'].includes(operation) ||
    (!args.ref &&
      (args.selector ||
        ['get_page_snapshot', 'find_elements', 'get_interactive_elements', 'clear_overlays'].includes(operation)));
  for (let index = 0; needsTree && index < roots.length; index++) {
    const elements = roots[index].querySelectorAll('*');
    if (all.length + elements.length > 20_000 || roots.length > 1000) return { error: 'RESULT_TOO_LARGE' };
    for (const element of elements) {
      if (ignored(element)) continue;
      all.push(element);
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  // Labels and application errors can echo values outside the editable node.
  const privateValues = [
    ...new Set<string>(
      all
        .filter(
          (element) =>
            (element.matches('input,textarea,select') || element.isContentEditable) &&
            !(element.matches('input[type="checkbox"],input[type="radio"]') && !element.hasAttribute('value')),
        )
        .map((element) => (element.isContentEditable ? element.textContent : element.value))
        .filter((value) => typeof value === 'string' && value.length),
    ),
  ].sort((a, b) => b.length - a.length);
  const privatePattern = privateValues.length
    ? new RegExp(privateValues.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  const redactText = (text: string) => (privatePattern ? text.replace(privatePattern, '[redacted]') : text);
  const contains = (container: any, element: any) => {
    for (let node = element; node; node = parent(node)) if (node === container) return true;
    return false;
  };
  const roleOf = (element: any) =>
    element.getAttribute('role')?.trim().split(/\s+/)[0] ||
    (
      {
        A: element.hasAttribute('href') ? 'link' : null,
        BUTTON: 'button',
        TEXTAREA: 'textbox',
        SELECT: element.multiple ? 'listbox' : 'combobox',
        INPUT:
          (
            {
              checkbox: 'checkbox',
              radio: 'radio',
              range: 'slider',
              button: 'button',
              submit: 'button',
              reset: 'button',
            } as Record<string, string>
          )[element.type] || 'textbox',
        H1: 'heading',
        H2: 'heading',
        H3: 'heading',
        H4: 'heading',
        H5: 'heading',
        H6: 'heading',
      } as Record<string, string | null>
    )[element.tagName] ||
    (element.isContentEditable ? 'textbox' : null);
  const nameOf = (element: any, redactValues = true) => {
    const labelled = element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id: string) => element.getRootNode().getElementById(id))
      .filter(Boolean)
      .map((label: any) => textOf(label, 10_000, true, false))
      .join(' ');
    const name =
      labelled ||
      element.getAttribute('aria-label') ||
      [...(element.labels || [])].map((label) => textOf(label, 10_000, true, false)).join(' ') ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      (element.matches('input,textarea,select') || element.isContentEditable
        ? element.getAttribute('placeholder')
        : textOf(element, 10_000, true, false)) ||
      '';
    return (redactValues ? redactText(name) : name).replace(/\s+/g, ' ').trim().slice(0, 500);
  };
  const disabled = (element: any) => element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true';
  const readonly = (element: any) => element.readOnly || element.getAttribute('aria-readonly') === 'true';
  const editable = (element: any) =>
    element.isContentEditable ||
    element.matches(
      'textarea,input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="hidden"])',
    );
  const elementState = (element: any, rect: DOMRect) => ({
    disabled: disabled(element),
    readonly: Boolean(readonly(element)),
    editable: editable(element) && !readonly(element) && !disabled(element),
    in_viewport: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
  });
  const viewport = { width: innerWidth, height: innerHeight };
  const linked = (element: any, attributes: string[]) =>
    [
      ...new Set(
        attributes
          .flatMap((attribute) => (element.getAttribute(attribute) || '').split(/\s+/))
          .filter(Boolean)
          .map((id) => element.getRootNode().getElementById(id))
          .filter((node) => node && !ignored(node) && visible(node)),
      ),
    ] as any[];
  const controlTool = (element: any) => {
    if (element.matches('select'))
      return element.multiple
        ? { recommended_tool: 'request_handoff', recommended_action: 'manual_input' }
        : { recommended_tool: 'select_option', recommended_action: 'select_option' };
    if (element.matches('input[type="checkbox"],input[type="radio"]'))
      return { recommended_tool: 'set_checked', recommended_action: 'set_checked' };
    if (editable(element)) return { recommended_tool: 'type_text', recommended_action: 'replace_text' };
    if (roleOf(element) === 'combobox')
      return { recommended_tool: 'find_elements', recommended_action: 'inspect_suggestions' };
    return { recommended_tool: 'request_handoff', recommended_action: 'manual_input' };
  };
  const formState = (element: any): Wire => {
    if (
      !element.matches('input,textarea,select') &&
      !element.isContentEditable &&
      !['combobox', 'checkbox', 'radio', 'textbox'].includes(roleOf(element))
    )
      return {};
    const ariaInvalid = element.getAttribute('aria-invalid');
    const applicationInvalid = ariaInvalid !== null && ariaInvalid !== 'false';
    const messages = linked(element, [
      'aria-errormessage',
      ...(applicationInvalid || element.validity?.valid === false ? ['aria-describedby'] : []),
    ])
      .map((node) => textOf(node, 240, true))
      .filter(Boolean);
    if (
      (applicationInvalid || element.validity?.valid === false) &&
      element.parentElement?.querySelectorAll('input,textarea,select,[role="textbox"],[role="combobox"]').length === 1
    ) {
      for (const node of element.parentElement?.querySelectorAll(
        '[role="alert"],.invalid-feedback,.field-error,[data-error]',
      ) || []) {
        if (visible(node) && !ignored(node)) messages.push(textOf(node, 240, true));
        if (messages.length >= 3) break;
      }
    }
    const validation = element.validity
      ? Object.fromEntries(
          [
            'valueMissing',
            'typeMismatch',
            'patternMismatch',
            'tooLong',
            'tooShort',
            'rangeUnderflow',
            'rangeOverflow',
            'stepMismatch',
            'badInput',
            'customError',
          ]
            .filter((key) => element.validity[key])
            .map((key) => [key, true]),
        )
      : null;
    return {
      value_redacted: true,
      value_present: Boolean(element.isContentEditable ? element.textContent : element.value),
      aria_invalid: ariaInvalid,
      application_validation: applicationInvalid ? 'invalid' : 'not_reported',
      ...(messages.length ? { validation_messages: [...new Set(messages)].filter(Boolean).slice(0, 3) } : {}),
      ...(validation
        ? {
            valid: element.validity.valid,
            validation,
            native_validity: { valid: element.validity.valid, issues: Object.keys(validation) },
          }
        : { native_validity: null }),
    };
  };
  const interactiveRoles = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'combobox',
    'listbox',
    'option',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'spinbutton',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
  ]);
  const explicitAction = (element: any) =>
    Boolean(
      interactiveRoles.has(roleOf(element)) ||
      (element.matches('label') && element.control?.matches('input[type="checkbox"],input[type="radio"]')) ||
      element.hasAttribute('onclick') ||
      typeof element.onclick === 'function' ||
      element.hasAttribute('tabindex'),
    );
  const actionable = (element: any) => {
    if (explicitAction(element)) return true;
    if (getComputedStyle(element).cursor !== 'pointer') return false;
    // Computed cursors inherit: a span inside a link is not a second control.
    for (let node = parent(element); node; node = parent(node)) {
      if (explicitAction(node) || getComputedStyle(node).cursor === 'pointer') return false;
    }
    return true;
  };
  const elementRow = (element: any) => {
    const rect = element.getBoundingClientRect();
    const control = element.matches('label') ? element.control : element;
    const row: Record<string, any> = {
      ref: remember(element),
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: nameOf(element),
      ...elementState(element, rect),
      ...formState(element),
    };
    if (control?.matches('input[type="checkbox"],input[type="radio"]')) row.checked = control.checked;
    if (element.hasAttribute('aria-checked')) row.checked = element.getAttribute('aria-checked') === 'true';
    if (row.role === 'link' && typeof element.href === 'string' && /^https?:/i.test(element.href))
      row.href = element.href.slice(0, 500);
    return row;
  };
  const candidates = (matches: any[]) => ({
    document: (globalThis as any)[documentKey],
    matches: matches.length,
    candidates: matches.slice(0, 5).map((element) => ({
      ...metadata(element),
      ref: remember(element),
      visible: visible(element),
      disabled: disabled(element),
    })),
    candidates_truncated: matches.length > 5,
    next_ref: state.next,
  });
  const hidingNode = (element: any) => {
    for (let node = element; node; node = parent(node)) {
      const style = getComputedStyle(node);
      if (style.display === 'none') return { node, reason: 'DISPLAY_NONE' };
      if (style.opacity === '0') return { node, reason: 'OPACITY_ZERO' };
      if (
        ['hidden', 'collapse'].includes(style.visibility) &&
        (!parent(node) || getComputedStyle(parent(node)).visibility !== style.visibility)
      ) {
        return { node, reason: 'VISIBILITY_HIDDEN' };
      }
    }
    return null;
  };
  const metadata = (element: any) => ({
    tag: element.tagName.toLowerCase(),
    id: element.id?.slice(0, 80) || null,
    role: roleOf(element)?.slice(0, 80) || null,
    name: nameOf(element).slice(0, 80),
  });
  const activationLabel = (element: any) => {
    if (!element.matches('input[type="checkbox"],input[type="radio"]') || visible(element)) return {};
    const hiding = hidingNode(element);
    if (hiding && hiding.node !== element) return {};
    const labels = [...(element.labels || [])].filter(
      (label) => label.control === element && label.isConnected && !ignored(label) && visible(label),
    );
    if (labels.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
    return { label: labels[0] };
  };
  const diagnostic = (element: any) => {
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
      for (let node = hit; node; node = parent(node))
        if (node === element) {
          reached = true;
          break;
        }
      if (!reached) reason = ignored(hit) ? 'SHARING_INDICATOR' : 'OBSCURED';
    }
    const hiding = hidingNode(element);
    let hiddenDetails = {};
    if (hiding) {
      const controls = hiding.node.id
        ? all
            .filter(
              (control) =>
                control.getRootNode() === hiding.node.getRootNode() &&
                control.getAttribute('aria-controls')?.split(/\s+/).includes(hiding.node.id) &&
                visible(control) &&
                !disabled(control),
            )
            .slice(0, 3)
        : [];
      hiddenDetails = {
        hidden_by: { ...metadata(hiding.node), reason: hiding.reason, is_target: hiding.node === element },
        reveal_controls: controls.map((control) => ({
          ...metadata(control),
          expanded: control.getAttribute('aria-expanded'),
        })),
      };
    }
    const activation = activationLabel(element);
    return {
      matches: 1,
      state: reason ? 'not_ready' : 'ready',
      reason,
      document: (globalThis as any)[documentKey],
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      name: nameOf(element),
      ref: remember(element),
      ...flags,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport,
      value_redacted: element.matches('input,textarea,select') || element.isContentEditable,
      ...formState(element),
      ...hiddenDetails,
      ...(activation.label
        ? { activation: { ...metadata(activation.label), ref: remember(activation.label), kind: 'associated_label' } }
        : {}),
      next_ref: state.next,
    };
  };
  const snapshot = () => {
    let scope = document.body;
    if (args.selector) {
      let matches;
      try {
        matches = roots
          .flatMap((root) => [...root.querySelectorAll(args.selector)])
          .filter((element) => !ignored(element));
      } catch (error: any) {
        if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
        throw error;
      }
      if (matches.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
      if (!matches.length) return { error: 'ELEMENT_NOT_FOUND' };
      [scope] = matches;
    }
    state.entries.clear();
    const decorative = (element: any) => {
      const role = roleOf(element);
      if (['presentation', 'none'].includes(role)) return true;
      if (element.closest('[aria-hidden="true"]')) return true;
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
        const owner = element.ownerSVGElement;
        return Boolean(owner) || !nameOf(element);
      }
      return false;
    };
    const candidates = all.filter(
      (element) =>
        contains(scope, element) &&
        ((args.selector && element === scope) || roleOf(element) || actionable(element)) &&
        !decorative(element) &&
        visible(element),
    );
    const limit = args.max_elements ?? 50;
    let chosen = candidates;
    const ancestorMatches = (element: any, selector: string) => {
      for (let node = element; node; node = parent(node)) if (node.matches(selector)) return true;
      return false;
    };
    if (candidates.some((element) => ancestorMatches(element, 'form,main,[role="main"],[role="dialog"]'))) {
      const priority = (element: any) => {
        const chrome = ancestorMatches(element, 'nav,header,footer,[role="navigation"],[role="banner"]');
        if (chrome) return 5;
        if (element.matches('input,textarea,select') || element.isContentEditable) return 0;
        if (actionable(element) && ancestorMatches(element, 'form,[role="dialog"]')) return 1;
        if (actionable(element) && ancestorMatches(element, 'main,[role="main"]')) return 2;
        return actionable(element) ? 3 : 4;
      };
      chosen = [...candidates].sort((a, b) => priority(a) - priority(b)).slice(0, limit);
    } else if (candidates.length > limit) {
      const interactive = candidates.filter(actionable);
      const rest = candidates.filter((element) => !interactive.includes(element));
      const selected = new Set([...interactive, ...rest].slice(0, limit));
      chosen = candidates.filter((element) => selected.has(element));
    }
    const elements = chosen.map(elementRow);
    const text = textData(scope, true);
    const elementsTruncated = candidates.length > elements.length;
    return {
      document: (globalThis as any)[documentKey],
      url: location.href,
      title: document.title.slice(0, 500),
      ...text,
      elements,
      elements_truncated: elementsTruncated,
      next_ref: state.next,
      truncated: elementsTruncated || text.text_truncated,
      scope: 'top-level-and-open-shadow-roots',
      input_mode: 'dom',
      viewport,
    };
  };
  const findElements = () => {
    let matches = all;
    let scope: any;
    if (args.within) {
      const resolved = resolveTarget(args.within);
      if (!resolved.found) return resolved;
      scope = resolved.element;
    }
    if (args.selector) {
      try {
        matches = roots.flatMap((root) => [...root.querySelectorAll(args.selector)]);
      } catch (error: any) {
        if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
        throw error;
      }
    }
    matches = matches.filter(
      (element) =>
        !ignored(element) &&
        (!scope || contains(scope, element)) &&
        (args.include_hidden || visible(element)) &&
        (!args.role || roleOf(element) === args.role) &&
        (!args.label ||
          ((element.matches('input,textarea,select') || element.isContentEditable) &&
            nameOf(element, false) === args.label)) &&
        (!args.text ||
          nameOf(element, false) === args.text ||
          textOf(element, 10_000, true, false).replace(/\s+/g, ' ').trim() === args.text) &&
        (args.selector || args.role || args.label || args.text || actionable(element)),
    );
    if (args.text) {
      const controls = matches.filter(actionable);
      if (controls.length) matches = controls;
      else
        matches = matches.filter((element) => !matches.some((other) => other !== element && contains(element, other)));
    }
    const elements = matches.slice(0, args.max_elements ?? 50).map((element) => ({
      ...elementRow(element),
      visible: visible(element),
      id: element.id?.slice(0, 80) || null,
    }));
    return {
      document: (globalThis as any)[documentKey],
      elements,
      matched_count: matches.length,
      returned_count: elements.length,
      elements_truncated: matches.length > elements.length,
      truncated: matches.length > elements.length,
      next_ref: state.next,
    };
  };
  const inspectForm = () => {
    const resolved = resolveTarget();
    if (!resolved.found) return resolved;
    const scope = resolved.element;
    const fields = all.filter(
      (element) =>
        contains(scope, element) &&
        (visible(element) || Boolean(activationLabel(element).label)) &&
        !element.matches(
          'input[type="hidden"],input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]',
        ) &&
        (element.matches('input,textarea,select') ||
          element.isContentEditable ||
          ['textbox', 'combobox', 'checkbox', 'radio'].includes(roleOf(element))),
    );
    const elements = fields.slice(0, args.max_elements ?? 50).map((element) => {
      const constraints = Object.fromEntries(
        ['pattern', 'min', 'max', 'step', 'minlength', 'maxlength', 'inputmode', 'autocomplete']
          .filter((key) => element.hasAttribute(key))
          .map((key) => [key, redactText(element.getAttribute(key)).slice(0, 500)]),
      );
      const options = element.matches('select')
        ? [...element.options].slice(0, 20).map((option, index) => ({
            index,
            label: redactText(option.label).slice(0, 160),
            disabled: option.disabled || Boolean(option.parentElement?.matches('optgroup:disabled')),
          }))
        : undefined;
      const lists = linked(element, ['aria-controls', 'aria-owns']).filter((node) => roleOf(node) === 'listbox');
      const suggestions = lists.length
        ? all.filter((node) => roleOf(node) === 'option' && visible(node) && lists.some((list) => contains(list, node)))
        : [];
      const activation = activationLabel(element).label;
      const descriptions = linked(element, ['aria-describedby'])
        .slice(0, 3)
        .map((node) => textOf(node, 240, true))
        .filter(Boolean);
      return {
        ...elementRow(element),
        visible: visible(element),
        ...(activation
          ? {
              activation: {
                ref: remember(activation),
                kind: 'associated_label',
                name: nameOf(activation),
              },
            }
          : {}),
        type: element.getAttribute('type') || (element.matches('input') ? 'text' : roleOf(element)),
        required: Boolean(element.required || element.getAttribute('aria-required') === 'true'),
        constraints,
        ...(descriptions.length ? { descriptions } : {}),
        ...controlTool(element),
        ...(options ? { options, options_truncated: element.options.length > options.length } : {}),
        ...(!element.matches('select') && (lists.length || roleOf(element) === 'combobox')
          ? {
              expanded: element.getAttribute('aria-expanded'),
              suggestions: suggestions
                .slice(0, 10)
                .map((node) => ({ ref: remember(node), name: nameOf(node), disabled: disabled(node) })),
              suggestions_truncated: suggestions.length > 10,
              suggestion_action: 'click',
            }
          : {}),
      };
    });
    return {
      document: (globalThis as any)[documentKey],
      application_acceptance: 'unknown',
      elements,
      matched_count: fields.length,
      returned_count: elements.length,
      elements_truncated: fields.length > elements.length,
      truncated: fields.length > elements.length,
      scope: 'top-level-and-open-shadow-roots',
      next_ref: state.next,
    };
  };
  const interactiveElements = () => {
    const candidates = all.filter(
      (element) =>
        element.matches('a,button,input,textarea,select,[role="button"]') &&
        !element.matches('input[type="hidden"]') &&
        visible(element),
    );
    const elements = candidates.slice(0, args.max_elements ?? 50).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id,
        type: element.getAttribute('type'),
        text: nameOf(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        ...elementState(element, rect),
      };
    });
    return {
      coordinate_system: 'viewport',
      elements,
      truncated: candidates.length > elements.length,
      elements_truncated: candidates.length > elements.length,
    };
  };
  const contentReadiness = () => {
    try {
      const matches = roots.flatMap((root) => [...root.querySelectorAll(args.selector)]);
      return { ready: matches.some((element) => !ignored(element) && visible(element)) };
    } catch (error: any) {
      if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
      throw error;
    }
  };
  const queryAll = () => {
    let matches: Element[];
    try {
      matches = roots
        .flatMap((root) => [...root.querySelectorAll(args.selector)])
        .filter((element) => !ignored(element) && visible(element));
    } catch (error) {
      if (error instanceof Error && error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
      throw error;
    }
    if (!matches.length) return { error: 'ELEMENT_NOT_FOUND' };
    const rows: QueryAllResult['rows'] = [];
    const fieldIssues: QueryFieldIssue[] = [];
    const fields = Object.entries(args.fields as Record<string, { selector: string; attribute?: string }>);
    for (const row of matches.slice(0, args.limit ?? 50)) {
      const rowIndex = rows.length;
      const values: Record<string, string | null> = {};
      const rowRoots: (Element | ShadowRoot)[] = [
        row,
        ...roots.filter((root): root is ShadowRoot => {
          if (!('host' in root)) return false;
          for (let at = root.host; at; at = parent(at)) if (at === row) return true;
          return false;
        }),
      ];
      for (const [name, field] of fields) {
        let targets: Element[];
        try {
          targets = (
            field.selector === ':scope' ? [row] : rowRoots.flatMap((root) => [...root.querySelectorAll(field.selector)])
          ).filter((element) => !ignored(element) && visible(element));
        } catch (error) {
          if (error instanceof Error && error.name === 'SyntaxError')
            return { error: 'INVALID_SELECTOR', query_field: name, row_index: rowIndex };
          throw error;
        }
        if (targets.length > 1) return { error: 'ELEMENT_AMBIGUOUS', query_field: name, row_index: rowIndex };
        const target = targets[0];
        const issue = (reason: QueryFieldIssue['reason']) => {
          values[name] = null;
          fieldIssues.push({ row: rowIndex, field: name, reason });
        };
        if (!target) {
          issue('missing');
        } else if (
          !field.attribute &&
          (target.matches('input,textarea,select') || ('isContentEditable' in target && target.isContentEditable))
        ) {
          issue('redacted');
        } else if (field.attribute) {
          const raw = target.getAttribute(field.attribute);
          if (raw === null) issue('missing');
          else if (['href', 'src'].includes(field.attribute)) {
            let url: URL;
            try {
              url = new URL(raw, target.baseURI);
            } catch (error) {
              if (!(error instanceof TypeError)) throw error;
              issue('unsupported_url');
              continue;
            }
            if (['http:', 'https:'].includes(url.protocol)) values[name] = url.href;
            else issue('unsupported_url');
          } else values[name] = raw;
        } else {
          const limit = args.max_text_chars ?? 4000;
          const sample = textOf(target, limit + 1, true);
          let text = sample.slice(0, limit);
          if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
          values[name] = text;
          if (sample.length > text.length) fieldIssues.push({ row: rowIndex, field: name, reason: 'text_truncated' });
        }
      }
      rows.push(values);
    }
    const rowsTruncated = matches.length > rows.length;
    return {
      document: (globalThis as any)[documentKey],
      scope: 'top-level-and-open-shadow-roots',
      rows,
      matched_count: matches.length,
      returned_count: rows.length,
      rows_truncated: rowsTruncated,
      field_issues: fieldIssues,
      truncated: rowsTruncated || fieldIssues.some((issue) => issue.reason === 'text_truncated'),
    } satisfies QueryAllResult;
  };
  const resolveTarget = (target: Wire = args) => {
    if (target.document && target.document !== (globalThis as any)[documentKey])
      return {
        error: 'TARGET_STALE',
        stale_reason: 'document_changed',
        current_document: (globalThis as any)[documentKey],
      };
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
      if (
        activator &&
        activator !== element &&
        (!activator.isConnected || activator.control !== element || ignored(activator))
      ) {
        return { error: 'ELEMENT_STALE' };
      }
    } else if (target.ref) {
      element = state.entries.get(target.ref);
      if (!element) {
        const number = Number(target.ref.slice(1));
        const stale_reason =
          state.first === null || number < state.first || number >= state.next
            ? 'ref_from_other_document'
            : 'ref_superseded';
        return { error: 'ELEMENT_STALE', stale_reason, current_document: (globalThis as any)[documentKey] };
      }
      if (!element.isConnected || element.getRootNode({ composed: true }) !== document || ignored(element)) {
        return {
          error: 'ELEMENT_STALE',
          stale_reason: 'element_detached',
          current_document: (globalThis as any)[documentKey],
        };
      }
    } else if (target.selector) {
      let matches;
      try {
        matches = roots
          .flatMap((root) => [...root.querySelectorAll(target.selector)])
          .filter((element) => !ignored(element));
      } catch (error: any) {
        if (error.name === 'SyntaxError') return { error: 'INVALID_SELECTOR' };
        throw error;
      }
      if (matches.length > 1) {
        if (operation === 'inspect_element')
          return { ...candidates(matches), state: 'ambiguous', reason: 'ELEMENT_AMBIGUOUS', viewport };
        return { error: 'ELEMENT_AMBIGUOUS', ...candidates(matches) };
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
  const readText = (element: any) => {
    if (element.matches('input,textarea,select') || element.isContentEditable)
      return {
        text: '',
        truncated: false,
        text_truncated: false,
        rendered: visible(element),
        text_source: 'rendered',
        empty_reason: 'VALUE_REDACTED',
        ...formState(element),
      };
    if (element.tagName === 'TITLE' && element.parentElement?.tagName === 'HEAD') {
      const limit = args.max_text_chars ?? 4000;
      const value = document.title;
      return {
        text: value.slice(0, limit),
        truncated: value.length > limit,
        text_truncated: value.length > limit,
        rendered: false,
        text_source: 'document_title',
      };
    }
    if (!visible(element)) {
      return {
        text: '',
        truncated: false,
        text_truncated: false,
        rendered: false,
        text_source: 'rendered',
        empty_reason: 'NOT_RENDERED',
      };
    }
    const text = textData(element, true);
    return { ...text, truncated: text.text_truncated, rendered: true, text_source: 'rendered' };
  };
  const actionBlocker = (element: any, activator: any) => {
    if (!visible(activator)) return { error: 'ELEMENT_NOT_VISIBLE' };
    if (disabled(element)) return { error: 'ELEMENT_DISABLED' };
    if (operation === 'type_text' && (!editable(element) || element.matches('input[type="file"]'))) {
      return { error: 'ELEMENT_NOT_EDITABLE', ...controlTool(element) };
    }
    if (operation === 'type_text' && readonly(element)) return { error: 'ELEMENT_READONLY' };
    if (operation === 'select_option' && !element.matches('select'))
      return { error: 'ELEMENT_NOT_EDITABLE', ...controlTool(element) };
    if (operation === 'set_checked' && !element.matches('input[type="checkbox"],input[type="radio"]')) {
      return { error: 'ELEMENT_NOT_EDITABLE', ...controlTool(element) };
    }
    if (operation === 'set_checked' && element.type === 'radio' && !args.checked)
      return { error: 'HANDOFF_REQUIRED', recommended_tool: 'set_checked', recommended_action: 'set_checked' };
    return null;
  };
  const hitBlocker = (element: any, activator: any) => {
    const link = element.closest('a[href]');
    const labelControl = element.closest('label')?.control;
    if (
      element.matches('input[type="file"]') ||
      labelControl?.matches('input[type="file"]') ||
      (link && (link.hasAttribute('download') || link.target === '_blank'))
    )
      return { error: 'HANDOFF_REQUIRED' };
    activator.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (!element.isConnected) return { error: 'ELEMENT_STALE' };
    const rect = activator.getBoundingClientRect();
    const left = Math.max(0, rect.left),
      right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top),
      bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return { error: 'ELEMENT_NOT_VISIBLE' };
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
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
    const indicator = (globalThis as any).__bananabrowseSharingHost;
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
      if (node === activator) {
        reached = true;
        break;
      }
    }
    if (
      !reached &&
      activator.matches('label') &&
      hit === activator.control &&
      hit?.matches('input[type="checkbox"],input[type="radio"]')
    )
      reached = true;
    if (!reached) return { error: 'ELEMENT_OBSCURED' };
    return null;
  };
  const actions = {
    click: (element: any) => {
      if (element.matches('input,textarea,select,button,a[href],[tabindex]')) {
        element.focus({ preventScroll: true });
        if (!element.isConnected) return { error: 'ELEMENT_STALE' };
        if (disabled(element)) return { error: 'OPERATION_FAILED' };
      }
      element.click();
      return { clicked: true, input_mode: 'dom' };
    },
    set_checked: (element: any, activator: any) => {
      if (element.checked !== args.checked) activator.click();
      if (!element.isConnected || (activator !== element && activator.control !== element))
        return { error: 'ELEMENT_STALE' };
      if (element.checked !== args.checked) return { error: 'OPERATION_FAILED' };
      return { checked: element.checked, input_mode: 'dom' };
    },
    select_option: (element: any) => {
      const options =
        args.index !== undefined
          ? [...element.options].filter((_, index) => index === args.index)
          : [...element.options].filter((option) => option.value === args.value);
      if (!options.length) return { error: 'OPTION_NOT_FOUND' };
      if (options.length > 1) return { error: 'ELEMENT_AMBIGUOUS' };
      if (options[0].disabled || options[0].parentElement?.matches('optgroup:disabled')) {
        return { error: 'ELEMENT_DISABLED' };
      }
      if (element.multiple) return { error: 'HANDOFF_REQUIRED', ...controlTool(element) };
      const selectedValue = options[0].value;
      element.selectedIndex = options[0].index;
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (element.value !== selectedValue || element.selectedIndex !== options[0].index)
        return { error: 'OPERATION_FAILED' };
      return { selected: args.index !== undefined ? true : args.value, input_mode: 'dom' };
    },
    press_key: (element: any) => {
      element.focus();
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: args.key, bubbles: true, composed: true, cancelable: true }),
      );
      element.dispatchEvent(
        new KeyboardEvent('keyup', { key: args.key, bubbles: true, composed: true, cancelable: true }),
      );
      return { key: args.key, events_dispatched: true, native_input: false, default_action_performed: false };
    },
    type_text: async (element: any) => {
      const valueOf = () => (element.isContentEditable ? element.textContent : element.value);
      const previous = valueOf();
      element.focus();
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      let inputMode = 'dom';
      if (element.isContentEditable) {
        const selection = document.getSelection();
        if (!selection || typeof document.execCommand !== 'function') return { error: 'INPUT_REJECTED' };
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        const accepted = document.execCommand('insertText', false, args.text);
        if (!accepted && element.textContent !== args.text) return { error: 'INPUT_REJECTED' };
        inputMode = 'dom_editing';
      } else {
        const before = new InputEvent('beforeinput', {
          bubbles: true,
          composed: true,
          cancelable: true,
          inputType: 'insertReplacementText',
          data: args.text,
        });
        if (!element.dispatchEvent(before)) return { error: 'INPUT_REJECTED' };
        if (!element.isConnected) return { error: 'ELEMENT_STALE' };
        const prototype =
          element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, args.text);
        element.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            composed: true,
            inputType: 'insertReplacementText',
            data: args.text,
          }),
        );
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!element.isConnected) return { error: 'ELEMENT_STALE' };
      const input_state = {
        value_present: Boolean(valueOf()),
        value_matches: valueOf() === (args.expected_value ?? args.text),
        value_changed: valueOf() !== previous,
        ...(element.validity ? { valid: element.validity.valid } : {}),
      };
      if (!input_state.value_matches) return { error: 'INPUT_NOT_APPLIED', input_state };
      return {
        typed: true,
        input_mode: inputMode,
        verification:
          args.expected_value !== undefined && args.expected_value !== args.text
            ? 'expected_formatted_value'
            : 'dom_after_reconciliation',
        input_state,
        aria_invalid: element.getAttribute('aria-invalid'),
        application_validation: formState(element).application_validation,
      };
    },
  };
  if (operation === 'get_page_snapshot') return snapshot();
  if (operation === 'find_elements') return findElements();
  if (operation === 'inspect_form') return inspectForm();
  if (operation === 'get_interactive_elements') return interactiveElements();
  if (operation === 'query_all') return queryAll();
  if (operation === 'clear_overlays') {
    all
      .filter((element) => element.matches('[data-bananabrowse-overlay]') && !element.querySelector(marker))
      .forEach((element) => element.remove());
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
  if (Object.hasOwn(actions, operation))
    return (actions as Record<string, (element: any, activator: any) => any>)[operation](element, activator);
  return { error: 'CAPABILITY_UNAVAILABLE' };
}
