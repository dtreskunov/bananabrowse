import {
  OPERATIONS,
  PAGE_WAIT_MS,
  READINESS_ERRORS,
  navigationUrl,
  validOperationArgs,
} from '../../shared/protocol.js';
import { boundedResult, fail, protectedRegex } from './security.js';
import { compactResult } from '../../shared/results.js';
import { pageHelper } from './page.js';
import { actionSummary } from './approval-summary.js';
import { diagnosticDetails } from '../../shared/diagnostics.js';
import { compileScriptSource, locateScriptError, prepareEvaluateExpression, stackLocation } from './script-source.js';
import type { Wire } from '../../shared/protocol.js';
import type { BrowserApi } from './browser-api.js';

type ScriptWorld = `${chrome.userScripts.ExecutionWorld}`;
// Const-asserted literals keep the DNR enums type-only; @types/chrome declares them as runtime enums.
const BLOCK = 'block' as chrome.declarativeNetRequest.RuleActionType.BLOCK;
const MAIN_FRAME = 'main_frame' as chrome.declarativeNetRequest.ResourceType.MAIN_FRAME;
interface CdpExecutionContext {
  id: number;
  uniqueId?: string;
  auxData?: { isDefault?: boolean; frameId: string };
}
interface CdpContextEvent {
  context: CdpExecutionContext;
  executionContextId: number;
}
interface CdpFrameTree {
  frameTree: { frame: { id: string } };
}
interface CdpRemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
}
interface CdpEvaluation {
  result?: CdpRemoteObject;
  exceptionDetails?: { exception?: CdpRemoteObject; lineNumber: number; columnNumber: number };
}

export function injectionReason(error: any): string {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/missing host permission|cannot access contents|permission.*(?:denied|tab)/i.test(message))
    return 'permission_denied';
  if (
    /restricted|not allowed.*(?:page|url)|cannot.*(?:privileged|about:)|extensions.*(?:not permitted|not allowed)/i.test(
      message,
    )
  ) {
    return 'browser_restricted';
  }
  if (
    /(?:frame|document|tab).*(?:removed|closed|not found|does not exist)|no (?:frame|tab)|frame.*not ready/i.test(
      message,
    )
  ) {
    return 'frame_unavailable';
  }
  return 'unknown';
}

const POLICY_MESSAGE = /unsafe-eval|content security policy|csp|code generation/i;
function scriptFailureCode(native: any): string {
  if (native?.name === 'SyntaxError') return 'SCRIPT_SYNTAX_ERROR';
  if (native?.name === 'EvalError' && POLICY_MESSAGE.test(native.message || '')) return 'SCRIPT_POLICY_BLOCKED';
  return 'SCRIPT_RUNTIME_ERROR';
}
function scriptError(
  code: string,
  native: unknown,
  phase: string,
  world: string,
  script: unknown,
  located: { line?: number; column?: number } | null | undefined,
  layer = 'browser',
): Error {
  return locateScriptError(
    Object.assign(new Error(code), { code, ...diagnosticDetails(native, { layer, phase, execution_world: world }) }),
    script,
    located?.line,
    located?.column,
  );
}
// Artifacts are stored by the service; only the transport bound applies to them here.
/** The controller's tab record as seen by the adapter. */
export interface Grant {
  tabId: number;
  groupId?: number | null;
  protected_origins: string[];
  scriptWorldId?: string;
  navigation?: { from?: string; url: string; document?: string } | null;
  url?: string;
  pageState?: string;
  blankAllowed?: boolean;
}

function evaluationResult(evaluated: unknown, args: Wire, onSerializationError: (error: unknown) => any): any {
  if (args.return_as === 'artifact') return evaluated;
  try {
    return compactResult('evaluate_script', evaluated, args);
  } catch (error: any) {
    if (error.code === 'RESULT_TOO_LARGE') throw error;
    return onSerializationError(error);
  }
}

export class BrowserAdapter {
  declare api: BrowserApi;
  declare browserName: string;
  declare guards: Map<number, Wire>;
  declare attached: Set<number>;
  declare contexts: Map<number, Map<string, CdpExecutionContext>>;
  declare refBases: Map<number, number>;
  declare nextRule: number;
  declare onTabEvent: (tabId: number, event: string, url?: string) => void;
  declare onWarning: (error?: unknown) => void;
  declare selectedWindowId: number | null;

  constructor(api: BrowserApi, browserName: string) {
    this.api = api;
    this.browserName = browserName;
    this.guards = new Map();
    this.attached = new Set();
    this.contexts = new Map();
    this.refBases = new Map();
    this.nextRule = 1;
    this.onTabEvent = () => {};
    this.onWarning = () => console.error('DomAgent browser protection unavailable');
    this.selectedWindowId = null;
  }

  capabilities() {
    return OPERATIONS.filter(
      (operation) => operation !== 'get_screenshot' || this.browserName === 'chrome' || !!this.api.tabs.captureTab,
    );
  }

  async browserInfo() {
    const version = this.api.runtime.getManifest().version;
    const browser = this.api.runtime.getBrowserInfo ? await this.api.runtime.getBrowserInfo() : null;
    return { extension_version: version, browser_name: this.browserName, browser_version: browser?.version ?? null };
  }

  async initialize() {
    if (this.browserName === 'chrome') {
      const rules = await this.api.declarativeNetRequest.getSessionRules();
      if (rules.length)
        await this.api.declarativeNetRequest.updateSessionRules({
          removeRuleIds: rules.map((rule) => rule.id),
        });
      const targets = await this.api.debugger.getTargets();
      for (const target of targets.filter((target) => target.attached && Number.isInteger(target.tabId))) {
        // Chrome only permits detaching this extension's own attachment. Never
        // resume a grant, even if the worker restarted while a tab stayed open.
        await this.api.debugger.detach({ tabId: target.tabId }).catch(() => {});
      }
      this.api.debugger.onDetach.addListener((source) => {
        const tabId = source.tabId!;
        this.attached.delete(tabId);
        this.contexts.delete(tabId);
        this.onTabEvent(tabId, 'detached');
      });
      this.api.debugger.onEvent.addListener((source, method, params) => {
        const tabId = source.tabId!;
        if (!this.attached.has(tabId)) return;
        const event = params as CdpContextEvent;
        if (method === 'Runtime.executionContextsCleared') this.contexts.delete(tabId);
        if (method === 'Runtime.executionContextCreated' && event.context.auxData?.isDefault) {
          const contexts = this.contexts.get(tabId) || new Map();
          contexts.set(event.context.auxData.frameId, event.context);
          this.contexts.set(tabId, contexts);
        }
        if (method === 'Runtime.executionContextDestroyed') {
          for (const [frame, context] of this.contexts.get(tabId) || []) {
            if (context.id === event.executionContextId) this.contexts.get(tabId)!.delete(frame);
          }
        }
      });
    } else {
      if (!this.api.webRequest?.onBeforeRequest) fail('PROTECTION_UNAVAILABLE');
      this.api.webRequest.onBeforeRequest.addListener(
        (details) => {
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
        },
        { urls: ['http://*/*', 'https://*/*'] },
        ['blocking'],
      );
    }
    this.api.tabs.onActivated?.addListener((info) => {
      void this.rememberWindow(info.windowId).catch(() => {});
    });
    this.api.windows?.onFocusChanged.addListener((windowId: number) => {
      void this.rememberWindow(windowId).catch(() => {});
    });
    this.api.windows?.onRemoved.addListener((windowId: number) => {
      if (this.selectedWindowId === windowId) this.selectedWindowId = null;
    });
    this.api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status === 'loading' || change.url) this.onTabEvent(tabId, 'navigation', change.url);
      if (change.status === 'complete') this.onTabEvent(tabId, 'complete');
    });
    this.api.tabs.onRemoved.addListener((tabId: number) => {
      this.refBases.delete(tabId);
      this.onTabEvent(tabId, 'closed');
    });
    this.api.webNavigation.onBeforeNavigate.addListener((details) => {
      if (details.frameId !== 0) return;
      const guard = this.guards.get(details.tabId);
      const protectedPage = guard?.origins.includes(new URL(details.url).origin);
      this.onTabEvent(details.tabId, protectedPage ? 'protected_pending' : 'navigation_pending', details.url);
    });
    this.api.webNavigation.onErrorOccurred.addListener((details) => {
      if (details.frameId !== 0) return;
      this.onTabEvent(details.tabId, 'navigation', details.url);
      const guard = this.guards.get(details.tabId);
      if (guard?.origins.includes(new URL(details.url).origin)) {
        // The browser has now rejected this request. Removing a rule during
        // onBeforeNavigate would let the pending protected redirect escape it.
        void this.releaseAfterNavigation(details.tabId).catch((error) => this.onWarning(error));
      }
    });
  }

  async permissions() {
    if (!(await this.api.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))) {
      fail('PERMISSION_REQUIRED');
    }
  }

  async rememberWindow(windowId: number) {
    if (!Number.isInteger(windowId) || windowId < 0) return;
    const window = await this.api.windows.get(windowId);
    if (window.type === 'normal') this.selectedWindowId = windowId;
  }

  /** The user's most recently focused normal window, used for new session groups. */
  async lastNormalWindow() {
    if (this.selectedWindowId !== null) {
      try {
        const window = await this.api.windows.get(this.selectedWindowId);
        if (window.type === 'normal') return window.id;
      } catch {
        this.selectedWindowId = null;
      }
    }
    const windows = await this.api.windows.getAll({ windowTypes: ['normal'] });
    const window = windows.find((window) => window.focused) || windows.at(-1);
    if (window) return window.id;
    return (await this.api.windows.create({ focused: false, url: 'about:blank' }))!.id;
  }

  async assertWorkspace(grant: Grant) {
    const tab = await this.api.tabs.get(grant.tabId);
    if (tab.groupId !== grant.groupId) fail('TAB_NOT_IN_SESSION');
  }

  async focusTab(tabId: number) {
    const tab = await this.api.tabs.get(tabId);
    await this.api.windows.update(tab.windowId, { focused: true });
    await this.api.tabs.update(tabId, { active: true });
  }

  async protect(tabId: number, origins: string[]) {
    await this.permissions();
    if (this.guards.has(tabId)) fail('PROTECTION_UNAVAILABLE');
    if (this.browserName === 'chrome') {
      const rules = origins.flatMap((origin: string): chrome.declarativeNetRequest.Rule[] => {
        const condition = { regexFilter: protectedRegex(origin), isUrlFilterCaseSensitive: false, tabIds: [tabId] };
        // Chrome's default resource types exclude main_frame. Keep a broad
        // rule for every subresource, and explicitly cover top-level redirects.
        return [
          { id: this.nextRule++, priority: 1, action: { type: BLOCK }, condition },
          {
            id: this.nextRule++,
            priority: 1,
            action: { type: BLOCK },
            condition: { ...condition, resourceTypes: [MAIN_FRAME] },
          },
        ];
      });
      const ruleIds = rules.map((rule) => rule.id);
      await this.api.declarativeNetRequest.updateSessionRules({ addRules: rules });
      this.guards.set(tabId, { origins, ruleIds });
    } else {
      // Firefox's blocking listener is installed before a tab can be granted.
      this.guards.set(tabId, { origins });
    }
  }

  async attach(tabId: number) {
    if (this.browserName === 'chrome') {
      await this.api.debugger.attach({ tabId }, '1.3');
      this.attached.add(tabId);
      await this.api.debugger.sendCommand({ tabId }, 'Runtime.enable');
    }
  }

  async release(tabId: number, { retainProtection = false } = {}) {
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

  async dropProtection(tabId: number) {
    const guard = this.guards.get(tabId);
    if (guard?.ruleIds) {
      // Retain the guard record on failure; later cleanup may retry it.
      await this.api.declarativeNetRequest.updateSessionRules({ removeRuleIds: guard.ruleIds });
    }
    this.guards.delete(tabId);
  }

  async releaseAfterNavigation(tabId: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const tab = await this.api.tabs.get(tabId);
      if (tab.status === 'complete' && !tab.pendingUrl) {
        await this.dropProtection(tabId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail('PROTECTION_UNAVAILABLE');
  }

  async helper(tabId: number, operation: string, args: Wire): Promise<any> {
    if (operation === 'get_page_snapshot') args = { ...args, ref_base: this.refBases.get(tabId) ?? 1 };
    let responses: any;
    try {
      responses = await this.api.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: pageHelper,
        args: [operation, args],
      });
    } catch (error) {
      if (operation !== 'inspect') this.onWarning(error);
      if (operation === 'inspect') {
        throw Object.assign(new Error('PAGE_UNAVAILABLE'), {
          code: 'PAGE_UNAVAILABLE',
          injection_reason: injectionReason(error),
        });
      }
      fail('CAPABILITY_UNAVAILABLE');
    }
    const response = responses?.[0];
    if (response?.error) {
      if (operation === 'inspect')
        throw Object.assign(new Error('PAGE_UNAVAILABLE'), {
          code: 'PAGE_UNAVAILABLE',
          injection_reason: 'helper_execution_failed',
        });
      fail('CAPABILITY_UNAVAILABLE');
    }
    if (!response?.result) {
      throw Object.assign(new Error('TARGET_STALE'), {
        code: 'TARGET_STALE',
        ...(operation === 'inspect' ? { injection_reason: 'empty_result' } : {}),
      });
    }
    if (response.result.error) {
      const { stale_reason, snapshot_document, current_document } = response.result;
      fail(
        response.result.error,
        Object.fromEntries(
          Object.entries({ stale_reason, snapshot_document, current_document }).filter(
            ([, value]) => typeof value === 'string',
          ),
        ),
      );
    }
    if (operation === 'get_page_snapshot') {
      const { next_ref, ...snapshot } = response.result;
      if (Number.isSafeInteger(next_ref)) this.refBases.set(tabId, next_ref);
      response.result = snapshot;
    }
    return {
      ...(['get_text', 'get_page_snapshot', 'get_interactive_elements', 'inspect_element'].includes(operation)
        ? (compactResult(operation, response.result, args) as Wire)
        : response.result),
      ...(operation === 'inspect' && response.documentId ? { document_id: response.documentId } : {}),
    };
  }

  async inspect(tabId: number, origins: string[], allowBlank = false): Promise<any> {
    const tab = await this.api.tabs.get(tabId);
    const blank =
      (tab.url || tab.pendingUrl) === 'about:blank' && (!tab.pendingUrl || tab.pendingUrl === 'about:blank');
    if (allowBlank && blank) return { url: 'about:blank' };
    if (!tab.url && !tab.pendingUrl) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'tab_status' });
    }
    navigationUrl((tab.pendingUrl || tab.url)!, origins);
    if (tab.status === 'loading' || tab.pendingUrl) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'tab_status' });
    }
    let page: any;
    try {
      page = await this.helper(tabId, 'inspect', {});
    } catch (error: any) {
      if (['PAGE_UNAVAILABLE', 'TARGET_STALE'].includes(error.code)) error.inspection_stage = 'document_injection';
      throw error;
    }
    navigationUrl(page.url, origins);
    if (page.ready_state && page.ready_state !== 'complete') {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_state' });
    }
    const current = await this.api.tabs.get(tabId);
    navigationUrl((current.pendingUrl || current.url)!, origins);
    if (page.url !== tab.url || current.url !== page.url || current.status === 'loading' || current.pendingUrl) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_changed' });
    }
    return page;
  }

  async waitForInspection(grant: Grant, timeoutMs: number, check: () => void, allowBlank = false): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      check();
      await this.assertWorkspace(grant);
      try {
        if (grant.navigation && !grant.navigation.document) {
          const current = await this.api.tabs.get(grant.tabId);
          const candidate = current.pendingUrl || current.url;
          if (
            (!/^https?:/.test(candidate || '') || candidate === grant.navigation.from) &&
            candidate !== grant.navigation.url
          ) {
            throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'tab_status' });
          }
        }
        const page = await this.inspect(grant.tabId, grant.protected_origins, allowBlank);
        const navigation = grant.navigation;
        if (
          navigation &&
          (navigation.document
            ? page.document_nonce === navigation.document &&
              (navigation.from === navigation.url || page.url !== navigation.url)
            : page.url === navigation.from && page.url !== navigation.url)
        ) {
          throw Object.assign(new Error('TARGET_STALE'), {
            code: 'TARGET_STALE',
            inspection_stage: 'document_changed',
          });
        }
        if (navigation) delete grant.navigation;
        check();
        return page;
      } catch (error: any) {
        check();
        if (!['TARGET_STALE', 'PAGE_UNAVAILABLE'].includes(error.code) || !error.inspection_stage) throw error;
        if (Date.now() >= deadline) {
          delete grant.navigation;
          let code = error.code;
          if (code === 'TARGET_STALE' && timeoutMs > 0) code = 'WAIT_TIMEOUT';
          throw Object.assign(new Error(code), {
            code,
            inspection_stage: error.inspection_stage,
            last_error: error.code,
            timeout_ms: timeoutMs,
            ...(error.injection_reason ? { injection_reason: error.injection_reason } : {}),
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }

  async evaluateScript(grant: Grant, document: Wire, args: Wire, checkCurrent: () => void): Promise<any> {
    const world: ScriptWorld = args.world || 'MAIN';
    if (this.browserName === 'chrome' && world !== 'USER_SCRIPT') {
      const tree = (await this.api.debugger.sendCommand({ tabId: grant.tabId }, 'Page.getFrameTree')) as CdpFrameTree;
      const context = this.contexts.get(grant.tabId)?.get(tree.frameTree?.frame.id);
      if (!context?.uniqueId) fail('TARGET_STALE');
      checkCurrent();
      return this.evaluateWithDebugger(grant.tabId, context, args);
    }
    return this.evaluateWithUserScripts(grant, document, args, world);
  }

  async evaluateWithDebugger(tabId: number, context: CdpExecutionContext, args: Wire): Promise<any> {
    // The remote caller chooses only page source, never a CDP method/target/context.
    const prepared = prepareEvaluateExpression(args.script);
    const response = (await this.api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: prepared.expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
      timeout: 10_000,
      uniqueContextId: context.uniqueId,
    })) as CdpEvaluation;
    const details = response.exceptionDetails;
    if (details || response.result?.subtype === 'error') {
      const exception = details?.exception || response.result;
      const code = exception?.className === 'SyntaxError' ? 'SCRIPT_SYNTAX_ERROR' : 'SCRIPT_RUNTIME_ERROR';
      const native = Object.assign(new Error(exception?.description || code), {
        name: exception?.className || 'Error',
        native: details,
      });
      const located =
        stackLocation(exception?.description, prepared.marker) ||
        (code === 'SCRIPT_SYNTAX_ERROR' && !prepared.async && Number.isSafeInteger(details?.lineNumber)
          ? { line: details!.lineNumber + 1, column: (details!.columnNumber ?? -1) + 1 }
          : null);
      throw scriptError(code, native, 'execution', 'MAIN', args.script, located);
    }
    if (response.result?.unserializableValue !== undefined || response.result?.type === 'function') {
      fail('SCRIPT_SERIALIZATION_ERROR');
    }
    return evaluationResult({ value: response.result?.value ?? null, execution_world: 'MAIN' }, args, () =>
      fail('SCRIPT_SERIALIZATION_ERROR'),
    );
  }

  async evaluateWithUserScripts(grant: Grant, document: Wire, args: Wire, world: ScriptWorld): Promise<any> {
    const tabId = grant.tabId;
    let compiled: ReturnType<typeof compileScriptSource>;
    try {
      compiled = compileScriptSource(args.script);
    } catch (error: any) {
      const failure = scriptError(
        'SCRIPT_SYNTAX_ERROR',
        error,
        'validation',
        world,
        args.script,
        { line: error.line, column: error.column },
        'extension',
      );
      throw Object.assign(failure, { dispatch_status: 'not_dispatched' });
    }
    let responses: any;
    try {
      if (!this.api.userScripts?.execute) throw new Error('Native user-script API is unavailable or not enabled.');
      const worldId = grant.scriptWorldId || 'domagent';
      if (world === 'USER_SCRIPT') {
        await this.api.userScripts.configureWorld({
          worldId,
          csp: "script-src 'self' 'unsafe-eval'; object-src 'none'",
          messaging: false,
        });
      }
      responses = await this.api.userScripts.execute({
        target: document.document_id ? { tabId, documentIds: [document.document_id] } : { tabId, frameIds: [0] },
        world,
        ...(world === 'USER_SCRIPT' ? { worldId } : {}),
        js: [{ code: compiled.code }],
      });
    } catch (error) {
      const failure = Object.assign(new Error('SCRIPT_EXECUTION_UNAVAILABLE'), {
        code: 'SCRIPT_EXECUTION_UNAVAILABLE',
        ...diagnosticDetails(error, { layer: 'browser', phase: 'dispatch', execution_world: world }),
      });
      this.onWarning(failure);
      throw failure;
    }
    const response = responses?.[0];
    if (!response) fail('SCRIPT_EXECUTION_UNAVAILABLE');
    const caught = response.result?.__domagent_script_failure === compiled.marker;
    if (caught || response.error !== undefined) {
      const native = caught ? response.result.details : response.error;
      const code =
        caught && response.result.serialization_error ? 'SCRIPT_SERIALIZATION_ERROR' : scriptFailureCode(native);
      const located = stackLocation(native?.stack, compiled.marker, compiled.wrapper_line_offset);
      // Wrapper text shifts columns on the first and last lines, so runtime errors report the line only.
      throw scriptError(code, native, 'execution', world, args.script, { line: located?.line });
    }
    if (document.document_id && response.documentId !== document.document_id) fail('TARGET_STALE');
    if (typeof response.result === 'function' || typeof response.result === 'symbol')
      fail('SCRIPT_SERIALIZATION_ERROR');
    return evaluationResult({ value: response.result ?? null, execution_world: world }, args, (error) => {
      throw Object.assign(new Error('SCRIPT_SERIALIZATION_ERROR'), {
        code: 'SCRIPT_SERIALIZATION_ERROR',
        ...diagnosticDetails(error, { layer: 'browser', phase: 'serialization', execution_world: world }),
      });
    });
  }

  async prepareAction(grant: Grant, operation: string, args: Wire, check: () => void = () => {}): Promise<Wire> {
    await this.assertWorkspace(grant);
    if (operation === 'navigate') {
      check();
      return { summary: ['Operation: navigate', `Destination: ${navigationUrl(args.url, grant.protected_origins)}`] };
    }
    if (['wait_for_page', 'request_handoff'].includes(operation)) {
      const tab = await this.api.tabs.get(grant.tabId);
      const url = grant.navigation?.url || tab.pendingUrl || tab.url;
      navigationUrl(url!, grant.protected_origins);
      return { summary: actionSummary(operation, args, { title: tab.title, url }) };
    }
    const page = await this.waitForInspection(grant, args.timeout_ms ?? PAGE_WAIT_MS, check, operation === 'navigate');
    let target: any;
    if (operation !== 'inspect_element' && (args.selector || args.ref)) {
      target = await this.helper(grant.tabId, 'prepare_action', {
        ...args,
        action: operation,
        document_nonce: page.document_nonce,
      });
    }
    return {
      summary: actionSummary(operation, args, page, target?.matches === 1 ? target : null),
      document_nonce: page.document_nonce,
      approval_token: target?.approval_token,
    };
  }

  async releaseAction(grant: Grant, preview: Wire | null | undefined) {
    if (preview?.approval_token) {
      await this.helper(grant.tabId, 'release_action', { approval_token: preview.approval_token });
    }
  }

  async execute(
    grant: Grant,
    operation: string,
    args: Wire,
    checkCurrent: (after?: boolean) => void,
    preview?: Wire | null,
  ): Promise<any> {
    if (!validOperationArgs(operation, args)) fail('INVALID_ARGUMENT');
    await this.assertWorkspace(grant);
    const tabId = grant.tabId;
    if (operation === 'navigate') {
      // Navigation needs no document access, so blank and browser-owned pages can start a task.
      checkCurrent();
      const url = navigationUrl(args.url, grant.protected_origins);
      const prior = await this.api.tabs.get(tabId);
      grant.navigation = { from: prior.url, url };
      await this.api.tabs.update(tabId, { url });
      grant.url = url;
      grant.pageState = 'loading';
      checkCurrent(true);
      return { url, navigation_started: true };
    }
    if (operation === 'wait_for_page') {
      const timeout = args.timeout_ms ?? PAGE_WAIT_MS;
      const deadline = Date.now() + timeout;
      while (true) {
        let page: any;
        try {
          page = await this.waitForInspection(grant, Math.max(0, deadline - Date.now()), checkCurrent);
        } catch (error: any) {
          if (error.code === 'TARGET_STALE' && args.timeout_ms === 0) error.code = error.message = 'WAIT_TIMEOUT';
          throw error;
        }
        const loaded = {
          state: 'loaded',
          url: page.url,
          document: page.document_nonce,
          document_ready: true,
          content_ready: null,
          ...(page.content_type ? { content_type: page.content_type } : {}),
        };
        if (!args.content_selector) return loaded;
        const condition = await this.helper(tabId, 'content_readiness', {
          selector: args.content_selector,
          document_nonce: page.document_nonce,
        });
        checkCurrent();
        await this.assertWorkspace(grant);
        if (condition.ready) return { ...loaded, content_ready: true };
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('WAIT_TIMEOUT'), {
            code: 'WAIT_TIMEOUT',
            readiness_stage: 'content_readiness',
            last_error: 'ELEMENT_NOT_FOUND',
            timeout_ms: timeout,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
    const document = await this.waitForInspection(
      grant,
      args.timeout_ms ?? PAGE_WAIT_MS,
      checkCurrent,
      operation === 'navigate',
    );
    if (preview?.document_nonce && preview.document_nonce !== document.document_nonce) {
      throw Object.assign(new Error('TARGET_STALE'), { code: 'TARGET_STALE', inspection_stage: 'document_changed' });
    }
    if (operation === 'navigate') {
      const url = navigationUrl(args.url, grant.protected_origins);
      grant.blankAllowed = false;
      grant.navigation = { document: document.document_nonce, from: document.url, url };
      await this.api.tabs.update(tabId, { url });
      return { url, navigation_started: true };
    }
    if (operation === 'evaluate_script') return this.evaluateScript(grant, document, args, checkCurrent);
    if (operation === 'get_screenshot') {
      if (this.browserName === 'chrome') {
        const screenshot = (await this.api.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        })) as { data?: unknown };
        if (typeof screenshot.data !== 'string' || !screenshot.data.length) fail('CAPABILITY_UNAVAILABLE');
        return boundedResult({ mimeType: 'image/png', data: screenshot.data });
      }
      if (!this.api.tabs.captureTab) fail('CAPABILITY_UNAVAILABLE');
      let screenshot: unknown;
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
    const waitable = ['click', 'type_text', 'get_text', 'select_option', 'set_checked', 'press_key', 'scroll'].includes(
      operation,
    );
    const timeoutMs = args.timeout_ms ?? (waitable ? 3000 : 0);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      checkCurrent();
      await this.assertWorkspace(grant);
      try {
        return await this.helper(tabId, operation, {
          ...args,
          document_nonce: document.document_nonce,
          ...(preview?.approval_token ? { approval_token: preview.approval_token } : {}),
        });
      } catch (error: any) {
        const retryable = READINESS_ERRORS.includes(error.code);
        if (!waitable || !retryable || args.timeout_ms === 0) throw error;
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('WAIT_TIMEOUT'), {
            code: 'WAIT_TIMEOUT',
            last_error: error.code,
            timeout_ms: timeoutMs,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
      }
    }
  }
}
