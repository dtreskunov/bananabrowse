import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserAdapter, injectionReason } from '../src/adapter.js';
import { runInNewContext } from 'node:vm';

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, ...args) {
      listeners.push({ fn, args });
    },
  };
}

function fixture(browser = 'chrome') {
  const calls = [];
  let sessionRules = [];
  const api = {
    runtime: {
      getManifest() {
        return { version: '4.3.3' };
      },
    },
    permissions: {
      async contains() {
        return true;
      },
    },
    tabs: {
      onUpdated: event(),
      onRemoved: event(),
      onActivated: event(),
      onCreated: event(),
      onAttached: event(),
      onDetached: event(),
      async query(args) {
        return [{ id: args.active ? 1 : 100, windowId: 10, active: true, url: 'https://site.example/' }];
      },
      async get(id) {
        return { id, windowId: 10, active: true, url: 'https://site.example/', status: 'complete' };
      },
      async remove(id) {
        calls.push(['remove', id]);
      },
      async create(args) {
        calls.push(['create', args]);
        return { id: 100, ...args };
      },
      async update(id, args) {
        calls.push(['update', id, args]);
      },
    },
    windows: {
      onFocusChanged: event(),
      onRemoved: event(),
      async get() {
        return { id: 10, type: 'normal' };
      },
      async getAll() {
        return [{ id: 10, focused: true, type: 'normal' }];
      },
      async create(args) {
        calls.push(['move', args]);
        return { id: 10 };
      },
    },
    sidePanel: {
      async open(args) {
        calls.push(['panel', args]);
      },
      async setOptions() {},
    },
    sidebarAction: {
      async open() {
        calls.push(['sidebar']);
      },
    },
    webNavigation: { onBeforeNavigate: event(), onErrorOccurred: event() },
    webRequest: { onBeforeRequest: event() },
    declarativeNetRequest: {
      async getSessionRules() {
        return sessionRules;
      },
      async updateSessionRules(args) {
        calls.push(['rules', args]);
        sessionRules = args.addRules || [];
      },
    },
    debugger: {
      onDetach: event(),
      onEvent: event(),
      async getTargets() {
        return [];
      },
      async attach(args) {
        calls.push(['attach', args]);
      },
      async detach(args) {
        calls.push(['detach', args]);
      },
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
    userScripts: {
      async configureWorld(args) {
        calls.push(['user-world', args]);
      },
      async execute(args) {
        calls.push(['user-script', args]);
        return [{ result: 'page', frameId: 0 }];
      },
    },
  };
  const adapter = new BrowserAdapter(api, browser);
  adapter.contexts.set(100, new Map([['main-frame', { id: 1, uniqueId: 'main-context' }]]));
  return { api, calls, adapter };
}

test('query_all is a bounded read with optional row waits, artifacts and field diagnostics', async () => {
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  const args = { selector: '.row', fields: { title: { selector: '.title' } }, max_output_bytes: 1024 };
  const rows = Array.from({ length: 3 }, () => ({ title: 'x'.repeat(400) }));
  const extracted = {
    document: 'fixture-document',
    scope: 'top-level-and-open-shadow-roots',
    rows,
    matched_count: 3,
    returned_count: 3,
    rows_truncated: false,
    field_issues: [],
    truncated: false,
  };
  const operations = [];
  let attempts = 0;
  let mode = 'delayed';
  f.api.scripting.executeScript = async ({ args: [operation] }) => {
    operations.push(operation);
    if (operation === 'inspect')
      return [
        { result: { url: 'https://site.example/', document_nonce: 'fixture-document', ready_state: 'complete' } },
      ];
    assert.equal(operation, 'query_all');
    attempts++;
    if (mode === 'missing' || (mode === 'delayed' && attempts === 1))
      return [{ result: { error: 'ELEMENT_NOT_FOUND' } }];
    if (mode === 'ambiguous')
      return [{ result: { error: 'ELEMENT_AMBIGUOUS', query_field: 'title', row_index: 0, secret: 'private' } }];
    return [{ result: extracted }];
  };
  assert(f.adapter.capabilities().includes('query_all'));
  const preview = await f.adapter.prepareAction(grant, 'query_all', args);
  assert.equal(preview.approval_token, undefined);
  assert(!operations.includes('prepare_action'));
  const compact = await f.adapter.execute(grant, 'query_all', { ...args, timeout_ms: 100 }, () => {}, preview);
  assert.equal(attempts, 2);
  assert.equal(compact.returned_count, 1);
  assert.equal(compact.matched_count, 3);
  assert.equal(compact.rows_truncated, true);
  assert.deepEqual(
    await f.adapter.execute(grant, 'query_all', { ...args, return_as: 'artifact' }, () => {}),
    extracted,
  );
  mode = 'ambiguous';
  const beforeAmbiguous = attempts;
  await assert.rejects(
    f.adapter.execute(grant, 'query_all', { ...args, timeout_ms: 1000 }, () => {}),
    (error) =>
      error.code === 'ELEMENT_AMBIGUOUS' && error.query_field === 'title' && error.row_index === 0 && !error.secret,
  );
  assert.equal(attempts, beforeAmbiguous + 1);
  mode = 'missing';
  await assert.rejects(
    f.adapter.execute(grant, 'query_all', args, () => {}),
    /ELEMENT_NOT_FOUND/,
  );
  await assert.rejects(
    f.adapter.execute(grant, 'query_all', { ...args, timeout_ms: 1 }, () => {}),
    (error) => error.code === 'WAIT_TIMEOUT' && error.last_error === 'ELEMENT_NOT_FOUND',
  );
  assert(!operations.includes('prepare_action'));
  assert(!f.calls.some(([operation]) => ['update', 'move', 'sidebar', 'panel'].includes(operation)));
});

test('inspection refusal diagnostics are fixed codes and never expose raw browser URLs or errors', async () => {
  const cases = [
    ['Missing host permission for the tab https://private.example/?secret=yes', 'permission_denied'],
    ['Cannot access a privileged URL https://private.example/', 'browser_restricted'],
    ['Frame 0 was removed', 'frame_unavailable'],
    ['Unexpected internal error with private data', 'unknown'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(injectionReason(new Error(message)), expected);
    const f = fixture('firefox');
    f.api.scripting.executeScript = async () => {
      throw new Error(message);
    };
    await assert.rejects(f.adapter.inspect(100, []), (error) => {
      assert.equal(error.code, 'PAGE_UNAVAILABLE');
      assert.equal(error.injection_reason, expected);
      assert.equal(error.inspection_stage, 'document_injection');
      assert.equal(JSON.stringify(error).includes('private'), false);
      assert.equal(error.message, 'PAGE_UNAVAILABLE');
      return true;
    });
  }
  const f = fixture('firefox');
  f.api.scripting.executeScript = async () => [{ error: new Error('private helper exception') }];
  await assert.rejects(f.adapter.inspect(100, []), (error) => error.injection_reason === 'helper_execution_failed');
  f.api.scripting.executeScript = async () => [];
  await assert.rejects(f.adapter.inspect(100, []), (error) => error.injection_reason === 'empty_result');
});

test('browser diagnostics identify the installed extension and available Firefox version', async () => {
  const f = fixture('firefox');
  f.api.runtime.getBrowserInfo = async () => ({ name: 'Firefox', version: '146.0.1' });
  assert.deepEqual(await f.adapter.browserInfo(), {
    extension_version: '4.3.3',
    browser_name: 'firefox',
    browser_version: '146.0.1',
  });
  const chrome = fixture();
  assert.equal((await chrome.adapter.browserInfo()).browser_version, null);
  f.api.runtime.getBrowserInfo = async () => {
    throw new Error('Browser info API failure');
  };
  await assert.rejects(f.adapter.browserInfo(), /Browser info API failure/);
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
  assert.equal(addRules.filter((rule) => rule.condition.resourceTypes === undefined).length, 2);
  await f.adapter.attach(100);
  await f.adapter.release(100);
  assert.deepEqual(
    f.calls.at(-1)[1].removeRuleIds,
    addRules.map((rule) => rule.id),
  );
  assert.equal(f.adapter.guards.size, 0);
  assert.equal(
    f.calls.some((call) => call[0] === 'detach'),
    true,
  );
});

test('protected redirects retain their rules until the browser has rejected the pending request', async () => {
  const f = fixture();
  const events = [];
  f.adapter.onTabEvent = (...args) => events.push(args);
  await f.adapter.initialize([]);
  await f.adapter.protect(100, ['https://control.example']);
  await f.adapter.attach(100);
  f.api.webNavigation.onBeforeNavigate.listeners[0].fn({
    tabId: 100,
    frameId: 0,
    url: 'https://control.example/login',
  });
  assert.equal(events[0][1], 'protected_pending');
  await f.adapter.release(100, { retainProtection: true });
  assert.equal(f.adapter.guards.has(100), true);
  assert.equal(
    f.calls.some((call) => call[0] === 'rules' && call[1].removeRuleIds),
    false,
  );
  f.api.webNavigation.onErrorOccurred.listeners[0].fn({
    tabId: 100,
    frameId: 0,
    url: 'https://control.example/login',
    error: 'net::ERR_BLOCKED_BY_CLIENT',
  });
  await new Promise((resolve) => setImmediate(resolve));
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
  f.api.debugger.detach = async () => {
    throw new Error('Debugger detach failed');
  };
  await assert.rejects(f.adapter.release(100), /PROTECTION_UNAVAILABLE/);
  assert.equal(f.adapter.guards.has(100), true);
  assert.equal(f.adapter.attached.has(100), true);
  assert.equal(
    f.calls.some((call) => call[0] === 'rules' && call[1].removeRuleIds),
    false,
  );
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
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  await f.adapter.execute(grant, 'evaluate_script', { script: 'document.title' }, () => {});
  await f.adapter.execute(grant, 'get_screenshot', {}, () => {});
  const methods = f.calls.filter((call) => call[0] === 'cdp');
  assert.deepEqual(
    methods.map((call) => call[2]),
    ['Page.getFrameTree', 'Runtime.evaluate', 'Page.captureScreenshot'],
  );
  assert.ok(methods.every((call) => call[1].tabId === 100));
  assert.equal(methods[1][3].contextId, undefined);
  assert.equal(methods[1][3].uniqueContextId, 'main-context');
});

test('Firefox caller source is browser-compiled in the explicit world, never evaluated with extension privileges', async () => {
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  const script = 'typeof browser';
  await f.adapter.execute(grant, 'evaluate_script', { script }, () => {});
  const scripts = f.calls.filter((call) => call[0] === 'script').map((call) => call[1]);
  assert.equal(scripts[0].world, 'ISOLATED');
  const native = f.calls.find((call) => call[0] === 'user-script')[1];
  assert.equal(native.world, 'MAIN');
  assert(native.js[0].code.includes(script));
  assert(!native.js[0].code.includes('eval('));
  assert.deepEqual(native.target, { tabId: 100, frameIds: [0] });
  const isolated = await f.adapter.execute(
    { ...grant, scriptWorldId: 'activation-world' },
    'evaluate_script',
    { script, world: 'USER_SCRIPT' },
    () => {},
  );
  assert.equal(isolated.execution_world, 'USER_SCRIPT');
  assert.equal(f.calls.filter((call) => call[0] === 'user-script').at(-1)[1].worldId, 'activation-world');
});

test('Firefox injection failures remain distinct from script and policy failures', async () => {
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  f.adapter.onWarning = () => {};
  f.api.userScripts.execute = async () => {
    throw new Error('Injection refused');
  };
  await assert.rejects(
    f.adapter.execute(grant, 'evaluate_script', { script: '1+1' }, () => {}),
    /SCRIPT_EXECUTION_UNAVAILABLE/,
  );
});

test('native script exception stacks survive classification and never trigger a second-world retry', async () => {
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  const native = new SyntaxError('Synthetic native parser failure');
  f.api.userScripts.execute = async (args) => {
    f.calls.push(['user-script', args]);
    return [{ error: native, frameId: 0 }];
  };
  await assert.rejects(
    f.adapter.execute(
      grant,
      'evaluate_script',
      { script: 'throw new SyntaxError("Synthetic native parser failure")' },
      () => {},
    ),
    (error) => {
      assert.equal(error.code, 'SCRIPT_SYNTAX_ERROR');
      assert.equal(error.diagnostics.name, 'SyntaxError');
      assert(error.diagnostics.stack.includes('Synthetic native parser failure'));
      return true;
    },
  );

  assert.equal(f.calls.filter((call) => call[0] === 'user-script').length, 1);
});

test('content-selector waits share one timeout budget and preserve zero-timeout probe diagnostics', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  let ready = false;
  f.api.scripting.executeScript = async (args) => [
    {
      result: args.args[0] === 'inspect' ? { url: 'https://site.example/', document_nonce: 'doc' } : { ready },
    },
  ];
  const pending = f.adapter.execute(grant, 'wait_for_page', { content_selector: '#ready', timeout_ms: 100 }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  ready = true;
  t.mock.timers.tick(50);
  assert.deepEqual(await pending, {
    state: 'loaded',
    url: 'https://site.example/',
    document: 'doc',
    document_ready: true,
    content_ready: true,
  });
  ready = false;
  await assert.rejects(
    f.adapter.execute(grant, 'wait_for_page', { content_selector: '#ready', timeout_ms: 0 }, () => {}),
    (error) => error.code === 'WAIT_TIMEOUT' && error.readiness_stage === 'content_readiness' && error.timeout_ms === 0,
  );
});

test('captured native failures are errors even when the browser returns them as ordinary result data', async () => {
  const f = fixture('firefox');
  f.api.userScripts.execute = async (args) => [{ result: await runInNewContext(args.js[0].code), frameId: 0 }];
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  for (const script of [
    'throw new Error("Native runtime failure")',
    'Promise.reject(new Error("Native async failure"))',
  ]) {
    await assert.rejects(
      f.adapter.execute(grant, 'evaluate_script', { script }, () => {}),
      (error) => error.code === 'SCRIPT_RUNTIME_ERROR' && error.diagnostics.stack.includes('failure'),
    );
  }
});

test('Chrome distinguishes JavaScript errors and enforces the same output budget', async () => {
  const f = fixture();
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  const original = f.api.debugger.sendCommand;
  for (const name of ['SyntaxError', 'Error']) {
    f.api.debugger.sendCommand = async (target, method, args) =>
      method === 'Runtime.evaluate'
        ? { exceptionDetails: { exception: { className: name } } }
        : original(target, method, args);
    await assert.rejects(
      f.adapter.execute(grant, 'evaluate_script', { script: 'invalid' }, () => {}),
      name === 'SyntaxError' ? /SCRIPT_SYNTAX_ERROR/ : /SCRIPT_RUNTIME_ERROR/,
    );
  }
  f.api.debugger.sendCommand = async (target, method, args) =>
    method === 'Runtime.evaluate' ? { result: { value: 'x'.repeat(20_000) } } : original(target, method, args);
  await assert.rejects(
    f.adapter.execute(grant, 'evaluate_script', { script: 'big' }, () => {}),
    /RESULT_TOO_LARGE/,
  );
});

test('Firefox screenshots capture the target tab or advertise unavailable; never the visible tab', async () => {
  const f = fixture('firefox');
  assert.equal(f.adapter.capabilities().includes('get_screenshot'), false);
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  await assert.rejects(
    f.adapter.execute(grant, 'get_screenshot', {}, () => {}),
    /CAPABILITY_UNAVAILABLE/,
  );
  let captured;
  f.api.tabs.captureTab = async (id) => {
    captured = id;
    return 'data:image/png;base64,aW1hZ2U=';
  };
  assert.equal(f.adapter.capabilities().includes('get_screenshot'), true);
  assert.deepEqual(await f.adapter.execute(grant, 'get_screenshot', {}, () => {}), {
    mimeType: 'image/png',
    data: 'aW1hZ2U=',
  });
  assert.equal(captured, 100);
  f.adapter.onWarning = () => {};
  f.api.tabs.captureTab = async () => {
    throw new Error('Capture permission unavailable');
  };
  await assert.rejects(
    f.adapter.execute(grant, 'get_screenshot', {}, () => {}),
    /CAPABILITY_UNAVAILABLE/,
  );
});

test('failed document inspection is not an optional-operation capability failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  f.adapter.onWarning = () => {};
  f.api.scripting.executeScript = async () => {
    throw new Error('Missing host permission for the tab');
  };
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  for (const operation of ['get_text', 'get_interactive_elements']) {
    const work = f.adapter.execute(grant, operation, {}, () => {});
    const rejected = assert.rejects(
      work,
      (error) =>
        error.code === 'PAGE_UNAVAILABLE' &&
        error.inspection_stage === 'document_injection' &&
        error.timeout_ms === 10000 &&
        error.injection_reason === 'permission_denied',
    );
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10000);
    await rejected;
  }
  assert.equal(
    f.calls.some((call) => call[0] === 'update'),
    false,
  );
  // Navigation needs no document access, so a refused page can still be navigated away from.
  assert.deepEqual(await f.adapter.execute(grant, 'navigate', { url: 'https://other.example/' }, () => {}), {
    url: 'https://other.example/',
    navigation_started: true,
  });
  f.api.scripting.executeScript = async () => [{ error: new Error('Document execution failed') }];
  await assert.rejects(f.adapter.inspect(100, grant.protected_origins), /PAGE_UNAVAILABLE/);
});

test('actionability waits use the configured deadline and never retry a mutation after execution', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  let attempts = 0;
  f.api.scripting.executeScript = async ({ args }) => {
    if (args[0] === 'inspect') return [{ result: { url: 'https://site.example/', document_nonce: 'document-1' } }];
    attempts++;
    return [{ result: attempts < 3 ? { error: 'ELEMENT_DISABLED' } : { clicked: true } }];
  };
  const work = f.adapter.execute(grant, 'click', { selector: 'button', timeout_ms: 100 }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  t.mock.timers.tick(50);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  t.mock.timers.tick(50);
  assert.deepEqual(await work, { clicked: true });
  assert.equal(attempts, 3);

  f.api.scripting.executeScript = async ({ args }) => [
    {
      result:
        args[0] === 'inspect'
          ? { url: 'https://site.example/', document_nonce: 'document-1' }
          : { error: 'OPERATION_FAILED' },
    },
  ];
  await assert.rejects(
    f.adapter.execute(grant, 'click', { selector: 'button' }, () => {}),
    /OPERATION_FAILED/,
  );
});

test('readiness deadlines and cancellation during waits are enforced without executing later work', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  let attempts = 0;
  f.api.scripting.executeScript = async ({ args }) => {
    if (args[0] === 'inspect') return [{ result: { url: 'https://site.example/', document_nonce: 'document-1' } }];
    attempts++;
    return [{ result: { error: 'ELEMENT_NOT_FOUND' } }];
  };
  const expired = f.adapter.execute(grant, 'click', { selector: '#missing', timeout_ms: 50 }, () => {});
  const rejected = assert.rejects(
    expired,
    (error) => error.code === 'WAIT_TIMEOUT' && error.last_error === 'ELEMENT_NOT_FOUND' && error.timeout_ms === 50,
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(attempts, 2);

  let cancelled = false;
  const waiting = f.adapter.execute(grant, 'type_text', { selector: '#missing', text: 'not typed' }, () => {
    if (cancelled) throw new Error('APPROVAL_REQUIRED');
  });
  const stopped = assert.rejects(waiting, /APPROVAL_REQUIRED/);
  await new Promise((resolve) => setImmediate(resolve));
  const before = attempts;
  cancelled = true;
  t.mock.timers.tick(50);
  await stopped;
  assert.equal(attempts, before);
});

test('wait_for_page distinguishes loaded state from navigation started and blocks protected destinations', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  let loading = true;
  f.api.tabs.get = async () => ({
    windowId: 10,
    url: 'https://site.example/',
    status: loading ? 'loading' : 'complete',
  });
  f.api.scripting.executeScript = async () => [
    { result: { url: 'https://site.example/', document_nonce: 'document-1' } },
  ];
  const waiting = f.adapter.execute(grant, 'wait_for_page', { timeout_ms: 100 }, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  loading = false;
  t.mock.timers.tick(50);
  assert.deepEqual(await waiting, {
    state: 'loaded',
    url: 'https://site.example/',
    document: 'document-1',
    document_ready: true,
    content_ready: null,
  });
  loading = true;
  await assert.rejects(
    f.adapter.execute(grant, 'wait_for_page', { timeout_ms: 0 }, () => {}),
    /WAIT_TIMEOUT/,
  );
  f.api.tabs.get = async () => ({ windowId: 10, pendingUrl: 'https://control.example/login', status: 'loading' });
  await assert.rejects(
    f.adapter.execute(grant, 'wait_for_page', {}, () => {}),
    /HANDOFF_REQUIRED/,
  );
});

test('post-navigation inspection waits for tab/document readiness and retries only benign inspection', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  let loading = true,
    ready = false,
    failures = 1,
    snapshots = 0;
  f.adapter.onWarning = () => {};
  f.api.tabs.get = async (id) => ({
    id,
    windowId: 10,
    url: 'https://site.example/',
    status: loading ? 'loading' : 'complete',
  });
  f.api.scripting.executeScript = async ({ args: [operation] }) => {
    if (operation === 'inspect') {
      if (failures-- > 0) throw new Error('Frame temporarily detached during navigation');
      return [
        {
          result: {
            url: 'https://site.example/',
            document_nonce: 'new-document',
            ready_state: ready ? 'complete' : 'loading',
          },
        },
      ];
    }
    snapshots++;
    return [{ result: { document: 'new-document', text: 'new page', elements: [] } }];
  };
  const previewWork = f.adapter.prepareAction(grant, 'get_page_snapshot', {}, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((call) => call[0] === 'update').length, 0);
  loading = false;
  t.mock.timers.tick(50);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(50);
  await new Promise((resolve) => setImmediate(resolve));
  ready = true;
  t.mock.timers.tick(50);
  const preview = await previewWork;
  assert.equal(preview.document_nonce, 'new-document');
  const snapshot = await f.adapter.execute(grant, 'get_page_snapshot', {}, () => {}, preview);
  assert.equal(snapshot.document, 'new-document');
  assert.equal(snapshots, 1);
});

test('reads after a navigation request cannot approve the previous still-complete document', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: [] };
  let url = 'https://site.example/',
    document = 'old-document';
  f.api.tabs.get = async (id) => ({ id, windowId: 10, url, status: 'complete' });
  f.api.scripting.executeScript = async () => [{ result: { url, document_nonce: document, ready_state: 'complete' } }];
  await f.adapter.execute(grant, 'navigate', { url: 'https://site.example/new' }, () => {});
  const preparing = f.adapter.prepareAction(grant, 'get_page_snapshot', {}, () => {});
  let prepared = false;
  preparing.then(() => {
    prepared = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, false);
  url = 'https://site.example/new';
  document = 'new-document';
  t.mock.timers.tick(50);
  assert.equal((await preparing).document_nonce, 'new-document');
  assert.equal(grant.navigation, undefined);
  assert.equal(f.calls.filter((call) => call[0] === 'update').length, 1);
  grant.navigation = { from: url, url: url + '#section', document };
  url += '#section';
  assert.equal((await f.adapter.prepareAction(grant, 'get_page_snapshot', {})).document_nonce, 'new-document');
});

test('navigation between tabs.get and inspection is detected; permanent refusal and cancellation stay fail-closed', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = fixture('firefox');
  const grant = { tabId: 100, windowId: 10, protected_origins: ['https://control.example'] };
  let url = 'https://site.example/old';
  f.api.tabs.get = async (id) => ({ id, windowId: 10, url, status: 'complete' });
  f.api.scripting.executeScript = async () => {
    url = 'https://site.example/new';
    return [{ result: { url, ready_state: 'complete', document_nonce: 'new-document' } }];
  };
  await assert.rejects(
    f.adapter.inspect(100, grant.protected_origins),
    (error) => error.code === 'TARGET_STALE' && error.inspection_stage === 'document_changed',
  );
  await assert.rejects(
    f.adapter.execute(grant, 'click', { selector: 'button', timeout_ms: 0 }, () => {}, {
      document_nonce: 'old-document',
    }),
    (error) => error.code === 'TARGET_STALE' && error.inspection_stage === 'document_changed',
  );
  let attempts = 0;
  f.adapter.onWarning = () => {};
  f.api.scripting.executeScript = async () => {
    attempts++;
    throw new Error('Renderer refuses injection');
  };
  const unavailable = f.adapter.execute(grant, 'wait_for_page', { timeout_ms: 100 }, () => {});
  const rejected = assert.rejects(
    unavailable,
    (error) =>
      error.code === 'PAGE_UNAVAILABLE' &&
      error.inspection_stage === 'document_injection' &&
      error.last_error === 'PAGE_UNAVAILABLE' &&
      error.timeout_ms === 100,
  );
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  await rejected;
  let stopped = false;
  const waiting = f.adapter.prepareAction(grant, 'get_page_snapshot', {}, () => {
    if (stopped) throw Object.assign(new Error('APPROVAL_REQUIRED'), { code: 'APPROVAL_REQUIRED' });
  });
  const cancelled = assert.rejects(waiting, /APPROVAL_REQUIRED/);
  await new Promise((resolve) => setImmediate(resolve));
  const before = attempts;
  stopped = true;
  t.mock.timers.tick(50);
  await cancelled;
  assert.equal(attempts, before);
  url = 'https://control.example/private';
  await assert.rejects(f.adapter.prepareAction(grant, 'get_page_snapshot', {}), /HANDOFF_REQUIRED/);
  assert.equal(attempts, before);
});
