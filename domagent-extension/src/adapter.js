import { OPERATIONS, PAGE_WAIT_MS, DEFAULT_OUTPUT_BYTES, READINESS_ERRORS, navigationUrl, validOperationArgs } from '../../shared/protocol.js';
import { boundedResult, fail, protectedRegex } from './security.js';
import { compactResult } from '../../shared/results.js';
import { pageEvaluate, pageHelper, sharingIndicator } from './page.js';
import { actionSummary } from './approval-summary.js';

export function injectionReason(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/missing host permission|cannot access contents|permission.*(?:denied|tab)/i.test(message)) return 'permission_denied';
  if (/restricted|not allowed.*(?:page|url)|cannot.*(?:privileged|about:)|extensions.*(?:not permitted|not allowed)/i.test(message)) {
    return 'browser_restricted';
  }
  if (/(?:frame|document|tab).*(?:removed|closed|not found|does not exist)|no (?:frame|tab)|frame.*not ready/i.test(message)) {
    return 'frame_unavailable';
  }
  return 'unknown';
}

export class BrowserAdapter {
  constructor(api, browserName) {
    this.api = api;
    this.browserName = browserName;
    this.guards = new Map();
    this.attached = new Set();
    this.contexts = new Map();
    this.nextRule = 1;
    this.onTabEvent = () => {};
    this.onWarning = () => console.error('DomAgent browser protection unavailable');
    this.requestWindows = new Map();
    this.actionWindows = new Map();
    this.selectedWindowId = null;
    this.onRequestClosed = () => {};
    this.workspaces = new Map();
  }

  capabilities() {
    return OPERATIONS.filter(operation =>
      operation !== 'get_screenshot' || this.browserName === 'chrome' || !!this.api.tabs.captureTab);
  }

  async browserInfo() {
    const version = this.api.runtime.getManifest().version;
    const browser = this.api.runtime.getBrowserInfo ? await this.api.runtime.getBrowserInfo() : null;
    return { extension_version: version, browser_name: this.browserName, browser_version: browser?.version ?? null };
  }

  async initialize(inventory) {
    if (this.browserName === 'chrome') {
      const rules = await this.api.declarativeNetRequest.getSessionRules();
      if (rules.length) await this.api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rules.map(rule => rule.id),
      });
      const targets = await this.api.debugger.getTargets();
      for (const target of targets.filter(target => target.attached && Number.isInteger(target.tabId))) {
        // Chrome only permits detaching this extension's own attachment. Never
        // resume a grant, even if the worker restarted while a tab stayed open.
        await this.api.debugger.detach({ tabId: target.tabId }).catch(() => {});
      }
      this.api.debugger.onDetach.addListener(source => {
        this.attached.delete(source.tabId);
        this.contexts.delete(source.tabId);
        this.onTabEvent(source.tabId, 'detached');
      });
      this.api.debugger.onEvent.addListener((source, method, params) => {
        if (!this.attached.has(source.tabId)) return;
        if (method === 'Runtime.executionContextsCleared') this.contexts.delete(source.tabId);
        if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) {
          const contexts = this.contexts.get(source.tabId) || new Map();
          contexts.set(params.context.auxData.frameId, params.context);
          this.contexts.set(source.tabId, contexts);
        }
        if (method === 'Runtime.executionContextDestroyed') {
          for (const [frame, context] of this.contexts.get(source.tabId) || []) {
            if (context.id === params.executionContextId) this.contexts.get(source.tabId).delete(frame);
          }
        }
      });
    } else {
      if (!this.api.webRequest?.onBeforeRequest) fail('PROTECTION_UNAVAILABLE');
      this.api.webRequest.onBeforeRequest.addListener(details => {
        const guard = this.guards.get(details.tabId);
        if (!guard) return {};
        let blocked = false;
        try {
          blocked = guard.origins.includes(new URL(details.url).origin);
        } catch (error) {
          this.onWarning(error);
          blocked = true;
        }
        if (blocked && details.type === 'main_frame') this.onTabEvent(details.tabId, 'protected_pending');
        return { cancel: blocked };
      }, { urls: ['http://*/*', 'https://*/*'] }, ['blocking']);
    }
    this.api.tabs.onActivated?.addListener(info => {
      void this.rememberWindow(info.windowId).catch(() => {});
    });
    this.api.windows?.onFocusChanged.addListener(windowId => {
      void this.rememberWindow(windowId).catch(() => {});
    });
    this.api.windows?.onRemoved.addListener(windowId => {
      if (this.selectedWindowId === windowId) this.selectedWindowId = null;
      for (const [targetId, window] of this.actionWindows) {
        if (window.id === windowId) this.actionWindows.delete(targetId);
      }
      for (const [requestId, id] of this.requestWindows) {
        if (id !== windowId) continue;
        this.requestWindows.delete(requestId);
        this.onRequestClosed(requestId);
      }
    });
    this.api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status === 'loading' || change.url) this.onTabEvent(tabId, 'navigation', change.url);
      if (change.status === 'complete') this.onTabEvent(tabId, 'complete');
    });
    this.api.tabs.onRemoved.addListener(tabId => this.onTabEvent(tabId, 'closed'));
    this.api.tabs.onRemoved.addListener(tabId => this.workspaces.delete(tabId));
    const changed = () => {
      void this.verifyWorkspaces().catch(error => this.onWarning(error));
    };
    this.api.tabs.onAttached?.addListener((tabId, info) => {
      for (const [ownedId, record] of this.workspaces) {
        if (info.newWindowId === record.windowId && tabId !== ownedId) this.onTabEvent(ownedId, 'workspace_changed');
      }
      changed();
    });
    this.api.tabs.onDetached?.addListener(tabId => {
      if (this.workspaces.has(tabId)) this.onTabEvent(tabId, 'workspace_changed');
      changed();
    });
    this.api.tabs.onCreated?.addListener(tab => {
      if (this.workspaces.has(tab.openerTabId)) this.onTabEvent(tab.openerTabId, 'workspace_changed');
      for (const [ownedId, record] of this.workspaces) {
        if (tab.windowId === record.windowId && tab.id !== ownedId) this.onTabEvent(ownedId, 'workspace_changed');
      }
      changed();
    });
    this.api.webNavigation.onBeforeNavigate.addListener(details => {
      if (details.frameId !== 0) return;
      const guard = this.guards.get(details.tabId);
      const protectedPage = guard?.origins.includes(new URL(details.url).origin);
      this.onTabEvent(details.tabId, protectedPage ? 'protected_pending' : 'navigation', details.url);
    });
    this.api.webNavigation.onErrorOccurred.addListener(details => {
      if (details.frameId !== 0) return;
      this.onTabEvent(details.tabId, 'navigation', details.url);
      const guard = this.guards.get(details.tabId);
      if (guard?.origins.includes(new URL(details.url).origin)) {
        // The browser has now rejected this request. Removing a rule during
        // onBeforeNavigate would let the pending protected redirect escape it.
        void this.releaseAfterNavigation(details.tabId).catch(error => this.onWarning(error));
      }
    });
    for (const tab of inventory) {
      await this.removeIndicator(tab.tabId).catch(() => this.onWarning(new Error('INDICATOR_UNAVAILABLE')));
    }
  }

  async permissions() {
    if (!await this.api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })) {
      fail('PERMISSION_REQUIRED');
    }
  }

  async rememberWindow(windowId) {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    const window = await this.api.windows.get(windowId);
    if (window.type === 'normal') this.selectedWindowId = windowId;
  }

  async selectedTab(windowId) {
    if (windowId !== undefined) {
      if (!Number.isSafeInteger(windowId) || windowId < 0) fail('INVALID_ARGUMENT');
      if ((await this.api.windows.get(windowId)).type !== 'normal') fail('TARGET_STALE');
      const tabs = await this.api.tabs.query({ windowId, active: true });
      const tab = tabs[0];
      return tab && /^https?:\/\//.test(tab.pendingUrl || tab.url) ? tab : null;
    }
    if (this.selectedWindowId === null) {
      const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
      const window = windows.find(window => window.focused) || windows.at(-1);
      if (!window) return null;
      this.selectedWindowId = window.id;
    }
    const tabs = await this.api.tabs.query({ windowId: this.selectedWindowId, active: true });
    const tab = tabs[0];
    return tab && /^https?:\/\//.test(tab.pendingUrl || tab.url) ? tab : null;
  }

  async selectedTabById(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) fail('INVALID_ARGUMENT');
    const tab = await this.selectedTab();
    if (tab?.id !== tabId) fail('TARGET_STALE');
    return tab;
  }

  async requestWindow(requestId) {
    // A remote request cannot supply the gesture required to open native panels.
    this.onPanelNeeded?.(requestId);
  }

  async closeRequestWindow(requestId) {
    const windowId = this.requestWindows.get(requestId);
    this.requestWindows.delete(requestId);
    if (windowId !== undefined) await this.api.windows.remove(windowId).catch(() => {});
  }

  async actionWindow(targetId) {
    this.onPanelNeeded?.(targetId);
  }

  async openPanel(tab) {
    if (this.browserName === 'chrome') return this.api.sidePanel.open({ tabId: tab.id });
    return this.api.sidebarAction.open();
  }

  async createWorkspace(tabId) {
    const existing = this.workspaces.get(tabId);
    if (existing && !existing.boundaryLost) {
      await this.assertWorkspace({ tabId, windowId: existing.windowId });
      return existing.windowId;
    }
    this.workspaces.delete(tabId);
    const window = await this.api.windows.create({ tabId, type: 'normal', focused: true });
    this.workspaces.set(tabId, { windowId: window.id, boundaryLost: false });
    this.selectedWindowId = window.id;
    if (this.browserName === 'chrome') {
      await this.api.sidePanel.setOptions({ tabId, path: `panel.html?window_id=${window.id}`, enabled: true });
    }
    try { await this.openPanel({ id: tabId }); }
    catch (error) { this.onWarning(Object.assign(error, { code: 'PANEL_OPEN_REQUIRED' })); }
    await this.assertWorkspace({ tabId, windowId: window.id });
    return window.id;
  }

  async assertWorkspace(grant) {
    if (!Number.isSafeInteger(grant.windowId)) fail('WORKSPACE_CHANGED');
    const tab = await this.api.tabs.get(grant.tabId);
    const tabs = await this.api.tabs.query({ windowId: grant.windowId });
    if (tab.windowId !== grant.windowId || tabs.length !== 1 || tabs[0].id !== grant.tabId) fail('WORKSPACE_CHANGED');
  }

  async verifyWorkspaces() {
    for (const [tabId, record] of this.workspaces) {
      if (record.boundaryLost) continue;
      try { await this.assertWorkspace({ tabId, windowId: record.windowId }); }
      catch (error) {
        this.onWarning(error);
        record.boundaryLost = true;
        this.onTabEvent(tabId, 'workspace_changed');
      }
    }
  }

  async closeWorkspace(tabId, windowId) {
    const record = this.workspaces.get(tabId);
    if (!record || record.windowId !== windowId) fail('WORKSPACE_CHANGED');
    const tab = await this.api.tabs.get(tabId);
    if (tab.windowId !== windowId) fail('WORKSPACE_CHANGED');
    await this.api.tabs.remove(tabId);
    this.workspaces.delete(tabId);
  }

  workspaceList() {
    return [...this.workspaces].map(([tabId, record]) => ({ tabId, windowId: record.windowId }));
  }

  async closeActionWindow(targetId) {
    const record = this.actionWindows.get(targetId);
    this.actionWindows.delete(targetId);
    if (record?.id !== undefined && record?.id !== null) await this.api.windows.remove(record.id).catch(() => {});
  }

  async protect(tabId, origins) {
    await this.permissions();
    if (this.guards.has(tabId)) fail('PROTECTION_UNAVAILABLE');
    if (this.browserName === 'chrome') {
      const rules = origins.flatMap(origin => {
        const condition = { regexFilter: protectedRegex(origin), isUrlFilterCaseSensitive: false, tabIds: [tabId] };
        // Chrome's default resource types exclude main_frame. Keep a broad
        // rule for every subresource, and explicitly cover top-level redirects.
        return [
          { id: this.nextRule++, priority: 1, action: { type: 'block' }, condition },
          { id: this.nextRule++, priority: 1, action: { type: 'block' },
            condition: { ...condition, resourceTypes: ['main_frame'] } },
        ];
      });
      const ruleIds = rules.map(rule => rule.id);
      await this.api.declarativeNetRequest.updateSessionRules({ addRules: rules });
      this.guards.set(tabId, { origins, ruleIds });
    } else {
      // Firefox's blocking listener is installed before a tab can be granted.
      this.guards.set(tabId, { origins });
    }
  }

  async attach(tabId) {
    if (this.browserName === 'chrome') {
      await this.api.debugger.attach({ tabId }, '1.3');
      this.attached.add(tabId);
      await this.api.debugger.sendCommand({ tabId }, 'Runtime.enable');
    }
  }

  async release(tabId, { retainProtection = false, indicatorToken } = {}) {
    // Decoration must never delay teardown of actual browser authority.
    if (indicatorToken) {
      void this.removeIndicator(tabId, indicatorToken).catch(() => this.onWarning(new Error('INDICATOR_UNAVAILABLE')));
    }
    if (this.attached.has(tabId)) {
      try {
        await this.api.debugger.detach({ tabId });
        this.attached.delete(tabId);
        this.contexts.delete(tabId);
      } catch (error) {
        this.onWarning(error);
        fail('PROTECTION_UNAVAILABLE');
      }
    }
    if (!retainProtection) await this.dropProtection(tabId);
  }

  async indicator(tabId, details) {
    const tab = await this.api.tabs.get(tabId);
    if (tab.url === 'about:blank') return null;
    const results = await this.api.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: sharingIndicator, args: [details],
    });
    if (!results?.[0]?.result?.url || results[0].error) fail('INDICATOR_UNAVAILABLE');
    return { url: results[0].result.url, documentId: results[0].documentId };
  }

  async removeIndicator(tabId, token) {
    await this.api.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: sharingIndicator,
      args: [token ? { remove: true, token } : null],
    });
  }

  async dropProtection(tabId) {
    const guard = this.guards.get(tabId);
    if (guard?.ruleIds) {
      // Retain the guard record on failure; later cleanup may retry it.
      await this.api.declarativeNetRequest.updateSessionRules({ removeRuleIds: guard.ruleIds });
    }
    this.guards.delete(tabId);
  }

  async releaseAfterNavigation(tabId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const tab = await this.api.tabs.get(tabId);
      if (tab.status === 'complete' && !tab.pendingUrl) {
        await this.dropProtection(tabId);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fail('PROTECTION_UNAVAILABLE');
  }

  async helper(tabId, operation, args) {
    let responses;
    try {
      responses = await this.api.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: pageHelper, args: [operation, args],
      });
    } catch (error) {
      if (operation !== 'inspect') this.onWarning(error);
      if (operation === 'inspect') {
        throw Object.assign(new Error('PAGE_UNAVAILABLE'), {
          code: 'PAGE_UNAVAILABLE', injection_reason: injectionReason(error),
        });
      }
      fail('CAPABILITY_UNAVAILABLE');
    }
    const response = responses?.[0];
    if (response?.error) {
      if (operation === 'inspect') throw Object.assign(new Error('PAGE_UNAVAILABLE'), {
        code: 'PAGE_UNAVAILABLE', injection_reason: 'helper_execution_failed',
      });
      fail('CAPABILITY_UNAVAILABLE');
    }
    if (!response?.result) {
      throw Object.assign(new Error('TARGET_STALE'), {
        code: 'TARGET_STALE', ...(operation === 'inspect' ? { injection_reason: 'empty_result' } : {}),
      });
    }
    if (response.result.error) fail(response.result.error);
    return { ...(['get_text', 'get_page_snapshot', 'get_interactive_elements', 'inspect_element'].includes(operation)
      ? compactResult(operation, response.result, args) : response.result),
      ...(operation === 'inspect' && response.documentId ? { document_id: response.documentId } : {}) };
  }

  async inspect(tabId, origins, allowBlank = false) {
    const tab = await this.api.tabs.get(tabId);
    const blank = (tab.url || tab.pendingUrl) === 'about:blank' &&
      (!tab.pendingUrl || tab.pendingUrl === 'about:blank');
    if (allowBlank && blank) return { url: 'about:blank' };
    navigationUrl(tab.pendingUrl || tab.url, origins);
    if (tab.status === 'loading' || tab.pendingUrl) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'tab_status' });
    }
    let page;
    try { page = await this.helper(tabId, 'inspect', {}); }
    catch (error) {
      if (['PAGE_UNAVAILABLE', 'TARGET_STALE'].includes(error.code)) error.inspection_stage = 'document_injection';
      throw error;
    }
    navigationUrl(page.url, origins);
    if (page.ready_state && page.ready_state !== 'complete') {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_state' });
    }
    const current = await this.api.tabs.get(tabId);
    navigationUrl(current.pendingUrl || current.url, origins);
    if (page.url !== tab.url || current.url !== page.url || current.status === 'loading' || current.pendingUrl) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_changed' });
    }
    return page;
  }

  async waitForInspection(grant, timeoutMs, check, allowBlank = false) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      check();
      await this.assertWorkspace(grant);
      try {
        const page = await this.inspect(grant.tabId, grant.protected_origins, allowBlank);
        const navigation = grant.navigation;
        if (navigation && page.document_nonce === navigation.document && (
          navigation.from === navigation.url || page.url !== navigation.url
        )) {
          throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_changed' });
        }
        if (navigation) delete grant.navigation;
        check();
        return page;
      } catch (error) {
        check();
        if (!['TARGET_STALE', 'PAGE_UNAVAILABLE'].includes(error.code) || !error.inspection_stage) throw error;
        if (Date.now() >= deadline) {
          delete grant.navigation;
          let code = error.code;
          if (code === 'TARGET_STALE' && timeoutMs > 0) code = 'WAIT_TIMEOUT';
          throw Object.assign(new Error(code), {
            code, inspection_stage: error.inspection_stage, last_error: error.code, timeout_ms: timeoutMs,
            ...(error.injection_reason ? { injection_reason: error.injection_reason } : {}),
          });
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }

  async prepareAction(grant, operation, args, check = () => {}) {
    await this.assertWorkspace(grant);
    if (['wait_for_page', 'request_handoff'].includes(operation)) {
      const tab = await this.api.tabs.get(grant.tabId);
      navigationUrl(tab.pendingUrl || tab.url, grant.protected_origins);
      return { summary: actionSummary(operation, args, { title: tab.title, url: tab.pendingUrl || tab.url }) };
    }
    const page = await this.waitForInspection(grant, args.timeout_ms ?? PAGE_WAIT_MS, check, operation === 'navigate');
    let target;
    if (operation !== 'inspect_element' && (args.selector || args.ref)) {
      target = await this.helper(grant.tabId, 'prepare_action', {
        ...args, action: operation, document_nonce: page.document_nonce,
      });
    }
    return { summary: actionSummary(operation, args, page, target?.matches === 1 ? target : null),
      document_nonce: page.document_nonce, approval_token: target?.approval_token };
  }

  async releaseAction(grant, preview) {
    if (preview?.approval_token) {
      await this.helper(grant.tabId, 'release_action', { approval_token: preview.approval_token });
    }
  }

  async execute(grant, operation, args, checkCurrent, preview) {
    if (!validOperationArgs(operation, args)) fail('INVALID_ARGUMENT');
    await this.assertWorkspace(grant);
    const tabId = grant.tabId;
    if (operation === 'wait_for_page') {
      let page;
      try { page = await this.waitForInspection(grant, args.timeout_ms ?? PAGE_WAIT_MS, checkCurrent); }
      catch (error) {
        if (error.code === 'TARGET_STALE' && args.timeout_ms === 0) {
          error.code = error.message = 'WAIT_TIMEOUT';
        }
        throw error;
      }
      return { state: 'loaded', url: page.url, document: page.document_nonce,
        ...(page.content_type ? { content_type: page.content_type } : {}) };
    }
    const document = await this.waitForInspection(grant, args.timeout_ms ?? PAGE_WAIT_MS, checkCurrent, operation === 'navigate');
    if (preview?.document_nonce && preview.document_nonce !== document.document_nonce) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_changed' });
    }
    let context;
    if (operation === 'evaluate_script' && this.browserName === 'chrome') {
      const tree = await this.api.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      context = this.contexts.get(tabId)?.get(tree.frameTree?.frame.id);
      if (!context?.uniqueId) fail('TARGET_STALE');
      checkCurrent();
    }
    if (operation === 'navigate') {
      const url = navigationUrl(args.url, grant.protected_origins);
      grant.blankAllowed = false;
      grant.navigation = { document: document.document_nonce, from: document.url, url };
      await this.api.tabs.update(tabId, { url });
      return { url, navigation_started: true };
    }
    if (operation === 'evaluate_script') {
      if (this.browserName === 'chrome') {
        // The remote caller chooses only page source, never a CDP method/target/context.
        const response = await this.api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: args.script, awaitPromise: true, returnByValue: true,
          userGesture: false, timeout: 10_000, uniqueContextId: context.uniqueId,
        });
        if (response.exceptionDetails || response.result?.subtype === 'error') {
          const exception = response.exceptionDetails?.exception || response.result;
          fail(exception?.className === 'SyntaxError' ? 'SCRIPT_SYNTAX_ERROR' : 'SCRIPT_RUNTIME_ERROR');
        }
        if (response.result?.unserializableValue !== undefined || response.result?.type === 'function') {
          fail('SCRIPT_SERIALIZATION_ERROR');
        }
        try {
          return compactResult(operation, { value: response.result?.value ?? null }, args);
        } catch (error) {
          if (error.code === 'RESULT_TOO_LARGE') throw error;
          fail('SCRIPT_SERIALIZATION_ERROR');
        }
      }
      let responses;
      try {
        responses = await this.api.scripting.executeScript({
          target: document.document_id ? { tabId, documentIds: [document.document_id] } : { tabId, frameIds: [0] },
          world: 'MAIN', func: pageEvaluate, args: [args.script, args.max_output_bytes ?? DEFAULT_OUTPUT_BYTES],
        });
      } catch (error) {
        this.onWarning(error);
        fail('SCRIPT_EXECUTION_UNAVAILABLE');
      }
      if (!responses?.[0]?.result || responses[0].error) fail('SCRIPT_EXECUTION_UNAVAILABLE');
      if (responses[0].result.error) fail(responses[0].result.error);
      return compactResult(operation, responses[0].result, args);
    }
    if (operation === 'get_screenshot') {
      if (this.browserName === 'chrome') {
        const screenshot = await this.api.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: false,
        });
        if (typeof screenshot.data !== 'string' || !screenshot.data.length) fail('CAPABILITY_UNAVAILABLE');
        return boundedResult({ mimeType: 'image/png', data: screenshot.data });
      }
      if (!this.api.tabs.captureTab) fail('CAPABILITY_UNAVAILABLE');
      let screenshot;
      try {
        screenshot = await this.api.tabs.captureTab(tabId, { format: 'png' });
      } catch (error) {
        this.onWarning(error);
        fail('CAPABILITY_UNAVAILABLE');
      }
      if (typeof screenshot !== 'string' || !screenshot.startsWith('data:image/png;base64,')) {
        fail('CAPABILITY_UNAVAILABLE');
      }
      return boundedResult({ mimeType: 'image/png', data: screenshot.split(',')[1] });
    }
    const waitable = ['click', 'type_text', 'get_text', 'select_option', 'set_checked', 'press_key', 'scroll'].includes(operation);
    const timeoutMs = args.timeout_ms ?? (waitable ? 3000 : 0);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      checkCurrent();
      await this.assertWorkspace(grant);
      try {
        return await this.helper(tabId, operation, { ...args, document_nonce: document.document_nonce,
          ...(preview?.approval_token ? { approval_token: preview.approval_token } : {}) });
      } catch (error) {
        const retryable = READINESS_ERRORS.includes(error.code);
        if (!waitable || !retryable || args.timeout_ms === 0) throw error;
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('WAIT_TIMEOUT'), { code: 'WAIT_TIMEOUT', last_error: error.code, timeout_ms: timeoutMs });
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }
}
