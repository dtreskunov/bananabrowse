import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserAdapter } from '../src/adapter.js';

function event() {
  const listeners = [];
  return { listeners, addListener(fn, ...args) { listeners.push({ fn, args }); } };
}

function fixture(browser = 'chrome') {
  const calls = [];
  let sessionRules = [];
  const api = {
    permissions: { async contains() { return true; } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      onActivated: event(),
      async query() { return [{ id: 1, active: true, url: 'https://site.example/' }]; },
      async get(id) { return { id, active: true, url: 'https://site.example/', status: 'complete' }; },
      async create(args) { calls.push(['create', args]); return { id: 100, ...args }; },
      async update(id, args) { calls.push(['update', id, args]); },
    },
    windows: {
      onFocusChanged: event(), onRemoved: event(),
      async get() { return { id: 10, type: 'normal' }; },
      async getAll() { return [{ id: 10, focused: true, type: 'normal' }]; },
    },
    webNavigation: { onBeforeNavigate: event(), onErrorOccurred: event() },
    webRequest: { onBeforeRequest: event() },
    declarativeNetRequest: {
      async getSessionRules() { return sessionRules; },
      async updateSessionRules(args) { calls.push(['rules', args]); sessionRules = args.addRules || []; },
    },
    debugger: {
      onDetach: event(), onEvent: event(),
      async getTargets() { return []; },
      async attach(args) { calls.push(['attach', args]); },
      async detach(args) { calls.push(['detach', args]); },
      async sendCommand(target, method, args) {
        calls.push(['cdp', target, method, args]);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
        return { result: { value: 'page' }, data: 'aW1hZ2U=' };
      },
    },
    scripting: {
      async executeScript(args) {
        calls.push(['script', args]);
        return [{ result: args.args[0] === 'inspect' ? { url: 'https://site.example/' } : { value: 'page' } }];
      },
    },
  };
  const adapter = new BrowserAdapter(api, browser);
  adapter.contexts.set(100, new Map([['main-frame', { id: 1, uniqueId: 'main-context' }]]));
  return { api, calls, adapter };
}

test('cosmetic indicator cleanup cannot delay debugger and network protection teardown', async () => {
  const f = fixture();
  await f.adapter.initialize([]);
  await f.adapter.protect(100, ['https://control.example']);
  await f.adapter.attach(100);
  let finish;
  f.api.scripting.executeScript = () => new Promise(resolve => { finish = resolve; });
  await f.adapter.release(100, { indicatorToken: 'old-marker' });
  assert.equal(f.adapter.attached.has(100), false);
  assert.equal(f.adapter.guards.has(100), false);
  assert.equal(f.calls.some(call => call[0] === 'detach'), true);
  finish([]);
});

test('Chrome installs tab-scoped blocking for all resources and removes only its own rules', async () => {
  const f = fixture();
  await f.adapter.initialize([]);
  await f.adapter.protect(100, ['https://control.example', 'https://idp.example']);
  const { addRules } = f.calls[0][1];
  assert.equal(addRules.length, 4);
  for (const rule of addRules) {
    assert.equal(rule.action.type, 'block');
    assert.deepEqual(rule.condition.tabIds, [100]);
    if (rule.condition.resourceTypes) assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.equal(rule.condition.excludedResourceTypes, undefined);
    assert.match(rule.condition.regexFilter, /^\^https:/);
  }
  assert.equal(addRules.filter(rule => rule.condition.resourceTypes === undefined).length, 2);
  await f.adapter.attach(100);
  await f.adapter.release(100);
  assert.deepEqual(f.calls.at(-1)[1].removeRuleIds, addRules.map(rule => rule.id));
  assert.equal(f.adapter.guards.size, 0);
  assert.equal(f.calls.some(call => call[0] === 'detach'), true);
});

test('protected redirects retain their rules until the browser has rejected the pending request', async () => {
  const f = fixture();
  const events = [];
  f.adapter.onTabEvent = (...args) => events.push(args);
  await f.adapter.initialize([]);
  await f.adapter.protect(100, ['https://control.example']);
  await f.adapter.attach(100);
  f.api.webNavigation.onBeforeNavigate.listeners[0].fn({
    tabId: 100, frameId: 0, url: 'https://control.example/login',
  });
  assert.equal(events[0][1], 'protected_pending');
  await f.adapter.release(100, { retainProtection: true });
  assert.equal(f.adapter.guards.has(100), true);
  assert.equal(f.calls.some(call => call[0] === 'rules' && call[1].removeRuleIds), false);
  f.api.webNavigation.onErrorOccurred.listeners[0].fn({
    tabId: 100, frameId: 0, url: 'https://control.example/login', error: 'net::ERR_BLOCKED_BY_CLIENT',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.adapter.guards.has(100), false);
});

test('Firefox blocks protected redirects/subresources for only the dedicated tab', async () => {
  const f = fixture('firefox');
  await f.adapter.initialize([]);
  await f.adapter.protect(100, ['https://control.example']);
  const listener = f.api.webRequest.onBeforeRequest.listeners[0];
  assert.deepEqual(listener.args[1], ['blocking']);
  const request = { tabId: 100, type: 'sub_frame', url: 'https://control.example/login' };
  assert.deepEqual(listener.fn(request), { cancel: true });
  assert.deepEqual(listener.fn({ ...request, type: 'xmlhttprequest' }), { cancel: true });
  assert.deepEqual(listener.fn({ ...request, tabId: 1 }), {});
  assert.deepEqual(listener.fn({ ...request, url: 'https://control.example.evil/' }), { cancel: false });
  await f.adapter.release(100);
  assert.deepEqual(listener.fn(request), {});
});

test('lack of permission or blocking API fails closed', async () => {
  const f = fixture();
  f.api.permissions.contains = async () => false;
  await assert.rejects(f.adapter.protect(100, ['https://control.example']), /PERMISSION_REQUIRED/);
  assert.equal(f.calls.length, 0);
  const firefox = fixture('firefox');
  delete firefox.api.webRequest;
  await assert.rejects(firefox.adapter.initialize([]), /PROTECTION_UNAVAILABLE/);
});

test('failed privileged detach retains protection and reports failure rather than silently dropping it', async () => {
  const f = fixture();
  f.adapter.onWarning = () => {};
  await f.adapter.protect(100, ['https://control.example']);
  await f.adapter.attach(100);
  f.api.debugger.detach = async () => { throw new Error('Debugger detach failed'); };
  await assert.rejects(f.adapter.release(100), /PROTECTION_UNAVAILABLE/);
  assert.equal(f.adapter.guards.has(100), true);
  assert.equal(f.adapter.attached.has(100), true);
  assert.equal(f.calls.some(call => call[0] === 'rules' && call[1].removeRuleIds), false);
});

test('only the user-selected normal-window tab can be shared; no dedicated tab adoption', async () => {
  const f = fixture();
  assert.equal((await f.adapter.selectedTabById(1)).id, 1);
  await assert.rejects(f.adapter.selectedTabById(2), /TARGET_STALE/);
  f.api.tabs.query = async () => [{ id: 3, url: 'chrome://settings' }];
  assert.equal(await f.adapter.selectedTab(), null);
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

test('neutral or protected pages are not eligible for sharing', async () => {
  const f = fixture();
  f.api.tabs.get = async () => ({ id: 100, pendingUrl: 'about:blank', status: 'loading' });
  assert.deepEqual(await f.adapter.inspect(100, ['https://control.example'], true), { url: 'about:blank' });
  await assert.rejects(f.adapter.inspect(100, ['https://control.example'], false), /HANDOFF_REQUIRED/);
  f.api.tabs.get = async () => ({ id: 100, url: 'about:blank', pendingUrl: 'https://control.example/login' });
  await assert.rejects(f.adapter.inspect(100, ['https://control.example'], true), /HANDOFF_REQUIRED/);
});

test('Chrome dispatcher only issues narrowly named tab evaluation/screenshot methods', async () => {
  const f = fixture();
  const grant = { tabId: 100, protected_origins: ['https://control.example'] };
  await f.adapter.execute(grant, 'evaluate_script', { script: 'document.title' }, () => {});
  await f.adapter.execute(grant, 'get_screenshot', {}, () => {});
  const methods = f.calls.filter(call => call[0] === 'cdp');
  assert.deepEqual(methods.map(call => call[2]), ['Page.getFrameTree', 'Runtime.evaluate', 'Page.captureScreenshot']);
  assert.ok(methods.every(call => call[1].tabId === 100));
  assert.equal(methods[1][3].contextId, undefined);
  assert.equal(methods[1][3].uniqueContextId, 'main-context');
});

test('Firefox remote script is passed as data to MAIN only, not a content-message dispatcher', async () => {
  const f = fixture('firefox');
  const grant = { tabId: 100, protected_origins: ['https://control.example'] };
  const script = 'typeof browser';
  await f.adapter.execute(grant, 'evaluate_script', { script }, () => {});
  const scripts = f.calls.filter(call => call[0] === 'script').map(call => call[1]);
  assert.equal(scripts[0].world, 'ISOLATED');
  assert.equal(scripts[1].world, 'MAIN');
  assert.deepEqual(scripts[1].args, [script]);
  assert.deepEqual(scripts[1].target, { tabId: 100, frameIds: [0] });
  f.api.scripting.executeScript = async args => {
    if (args.world === 'MAIN') return [{ result: { error: 'CAPABILITY_UNAVAILABLE' } }];
    return [{ result: { url: 'https://site.example/' } }];
  };
  await assert.rejects(f.adapter.execute(grant, 'evaluate_script', { script }, () => {}), /CAPABILITY_UNAVAILABLE/);
});

test('Firefox screenshots capture the target tab or advertise unavailable; never the visible tab', async () => {
  const f = fixture('firefox');
  assert.equal(f.adapter.capabilities().includes('get_screenshot'), false);
  const grant = { tabId: 100, protected_origins: ['https://control.example'] };
  await assert.rejects(f.adapter.execute(grant, 'get_screenshot', {}, () => {}), /CAPABILITY_UNAVAILABLE/);
  let captured;
  f.api.tabs.captureTab = async id => { captured = id; return 'data:image/png;base64,aW1hZ2U='; };
  assert.equal(f.adapter.capabilities().includes('get_screenshot'), true);
  assert.deepEqual(await f.adapter.execute(grant, 'get_screenshot', {}, () => {}),
    { mimeType: 'image/png', data: 'aW1hZ2U=' });
  assert.equal(captured, 100);
  f.adapter.onWarning = () => {};
  f.api.tabs.captureTab = async () => { throw new Error('Capture permission unavailable'); };
  await assert.rejects(f.adapter.execute(grant, 'get_screenshot', {}, () => {}), /CAPABILITY_UNAVAILABLE/);
});

test('failed document inspection is not an optional-operation capability failure', async () => {
  const f = fixture('firefox');
  f.adapter.onWarning = () => {};
  f.api.scripting.executeScript = async () => { throw new Error('Browser refuses document injection'); };
  const grant = { tabId: 100, protected_origins: ['https://control.example'] };
  for (const operation of ['navigate', 'get_text', 'get_interactive_elements']) {
    await assert.rejects(f.adapter.execute(grant, operation,
      operation === 'navigate' ? { url: 'https://other.example/' } : {}, () => {}), /PAGE_UNAVAILABLE/);
  }
  assert.equal(f.calls.some(call => call[0] === 'update'), false);
  f.api.scripting.executeScript = async () => [{ error: new Error('Document execution failed') }];
  await assert.rejects(f.adapter.inspect(100, grant.protected_origins), /PAGE_UNAVAILABLE/);
});

test('actionability waits use the configured deadline and never retry a mutation after execution', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, protected_origins: [] };
  let attempts = 0;
  f.api.scripting.executeScript = async ({ args }) => {
    if (args[0] === 'inspect') return [{ result: { url: 'https://site.example/', document_nonce: 'document-1' } }];
    attempts++;
    return [{ result: attempts < 3 ? { error: 'ELEMENT_DISABLED' } : { clicked: true } }];
  };
  const work = f.adapter.execute(grant, 'click', { selector: 'button', timeout_ms: 100 }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  t.mock.timers.tick(50);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  t.mock.timers.tick(50);
  assert.deepEqual(await work, { clicked: true });
  assert.equal(attempts, 3);

  f.api.scripting.executeScript = async ({ args }) => [{ result: args[0] === 'inspect'
    ? { url: 'https://site.example/', document_nonce: 'document-1' } : { error: 'OPERATION_FAILED' } }];
  await assert.rejects(f.adapter.execute(grant, 'click', { selector: 'button' }, () => {}), /OPERATION_FAILED/);
});

test('readiness deadlines and cancellation during waits are enforced without executing later work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, protected_origins: [] };
  let attempts = 0;
  f.api.scripting.executeScript = async ({ args }) => {
    if (args[0] === 'inspect') return [{ result: { url: 'https://site.example/', document_nonce: 'document-1' } }];
    attempts++;
    return [{ result: { error: 'ELEMENT_NOT_FOUND' } }];
  };
  const expired = f.adapter.execute(grant, 'click', { selector: '#missing', timeout_ms: 50 }, () => {});
  const rejected = assert.rejects(expired, /WAIT_TIMEOUT/);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(attempts, 2);

  let cancelled = false;
  const waiting = f.adapter.execute(grant, 'type_text', { selector: '#missing', text: 'not typed' }, () => {
    if (cancelled) throw new Error('APPROVAL_REQUIRED');
  });
  const stopped = assert.rejects(waiting, /APPROVAL_REQUIRED/);
  await new Promise(resolve => setImmediate(resolve));
  const before = attempts;
  cancelled = true;
  t.mock.timers.tick(50);
  await stopped;
  assert.equal(attempts, before);
});

test('wait_for_page distinguishes loaded state from navigation started and blocks protected destinations', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, protected_origins: ['https://control.example'] };
  let loading = true;
  f.api.tabs.get = async () => ({ url: 'https://site.example/', status: loading ? 'loading' : 'complete' });
  f.api.scripting.executeScript = async () => [{ result: { url: 'https://site.example/', document_nonce: 'document-1' } }];
  const waiting = f.adapter.execute(grant, 'wait_for_page', { timeout_ms: 100 }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  loading = false;
  t.mock.timers.tick(50);
  assert.deepEqual(await waiting, { state: 'loaded', url: 'https://site.example/', document: 'document-1' });
  loading = true;
  await assert.rejects(f.adapter.execute(grant, 'wait_for_page', { timeout_ms: 0 }, () => {}), /WAIT_TIMEOUT/);
  f.api.tabs.get = async () => ({ pendingUrl: 'https://control.example/login', status: 'loading' });
  await assert.rejects(f.adapter.execute(grant, 'wait_for_page', {}, () => {}), /HANDOFF_REQUIRED/);
});
