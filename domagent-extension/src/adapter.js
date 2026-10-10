import { OPERATIONS, navigationUrl } from '../../shared/protocol.js';
import { boundedResult, fail, protectedRegex } from './security.js';
import { pageEvaluate, pageHelper } from './page.js';

export class BrowserAdapter {
  constructor(api, browserName) {
    this.api = api;
    this.browserName = browserName;
    this.guards = new Map();
    this.attached = new Set();
    this.nextRule = 1;
    this.onTabEvent = () => {};
    this.onWarning = error => console.error('DomAgent browser protection:', error);
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
      for (const tab of inventory) {
        if (targets.some(target => target.tabId === tab.tabId && target.attached)) {
          try {
            await this.api.debugger.detach({ tabId: tab.tabId });
          } catch (error) {
            this.onWarning(error);
            fail('PROTECTION_UNAVAILABLE');
          }
        }
      }
      this.api.debugger.onDetach.addListener(source => {
        this.attached.delete(source.tabId);
        this.onTabEvent(source.tabId, 'detached');
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
    this.api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status === 'loading' || change.url) this.onTabEvent(tabId, 'navigation', change.url);
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
  }

  async permissions() {
    if (!await this.api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })) {
      fail('PERMISSION_REQUIRED');
    }
  }

  async createTab(previousTabId) {
    if (Number.isInteger(previousTabId)) {
      try {
        const previous = await this.api.tabs.get(previousTabId);
        // A handed-off tab the owner is actively using is never adopted.
        if (!previous.active && /^https?:\/\//.test(previous.url)) return previous;
      } catch (error) {
        this.onWarning(error);
      }
    }
    return this.api.tabs.create({ url: 'about:blank', active: false });
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
    }
  }

  async release(tabId, { retainProtection = false } = {}) {
    if (this.attached.has(tabId)) {
      try {
        await this.api.debugger.detach({ tabId });
        this.attached.delete(tabId);
      } catch (error) {
        this.onWarning(error);
        fail('PROTECTION_UNAVAILABLE');
      }
    }
    if (!retainProtection) await this.dropProtection(tabId);
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
      fail('CAPABILITY_UNAVAILABLE');
    }
    const response = responses?.[0];
    if (!response || response.error || !response.result) fail('TARGET_STALE');
    if (response.result.error) fail(response.result.error);
    return response.result;
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
    const tabId = grant.tabId;
    await this.inspect(tabId, grant.protected_origins, operation === 'navigate');
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
          userGesture: false, timeout: 10_000,
        });
        if (response.exceptionDetails) fail('CAPABILITY_UNAVAILABLE');
        if (response.result?.subtype === 'error') fail('CAPABILITY_UNAVAILABLE');
        return boundedResult({ value: response.result?.value ?? null });
      }
      let responses;
      try {
        responses = await this.api.scripting.executeScript({
          target: { tabId, frameIds: [0] }, world: 'MAIN', func: pageEvaluate, args: [args.script],
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
    return this.helper(tabId, operation, args);
  }
}
