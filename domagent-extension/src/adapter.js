import { OPERATIONS, PAGE_WAIT_MS, navigationUrl, validOperationArgs } from '../../shared/protocol.js';
import { boundedResult, fail, protectedRegex } from './security.js';
import { pageEvaluate, pageHelper, sharingIndicator } from './page.js';

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
  }

  capabilities() {
    return OPERATIONS.filter(operation =>
      operation !== 'get_screenshot' || this.browserName === 'chrome' || !!this.api.tabs.captureTab);
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

  async selectedTab() {
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
    // Save the normal window before the extension-owned request window gets focus.
    await this.selectedTab();
    const window = await this.api.windows.create({
      type: 'popup', width: 440, height: 600, focused: true,
      url: this.api.runtime.getURL(`request.html?request_id=${encodeURIComponent(requestId)}`),
    });
    this.requestWindows.set(requestId, window.id);
  }

  async closeRequestWindow(requestId) {
    const windowId = this.requestWindows.get(requestId);
    this.requestWindows.delete(requestId);
    if (windowId !== undefined) await this.api.windows.remove(windowId).catch(() => {});
  }

  async actionWindow(targetId) {
    if (this.actionWindows.has(targetId)) return;
    const record = { id: null };
    this.actionWindows.set(targetId, record);
    try {
      const window = await this.api.windows.create({
        type: 'popup', width: 440, height: 600, focused: false,
        url: this.api.runtime.getURL('popup.html'),
      });
      if (this.actionWindows.get(targetId) !== record) {
        await this.api.windows.remove(window.id).catch(() => {});
        return;
      }
      record.id = window.id;
    } catch (error) {
      if (this.actionWindows.get(targetId) === record) this.actionWindows.delete(targetId);
      throw error;
    }
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
      this.onWarning(error);
      fail(operation === 'inspect' ? 'PAGE_UNAVAILABLE' : 'CAPABILITY_UNAVAILABLE');
    }
    const response = responses?.[0];
    if (response?.error) {
      fail(operation === 'inspect' ? 'PAGE_UNAVAILABLE' : 'CAPABILITY_UNAVAILABLE');
    }
    if (!response?.result) fail('TARGET_STALE');
    if (response.result.error) fail(response.result.error);
    return { ...response.result,
      ...(operation === 'inspect' && response.documentId ? { document_id: response.documentId } : {}) };
  }

  async inspect(tabId, origins, allowBlank = false) {
    const tab = await this.api.tabs.get(tabId);
    const blank = (tab.url || tab.pendingUrl) === 'about:blank' &&
      (!tab.pendingUrl || tab.pendingUrl === 'about:blank');
    if (allowBlank && blank) return { url: 'about:blank' };
    navigationUrl(tab.pendingUrl || tab.url, origins);
    if (tab.status === 'loading') fail('TARGET_STALE');
    const page = await this.helper(tabId, 'inspect', {});
    navigationUrl(page.url, origins);
    if (page.url !== tab.url) fail('TARGET_STALE');
    return page;
  }

  async execute(grant, operation, args, checkCurrent) {
    if (!validOperationArgs(operation, args)) fail('INVALID_ARGUMENT');
    const tabId = grant.tabId;
    if (operation === 'wait_for_page') {
      const deadline = Date.now() + (args.timeout_ms ?? PAGE_WAIT_MS);
      while (true) {
        checkCurrent();
        const tab = await this.api.tabs.get(tabId);
        navigationUrl(tab.pendingUrl || tab.url, grant.protected_origins);
        checkCurrent();
        if (tab.status === 'complete' && !tab.pendingUrl) {
          const page = await this.inspect(tabId, grant.protected_origins);
          checkCurrent();
          return { state: 'loaded', url: page.url, document: page.document_nonce };
        }
        if (Date.now() >= deadline) fail('WAIT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
    let context;
    if (operation === 'evaluate_script' && this.browserName === 'chrome') {
      const tree = await this.api.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      context = this.contexts.get(tabId)?.get(tree.frameTree?.frame.id);
      if (!context?.uniqueId) fail('TARGET_STALE');
      checkCurrent();
    }
    const document = await this.inspect(tabId, grant.protected_origins, operation === 'navigate');
    checkCurrent();
    if (operation === 'navigate') {
      const url = navigationUrl(args.url, grant.protected_origins);
      grant.blankAllowed = false;
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
        if (response.exceptionDetails) fail('CAPABILITY_UNAVAILABLE');
        if (response.result?.subtype === 'error') fail('CAPABILITY_UNAVAILABLE');
        return boundedResult({ value: response.result?.value ?? null });
      }
      let responses;
      try {
        responses = await this.api.scripting.executeScript({
          target: document.document_id ? { tabId, documentIds: [document.document_id] } : { tabId, frameIds: [0] },
          world: 'MAIN', func: pageEvaluate, args: [args.script],
        });
      } catch (error) {
        this.onWarning(error);
        fail('CAPABILITY_UNAVAILABLE');
      }
      if (!responses?.[0]?.result || responses[0].error) fail('CAPABILITY_UNAVAILABLE');
      if (responses[0].result.error) fail(responses[0].result.error);
      return boundedResult(responses[0].result);
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
    const deadline = Date.now() + (args.timeout_ms ?? (waitable ? 3000 : 0));
    while (true) {
      checkCurrent();
      try {
        return await this.helper(tabId, operation, { ...args, document_nonce: document.document_nonce });
      } catch (error) {
        const retryable = ['ELEMENT_NOT_FOUND', 'ELEMENT_DISABLED', 'ELEMENT_READONLY',
          'ELEMENT_NOT_VISIBLE', 'ELEMENT_OBSCURED', 'OPTION_NOT_FOUND'].includes(error.code);
        if (!waitable || !retryable || args.timeout_ms === 0) throw error;
        if (Date.now() >= deadline) fail('WAIT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }
}
