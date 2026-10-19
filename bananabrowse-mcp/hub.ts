import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  VERSION,
  OPERATIONS,
  HEARTBEAT_MS,
  LIVENESS_MS,
  EXECUTION_MS,
  PAIRING_CODE_MS,
  SESSION_TAB_LIMIT,
  SESSION_CONCURRENCY,
  ACCESS_TOKEN_MS,
  connectPayload,
  verify,
  navigationUrl,
  navigableUrl,
  OPERATION_SCHEMAS,
  HANDOFF_SCHEMA,
  DESCRIPTION_SCHEMA,
  TAB_ID_SCHEMA,
  schemaArgumentErrors,
  inspectionErrorDetails,
  waitErrorDetails,
  validBrowserInfo,
  normalizePairingCode,
  validName,
  validShortId,
  agentColor,
  errorDetails,
  EXTENSION_FEATURES,
  versionAtLeast,
  MAX_MESSAGE_BYTES,
  type Wire,
} from '../shared/protocol.js';
import { ArtifactStore } from './artifacts.js';
import { token, hash, cleanText, type Store, type SessionRow } from './store.js';
import type { Agent, Config } from './config.js';
import { sanitizeDiagnostics } from '../shared/diagnostics.js';
import { RateLimiter } from './rate.js';
import { Fault, requireValue, requireArguments, dispatchDetails, failureCode, audit } from './errors.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_STATES = new Set(['ready', 'loading', 'navigation_only', 'unavailable']);
const RESULT_ERRORS = new Set([
  'HANDOFF_REQUIRED',
  'CAPABILITY_UNAVAILABLE',
  'TARGET_STALE',
  'NOT_AUTHORIZED',
  'INVALID_ARGUMENTS',
  'OPERATION_FAILED',
  'OUTCOME_UNKNOWN',
  'COMMAND_EXPIRED',
  'COMMAND_CANCELLED',
  'ACTION_DECLINED',
  'INVALID_MESSAGE',
  'ELEMENT_NOT_FOUND',
  'INVALID_SELECTOR',
  'PAGE_UNAVAILABLE',
  'ELEMENT_AMBIGUOUS',
  'ELEMENT_STALE',
  'ELEMENT_DISABLED',
  'ELEMENT_READONLY',
  'ELEMENT_NOT_VISIBLE',
  'ELEMENT_OBSCURED',
  'ELEMENT_NOT_EDITABLE',
  'OPTION_NOT_FOUND',
  'WAIT_TIMEOUT',
  'RESULT_TOO_LARGE',
  'SCRIPT_POLICY_BLOCKED',
  'SCRIPT_SYNTAX_ERROR',
  'SCRIPT_RUNTIME_ERROR',
  'SCRIPT_SERIALIZATION_ERROR',
  'SCRIPT_EXECUTION_UNAVAILABLE',
  'SESSION_ENDED',
  'SESSION_DETACHED',
  'TAB_NOT_IN_SESSION',
  'DOCUMENT_NOT_CONTROLLABLE',
  'TAB_LIMIT_REACHED',
  'NOTIFICATION_UNAVAILABLE',
  'INPUT_REJECTED',
  'INPUT_NOT_APPLIED',
  'PERMISSION_REQUIRED',
]);
const MAX_PENDING_PER_BROWSER = 8;

type Finish<T = unknown> = (error?: unknown, value?: T) => void;
interface Challenge {
  origin: string;
  nonce: string;
  browser_id: string;
  connection_id: string;
}
export interface Conn {
  ws: WebSocket;
  origin: string | undefined;
  connection_id: string;
  lastSeen: number;
  lastPing: number;
  authenticated: boolean;
  browser_id: string | null;
  challenge: Challenge | null;
  processing: Promise<void>;
  queued: number;
  graceful: boolean;
  agentsSignature: string;
  lastType?: string | null;
  browser_info?: Wire | null;
  closed?: boolean;
}
interface Slot {
  cancel: Finish;
  release: () => void;
}
export interface Live {
  session_id: string;
  agent_id: string;
  browser_id: string;
  conn: Conn;
  state: string;
  client_id?: string;
  tabs: Map<string, Target>;
  running: number;
  creating: number;
  slots: Set<Slot>;
  firstSync: boolean;
}
export interface Target {
  id: string;
  session_id: string;
  live: Live;
  tail: Promise<unknown>;
  queued: number;
  execution_state: string;
  queuedControllers: Set<AbortController>;
  key: number;
  title: string;
  url: string;
  page_state: string;
  capabilities: string[];
}
interface Authority {
  live: Live;
  target: Target | null;
  operation: string;
  connection_id?: string;
}
interface Call extends Authority {
  connection_id: string;
  conn: Conn;
  phase: string;
  deadline: number;
  before: Set<string>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancel: (code: string) => void;
  execute: () => void;
}
interface Proposal {
  request_id: string;
  agent_id: string;
  waiters: Set<Finish>;
}
interface CodeEntry {
  browser_id: string;
  connection_id: string;
  expires: number;
  proposal: Proposal | null;
}
interface SessionRequest {
  id: string;
  agent_id: string;
  browser_id: string;
  conn: Conn;
  purpose: string;
  title: string;
  session_id: string | null;
  check: (() => void) | null;
  finish?: Finish | null;
}
export interface AgentInfo {
  id: string;
  name: string;
  url: string | null;
  color: string;
}

function waitFor<T = unknown>(
  deadline: number,
  signal: AbortSignal | null | undefined,
  register: (finish: Finish<T>) => (() => unknown) | void,
  now: () => number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    // Registration can settle synchronously before returning its cleanup.
    let cleanup: (() => unknown) | void = undefined;
    const finish: Finish<T> = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      cleanup?.();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(signal?.reason instanceof Fault ? signal.reason : new Fault('COMMAND_CANCELLED'));
    const timer = setTimeout(() => finish(new Fault('COMMAND_EXPIRED')), Math.max(1, deadline - now()));
    signal?.addEventListener('abort', abort, { once: true });
    cleanup = register(finish);
    if (done) cleanup?.();
    if (signal?.aborted) abort();
  });
}

function requireExtension(conn: Conn | null | undefined, feature: keyof typeof EXTENSION_FEATURES): void {
  const required = EXTENSION_FEATURES[feature];
  if (versionAtLeast(conn?.browser_info?.extension_version, required)) return;
  throw Object.assign(new Fault('CAPABILITY_UNAVAILABLE'), {
    dispatch_status: 'not_dispatched',
    required_extension_version: required,
  });
}

export class Hub {
  store: Store;
  config: Config;
  now: () => number;
  agents: Map<string, Agent>;
  artifacts: ArtifactStore;
  connections: Map<string, Conn>;
  recentDisconnects: Map<string, { reason: string; at: number }>;
  sockets: Set<WebSocket>;
  live: Map<string, Live>;
  calls: Map<string, Call>;
  tombstones: Map<string, { agent_id: string; reason: string; expires: number }>;
  tokens: Map<string, { browser_id: string; expires: number }>;
  codes: Map<string, CodeEntry>;
  sessionRequests: Map<string, SessionRequest>;
  codeKey: string;
  rates: RateLimiter;
  lastStoreSweep: number;
  wss: WebSocketServer;
  timer: NodeJS.Timeout;
  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
    this.now = config.now || Date.now;
    this.agents = config.agents || new Map();
    store.pruneAgents([...this.agents.keys()]);
    this.artifacts = new ArtifactStore({ directory: config.artifacts ?? null, now: this.now });
    this.artifacts.prune([...this.agents.keys()]);
    this.connections = new Map();
    this.recentDisconnects = new Map();
    this.sockets = new Set();
    this.live = new Map();
    this.calls = new Map();
    this.tombstones = new Map();
    this.tokens = new Map();
    this.codes = new Map();
    this.sessionRequests = new Map();
    this.codeKey = config.pairingSecret || randomBytes(32).toString('base64url');
    this.rates = new RateLimiter(this.now);
    this.lastStoreSweep = 0;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.connected(ws, req));
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }

  agent(id: string): AgentInfo | undefined {
    const agent = this.agents.get(id);
    return agent && { id: agent.id, name: agent.name, url: agent.url, color: agentColor(agent.id) };
  }
  issueAccessToken(browserId: string): { access_token: string; expires_at: number } {
    for (const [key, row] of this.tokens) if (row.expires <= this.now()) this.tokens.delete(key);
    requireValue(this.tokens.size < 20_000, 'RATE_LIMITED', 429);
    const value = token(),
      expires = this.now() + ACCESS_TOKEN_MS;
    this.tokens.set(hash(value), { browser_id: browserId, expires });
    return { access_token: value, expires_at: expires };
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (
      req.url !== '/extension' ||
      this.sockets.size >= 512 ||
      !/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(req.headers.origin || '')
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }
  connected(ws: WebSocket, req: IncomingMessage): void {
    this.sockets.add(ws);
    const conn: Conn = {
      ws,
      origin: req.headers.origin,
      connection_id: randomUUID(),
      lastSeen: this.now(),
      lastPing: this.now(),
      authenticated: false,
      browser_id: null,
      challenge: null,
      processing: Promise.resolve(),
      queued: 0,
      graceful: false,
      agentsSignature: '',
    };
    const timeout = setTimeout(() => {
      if (!conn.authenticated) ws.close(1008, 'AUTH_TIMEOUT');
    }, 10_000);
    ws.on('message', (raw) => {
      if ((!conn.authenticated && (raw as Buffer).length > 8192) || ++conn.queued > 64) {
        ws.close(1008, 'MESSAGE_LIMIT');
        return;
      }
      conn.processing = conn.processing
        .then(async () => {
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            throw new Fault('INVALID_MESSAGE');
          }
          requireValue(message && typeof message === 'object' && !Array.isArray(message), 'INVALID_MESSAGE');
          await this.message(conn, message as Wire);
        })
        .catch((error) => {
          const code = failureCode(error);
          audit('ws_failure', { browser_id: conn.browser_id, code });
          this.send(conn, { type: 'error', code, ...(conn.lastType ? { in_reply_to: conn.lastType } : {}) });
          if (!conn.authenticated || code === 'NOT_AUTHORIZED') {
            this.disconnected(conn, code);
            ws.close(1008, code);
          }
        })
        .finally(() => {
          conn.queued--;
        });
    });
    // Let already-received frames (typically a final `bye`) finish before tearing the connection down.
    ws.on('close', (closeCode) => {
      clearTimeout(timeout);
      this.sockets.delete(ws);
      void conn.processing.finally(() => this.disconnected(conn, 'BROWSER_OFFLINE', closeCode));
    });
    ws.on('error', () => {
      audit('ws_failure', { code: 'CONNECTION_ERROR' });
      this.disconnected(conn, 'CONNECTION_ERROR');
      ws.terminate();
    });
  }
  send(conn: Conn | null | undefined, message: Wire): boolean {
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.ws.send(JSON.stringify(message));
    return true;
  }
  current(conn: Conn | null | undefined): boolean {
    return Boolean(
      conn?.authenticated &&
      this.connections.get(conn.browser_id!) === conn &&
      conn.ws.readyState === 1 &&
      this.store.browser(conn.browser_id!),
    );
  }
  online(browserId: string): Conn | null | undefined {
    const conn = this.connections.get(browserId);
    return this.current(conn) ? conn : null;
  }
  offlineFault(browserId: string): Fault {
    const recent = this.recentDisconnects.get(browserId);
    return Object.assign(new Fault('BROWSER_OFFLINE'), {
      offline_reason: recent && this.now() - recent.at < LIVENESS_MS ? recent.reason : 'unknown',
    });
  }
  agentsFor(browserId: string): (AgentInfo | undefined)[] {
    return this.store
      .agentsForBrowser(browserId)
      .map((row) => this.agent(row.agent_id))
      .filter(Boolean);
  }
  sessionsFor(browserId: string): Wire[] {
    return this.store.sessionsForBrowser(browserId).map((row) => ({
      session_id: row.id,
      group_id: row.group_id,
      client_id: row.group_client_id,
      agent_id: row.agent_id,
      title: row.title,
      purpose: row.purpose,
    }));
  }
  pushAgents(conn: Conn): void {
    const agents = this.agentsFor(conn.browser_id!);
    const signature = JSON.stringify(agents);
    if (signature === conn.agentsSignature) return;
    conn.agentsSignature = signature;
    this.send(conn, { type: 'agents', agents });
  }

  async message(conn: Conn, m: Wire): Promise<void> {
    conn.lastType = typeof m.type === 'string' ? m.type.slice(0, 40) : null;
    if (!conn.authenticated) {
      if (m.type === 'hello' && !conn.challenge) {
        requireValue(m.version === VERSION, 'UPGRADE_REQUIRED');
        requireValue(m.browser_info === undefined || validBrowserInfo(m.browser_info), 'INVALID_MESSAGE');
        const issued = typeof m.access_token === 'string' && this.tokens.get(hash(m.access_token));
        requireValue(issued && issued.expires > this.now(), 'NOT_AUTHORIZED', 401);
        const browser = this.store.browser(issued.browser_id);
        requireValue(browser && browser.extension_origin === conn.origin, 'NOT_AUTHORIZED', 401);
        conn.browser_info = m.browser_info || null;
        conn.challenge = {
          origin: this.config.origin,
          nonce: token(),
          browser_id: browser.id,
          connection_id: conn.connection_id,
        };
        this.send(conn, { type: 'challenge', nonce: conn.challenge.nonce, connection_id: conn.connection_id });
        return;
      }
      requireValue(m.type === 'proof' && conn.challenge, 'NOT_AUTHORIZED', 401);
      const challenge = conn.challenge;
      conn.challenge = null;
      const browser = this.store.browser(challenge.browser_id);
      requireValue(browser, 'NOT_AUTHORIZED', 401);
      let verified = false;
      try {
        verified = await verify(JSON.parse(browser.public_key), connectPayload(challenge), m.signature);
      } catch {
        throw new Fault('NOT_AUTHORIZED', 401);
      }
      requireValue(verified && conn.ws.readyState === 1 && this.store.browser(browser.id), 'NOT_AUTHORIZED', 401);
      const old = this.connections.get(browser.id);
      if (old) {
        this.disconnected(old, 'REPLACED');
        old.ws.close(1000, 'REPLACED');
      }
      conn.authenticated = true;
      conn.browser_id = browser.id;
      conn.lastSeen = this.now();
      this.connections.set(browser.id, conn);
      this.recentDisconnects.delete(browser.id);
      this.store.touchBrowser(browser.id);
      conn.agentsSignature = JSON.stringify(this.agentsFor(browser.id));
      this.send(conn, {
        type: 'welcome',
        browser_id: browser.id,
        name: browser.name,
        connection_id: conn.connection_id,
        protected_origins: this.config.protectedOrigins,
        agents: JSON.parse(conn.agentsSignature),
        sessions: this.sessionsFor(browser.id),
      });
      audit('browser_connected', { browser_id: browser.id, connection_id: conn.connection_id });
      return;
    }
    if (m.type === 'bye') {
      conn.graceful = true;
      return;
    }
    if (conn.ws.readyState !== 1) return;
    requireValue(this.current(conn), 'NOT_AUTHORIZED', 401);
    conn.lastSeen = this.now();
    switch (m.type) {
      case 'pong':
        return;
      case 'sync':
        return this.sync(conn, m);
      case 'pairing.code':
        return this.registerCode(conn, m);
      case 'pairing.cancel':
        this.dropCodes(conn.browser_id, 'PAIRING_UNAVAILABLE');
        return;
      case 'pairing.decision':
        return this.pairingDecision(conn, m);
      case 'pairing.revoke': {
        requireValue(typeof m.agent_id === 'string', 'INVALID_MESSAGE');
        this.store.unpair(m.agent_id, conn.browser_id!);
        this.reconcile();
        return;
      }
      case 'session.decision':
        return this.sessionDecision(conn, m);
      case 'browser.rename': {
        requireValue(validName(m.name), 'INVALID_MESSAGE');
        this.store.renameBrowser(conn.browser_id!, m.name);
        this.send(conn, { type: 'browser', name: m.name.trim() });
        return;
      }
      case 'browser.forget': {
        const id = conn.browser_id!;
        this.store.deleteBrowser(id);
        audit('browser_forgotten', { browser_id: id });
        this.reconcile();
        return;
      }
      case 'command.ready':
        return this.commandReady(conn, m);
      case 'result':
        return this.commandResult(conn, m);
      default:
        throw new Fault('INVALID_MESSAGE');
    }
  }

  // ---------- inventory ----------
  sync(conn: Conn, m: Wire): void {
    requireValue(Array.isArray(m.groups) && m.groups.length <= 64, 'INVALID_MESSAGE');
    const rows = new Map(this.store.sessionsForBrowser(conn.browser_id!).map((row) => [row.group_client_id, row]));
    const seen = new Set<string>(),
      assignments: Wire[] = [],
      unknown: string[] = [];
    for (const group of m.groups) {
      requireValue(
        group &&
          UUID.test(group.client_id || '') &&
          ['attached', 'unconfirmed'].includes(group.state) &&
          typeof group.title === 'string' &&
          Array.isArray(group.tabs) &&
          group.tabs.length <= SESSION_TAB_LIMIT &&
          (group.request_id === undefined || UUID.test(group.request_id)),
        'INVALID_MESSAGE',
      );
      const row = rows.get(group.client_id);
      if (!row) {
        // Approved-but-uncommitted groups are announced before their session exists.
        const pending = group.request_id && this.sessionRequests.get(group.request_id);
        if (!pending || pending.browser_id !== conn.browser_id) unknown.push(group.client_id);
        continue;
      }
      requireValue(!seen.has(row.id), 'INVALID_MESSAGE');
      seen.add(row.id);
      // Still awaiting session.created on the browser side: keep it alive, but publish no (empty) state yet.
      if (group.request_id) continue;
      this.store.keepSession(row.id, group.title || this.agent(row.agent_id)?.name || 'BananaBrowse');
      let live: Live | undefined = this.live.get(row.id);
      if (!live) {
        live = {
          session_id: row.id,
          agent_id: row.agent_id,
          browser_id: row.browser_id,
          conn,
          state: group.state,
          tabs: new Map(),
          running: 0,
          creating: 0,
          slots: new Set(),
          firstSync: false,
        };
        this.live.set(row.id, live);
      }
      live.conn = conn;
      live.state = group.state;
      live.client_id = row.group_client_id;
      if (group.state === 'unconfirmed') {
        this.invalidate(live, 'SESSION_DETACHED');
        continue;
      }
      const stored = new Map(this.store.tabsForSession(row.id).map((tab) => [tab.id, tab]));
      const next = new Map<string, Target>(),
        keys = new Set<number>();
      for (const tab of group.tabs) {
        requireValue(
          tab &&
            Number.isSafeInteger(tab.key) &&
            tab.key >= 0 &&
            !keys.has(tab.key) &&
            typeof tab.title === 'string' &&
            typeof tab.url === 'string' &&
            tab.url.length <= 8192 &&
            PAGE_STATES.has(tab.page_state) &&
            Array.isArray(tab.capabilities) &&
            tab.capabilities.every((op: string) => OPERATIONS.includes(op)) &&
            (tab.id === undefined || tab.id === null || typeof tab.id === 'string'),
          'INVALID_MESSAGE',
        );
        keys.add(tab.key);
        const ordinary = navigableUrl(tab.url, this.config.protectedOrigins) !== null;
        // Non-URL documents are navigation-only; protected origins are not listed at all.
        const origin = ordinary ? null : URL.parse(tab.url)?.origin;
        if (origin && this.config.protectedOrigins.includes(origin)) continue;
        const capabilities =
          ordinary && !['navigation_only', 'unavailable'].includes(tab.page_state)
            ? [...new Set(tab.capabilities)]
            : ['navigate'];
        const page_state = ordinary ? tab.page_state : 'navigation_only';
        let id: string | null = typeof tab.id === 'string' && stored.has(tab.id) && !next.has(tab.id) ? tab.id : null;
        if (!id) {
          // A sync can race ahead of the previous acknowledgement; the same browser tab keeps its ID.
          const known = [...live.tabs.values()].find((target) => target.key === tab.key && !next.has(target.id));
          if (known && stored.has(known.id)) {
            id = known.id;
            assignments.push({ client_id: group.client_id, key: tab.key, id });
          }
        }
        if (id) this.store.updateTab(id, tab.url, tab.title);
        else {
          id = this.store.createTab(row.id, tab.url, tab.title);
          assignments.push({ client_id: group.client_id, key: tab.key, id });
        }
        let target = live.tabs.get(id);
        if (!target)
          target = {
            id,
            session_id: row.id,
            live,
            tail: Promise.resolve(),
            queued: 0,
            execution_state: 'idle',
            queuedControllers: new Set(),
          } as unknown as Target;
        Object.assign(target, {
          key: tab.key,
          title: cleanText(tab.title, 160),
          url: cleanText(tab.url, 2048),
          page_state,
          capabilities,
        });
        for (const call of this.calls.values()) {
          if (
            call.target === target &&
            !['request_handoff', 'navigate'].includes(call.operation) &&
            !capabilities.includes(call.operation)
          )
            call.cancel('DOCUMENT_NOT_CONTROLLABLE');
        }
        next.set(id, target);
      }
      for (const [id, target] of live.tabs) if (!next.has(id)) this.removeTarget(target, 'TAB_NOT_IN_SESSION');
      for (const id of stored.keys()) if (!next.has(id)) this.store.deleteTab(id);
      live.tabs = next;
      live.firstSync = true;
    }
    for (const row of rows.values()) {
      if (!seen.has(row.id)) this.endSession(row.id, 'SESSION_ENDED', false);
    }
    this.send(conn, { type: 'sync.ack', assignments, unknown });
    for (const request of this.sessionRequests.values()) request.check?.();
  }
  removeTarget(target: Target, reason: string): void {
    const live = target.live;
    if (live.tabs.get(target.id) === target) live.tabs.delete(target.id);
    this.tombstones.set(target.id, { agent_id: live.agent_id, reason, expires: this.now() + 600_000 });
    while (this.tombstones.size > 4096) this.tombstones.delete(this.tombstones.keys().next().value!);
    for (const call of [...this.calls.values()]) if (call.target === target) call.cancel(reason);
    for (const controller of target.queuedControllers) controller.abort(new Fault(reason));
  }
  invalidate(live: Live, reason: string): void {
    for (const target of [...live.tabs.values()]) this.removeTarget(target, reason);
    for (const call of [...this.calls.values()]) if (call.live === live) call.cancel(reason);
    for (const slot of [...live.slots]) slot.cancel(new Fault(reason));
  }
  endSession(id: string, reason = 'SESSION_ENDED', notify = true): void {
    const row = this.store.session(id),
      live = this.live.get(id);
    const browserId = row?.browser_id || live?.browser_id,
      clientId = row?.group_client_id || live?.client_id;
    if (live) {
      this.invalidate(live, reason);
      this.live.delete(id);
    }
    if (row) this.store.deleteSession(id);
    if (notify && clientId)
      this.send(this.online(browserId!), { type: 'session.end', session_id: id, client_id: clientId });
  }

  // ---------- pairing ----------
  codeHash(code: unknown): string {
    let normalized: string;
    try {
      normalized = normalizePairingCode(code);
    } catch {
      throw new Fault('PAIRING_UNAVAILABLE', 404);
    }
    return createHmac('sha256', this.codeKey).update('bananabrowse.v6.pairing-code\0').update(normalized).digest('hex');
  }
  dropCodes(browserId: string | null, reason: string): void {
    for (const [key, entry] of this.codes) {
      if (entry.browser_id !== browserId) continue;
      this.codes.delete(key);
      for (const waiter of [...(entry.proposal?.waiters || [])]) waiter(new Fault(reason));
    }
  }
  registerCode(conn: Conn, m: Wire): void {
    this.rates.take(`code:${conn.browser_id}`, 20);
    const key = this.codeHash(m.code);
    const existing = this.codes.get(key);
    requireValue(!existing || existing.browser_id === conn.browser_id, 'PAIRING_CODE_COLLISION', 409);
    this.dropCodes(conn.browser_id, 'PAIRING_UNAVAILABLE');
    requireValue(this.codes.size < 5000, 'RATE_LIMITED', 429);
    const expires = this.now() + PAIRING_CODE_MS;
    this.codes.set(key, { browser_id: conn.browser_id!, connection_id: conn.connection_id, expires, proposal: null });
    this.send(conn, { type: 'pairing.code.ok', code: m.code, expires_at: expires });
  }
  pairingDecision(conn: Conn, m: Wire): void {
    requireValue(UUID.test(m.request_id || '') && typeof m.approved === 'boolean', 'INVALID_MESSAGE');
    for (const [key, entry] of this.codes) {
      if (entry.browser_id !== conn.browser_id || entry.proposal?.request_id !== m.request_id) continue;
      this.codes.delete(key);
      const { agent_id, waiters } = entry.proposal!;
      if (m.approved && this.agents.has(agent_id)) {
        const before = this.store.browser(conn.browser_id!)!.name;
        const name = this.store.pair(agent_id, conn.browser_id!);
        audit('browser_paired', { browser_id: conn.browser_id, agent_id });
        if (name !== before) this.send(conn, { type: 'browser', name });
        this.pushAgents(conn);
        for (const waiter of [...waiters]) waiter(null, { browser_id: conn.browser_id, name, paired: true });
      } else for (const waiter of [...waiters]) waiter(new Fault('ACTION_DECLINED'));
      return;
    }
  }
  async pairBrowser(agentId: string, code: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Wire> {
    this.rates.take(`pair:${agentId}`, 20);
    this.rates.take('pair:global', 200);
    const key = this.codeHash(code),
      entry = this.codes.get(key);
    requireValue(entry && entry.expires > this.now(), 'PAIRING_UNAVAILABLE', 404);
    if (this.store.paired(agentId, entry.browser_id)) {
      const browser = this.store.browser(entry.browser_id)!;
      return { browser_id: browser.id, name: browser.name, paired: true };
    }
    const conn = this.online(entry.browser_id);
    requireValue(conn && conn.connection_id === entry.connection_id, 'PAIRING_UNAVAILABLE', 404);
    requireValue(!entry.proposal || entry.proposal.agent_id === agentId, 'PAIRING_UNAVAILABLE', 404);
    if (!entry.proposal) {
      entry.proposal = { request_id: randomUUID(), agent_id: agentId, waiters: new Set() };
      this.send(conn, {
        type: 'pairing.proposal',
        request_id: entry.proposal.request_id,
        agent: this.agent(agentId),
        expires_at: entry.expires,
      });
    }
    const proposal = entry.proposal;
    const deadline = Math.min(this.now() + timeoutMs, entry.expires);
    return waitFor<Wire>(
      deadline,
      signal,
      (finish) => {
        proposal.waiters.add(finish as Finish);
        return () => proposal.waiters.delete(finish as Finish);
      },
      this.now,
    );
  }

  // ---------- sessions ----------
  requireSession(agentId: string, sessionId: unknown): SessionRow {
    const row = validShortId('s', sessionId) && this.store.session(sessionId);
    requireValue(row && row.agent_id === agentId && this.store.paired(agentId, row.browser_id), 'NOT_FOUND', 404);
    return row;
  }
  requireAttached(agentId: string, sessionId: unknown): { row: SessionRow; conn: Conn; live: Live } {
    const row = this.requireSession(agentId, sessionId);
    const conn = this.online(row.browser_id);
    requireValue(conn, 'BROWSER_OFFLINE');
    const live = this.live.get(row.id);
    requireValue(live && live.conn === conn && live.state === 'attached' && live.firstSync, 'SESSION_DETACHED');
    return { row, conn, live };
  }
  sessionState(row: SessionRow): string {
    const conn = this.online(row.browser_id),
      live = this.live.get(row.id);
    return conn && live?.conn === conn && live.state === 'attached' ? 'attached' : 'detached';
  }
  publicSession(row: SessionRow): Wire {
    const live = this.live.get(row.id);
    const state = this.sessionState(row);
    return {
      session_id: row.id,
      browser_id: row.browser_id,
      tab_group_id: row.group_id,
      title: row.title,
      purpose: row.purpose,
      state,
      expires_at: row.expires_at,
      tab_count: state === 'attached' ? live!.tabs.size : 0,
    };
  }
  publicTab(target: Target): Wire {
    return {
      tab_id: target.id,
      title: target.title,
      url: target.url,
      page_state: target.page_state,
      capabilities: [...target.capabilities],
      execution_state: target.execution_state,
    };
  }
  listBrowsers(agentId: string): Wire[] {
    return this.store.browsersForAgent(agentId).map((row) => {
      const conn = this.online(row.id);
      return {
        browser_id: row.id,
        name: row.name,
        online: Boolean(conn),
        browser_info: conn?.browser_info || null,
        last_seen: new Date(conn ? this.now() : row.last_seen).toISOString(),
        paired_at: new Date(row.paired_at).toISOString(),
      };
    });
  }
  unpairBrowser(agentId: string, browserId: string): Wire {
    requireValue(this.store.unpair(agentId, browserId), 'NOT_FOUND', 404);
    audit('browser_unpaired', { browser_id: browserId, agent_id: agentId });
    this.reconcile();
    return { browser_id: browserId, unpaired: true };
  }
  listSessions(agentId: string): Wire[] {
    return this.store
      .sessionsForAgent(agentId)
      .filter((row) => this.store.paired(agentId, row.browser_id))
      .map((row) => this.publicSession(row));
  }
  listTabs(agentId: string, sessionId: unknown): Wire[] {
    const { live } = this.requireAttached(agentId, sessionId);
    return [...live.tabs.values()].map((target) => this.publicTab(target));
  }
  async requestSession(agentId: string, args: Wire, signal?: AbortSignal): Promise<Wire> {
    requireValue(validShortId('b', args.browser_id) && this.store.paired(agentId, args.browser_id), 'NOT_FOUND', 404);
    const conn = this.online(args.browser_id);
    if (!conn) throw Object.assign(this.offlineFault(args.browser_id), { dispatch_status: 'not_dispatched' });
    const urls = args.urls || [];
    for (const url of urls) {
      try {
        navigationUrl(url, this.config.protectedOrigins);
      } catch {
        throw new Fault('HANDOFF_REQUIRED');
      }
    }
    this.rates.take(`session:${agentId}:${args.browser_id}`, 10);
    requireValue(
      [...this.sessionRequests.values()].filter((r) => r.browser_id === args.browser_id).length <
        MAX_PENDING_PER_BROWSER,
      'QUEUE_FULL',
      429,
    );
    const agent = this.agent(agentId);
    const title = cleanText(args.title || agent!.name, 120);
    const request: SessionRequest = {
      id: randomUUID(),
      agent_id: agentId,
      browser_id: args.browser_id,
      conn,
      purpose: args.purpose,
      title,
      session_id: null,
      check: null,
    };
    const deadline = this.now() + (args.timeout_seconds ?? 300) * 1000;
    this.sessionRequests.set(request.id, request);
    audit('session_requested', {
      browser_id: args.browser_id,
      agent_id: agentId,
      request_id: request.id,
      connection_id: conn.connection_id,
      request_phase: 'awaiting_approval',
    });
    this.send(conn, {
      type: 'session.request',
      request_id: request.id,
      agent,
      purpose: args.purpose,
      urls,
      title,
      expires_at: deadline,
    });
    try {
      await waitFor(
        deadline,
        signal,
        (finish) => {
          request.finish = finish;
          return () => {
            request.finish = null;
          };
        },
        this.now,
      );
    } catch (error) {
      this.sessionRequests.delete(request.id);
      if (!request.session_id) this.send(conn, { type: 'session.request.cancel', request_id: request.id });
      throw error;
    }
    // Approval committed: give the first inventory a bounded chance to publish starting tabs.
    const sessionId = request.session_id!;
    try {
      await waitFor(
        this.now() + 10_000,
        signal,
        (finish) => {
          request.check = () => {
            if (this.live.get(sessionId)?.firstSync || !this.store.session(sessionId) || !this.current(conn)) finish();
          };
          request.check();
          return () => {
            request.check = null;
          };
        },
        this.now,
      );
    } catch (error) {
      if ((error as Fault).code !== 'COMMAND_EXPIRED') throw error;
    } finally {
      this.sessionRequests.delete(request.id);
    }
    const row = this.store.session(sessionId);
    requireValue(row, 'SESSION_ENDED');
    const live = this.live.get(sessionId);
    return {
      ...this.publicSession(row),
      tabs: live ? [...live.tabs.values()].map((target) => this.publicTab(target)) : [],
    };
  }
  sessionDecision(conn: Conn, m: Wire): void {
    requireValue(UUID.test(m.request_id || '') && typeof m.approved === 'boolean', 'INVALID_MESSAGE');
    const request = this.sessionRequests.get(m.request_id);
    if (!request || request.browser_id !== conn.browser_id || request.session_id || !request.finish) {
      this.send(conn, { type: 'session.request.cancel', request_id: m.request_id });
      return;
    }
    if (!m.approved) {
      request.finish(new Fault('ACTION_DECLINED'));
      return;
    }
    requireValue(UUID.test(m.client_id || ''), 'INVALID_MESSAGE');
    if (!this.store.paired(request.agent_id, conn.browser_id)) {
      request.finish(new Fault('NOT_FOUND', 404));
      return;
    }
    const row = this.store.createSession({
      agent_id: request.agent_id,
      browser_id: conn.browser_id,
      group_client_id: m.client_id,
      purpose: request.purpose,
      title: request.title,
    });
    request.session_id = row.id;
    audit('session_created', {
      browser_id: conn.browser_id,
      agent_id: request.agent_id,
      session_id: row.id,
      request_id: request.id,
      connection_id: conn.connection_id,
      request_phase: 'approved',
    });
    this.send(conn, {
      type: 'session.created',
      request_id: request.id,
      session_id: row.id,
      group_id: row.group_id,
      client_id: m.client_id,
      agent_id: request.agent_id,
      title: row.title,
      purpose: row.purpose,
    });
    request.finish(null);
  }
  endSessionByAgent(agentId: string, sessionId: string): Wire {
    this.requireSession(agentId, sessionId);
    this.endSession(sessionId, 'SESSION_ENDED', true);
    return { session_id: sessionId, ended: true, tabs_closed: false };
  }
  // Closing tabs is never automatic: the extension asks the user and only closes after an explicit approval.
  async closeSessionTabs(
    agentId: string,
    sessionId: string,
    description: unknown,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Wire> {
    const { live } = this.requireAttached(agentId, sessionId);
    requireExtension(live.conn, 'close_tabs');
    requireValue(this.calls.size < 1024, 'QUEUE_FULL', 429);
    await this.dispatch(live, null, 'close_session', {}, description, this.now() + waitMs, signal);
    this.endSession(sessionId, 'SESSION_ENDED', false);
    return { session_id: sessionId, ended: true, tabs_closed: true };
  }
  reportProgress(agentId: string, sessionId: unknown, message: unknown): Wire {
    const row = this.requireSession(agentId, sessionId);
    const conn = this.online(row.browser_id);
    requireValue(conn, 'BROWSER_OFFLINE');
    this.rates.take(`progress:${agentId}`, 120);
    this.send(conn, { type: 'progress', session_id: row.id, agent_id: agentId, message, at: this.now() });
    return { delivered: true };
  }

  // ---------- commands ----------
  checkAuthority(call: Authority): Conn {
    const { live, target, operation } = call;
    requireValue(this.agents.has(live.agent_id) && this.store.paired(live.agent_id, live.browser_id), 'NOT_FOUND', 404);
    requireValue(this.store.session(live.session_id) && this.live.get(live.session_id) === live, 'SESSION_ENDED');
    const conn = this.online(live.browser_id);
    requireValue(conn, 'BROWSER_OFFLINE');
    requireValue(live.conn === conn && live.state === 'attached', 'SESSION_DETACHED');
    if (call.connection_id) requireValue(conn.connection_id === call.connection_id, 'BROWSER_OFFLINE');
    if (target) {
      requireValue(live.tabs.get(target.id) === target, 'TAB_NOT_IN_SESSION');
      requireValue(
        operation === 'request_handoff' || target.capabilities.includes(operation),
        ['navigation_only', 'unavailable'].includes(target.page_state)
          ? 'DOCUMENT_NOT_CONTROLLABLE'
          : 'CAPABILITY_UNAVAILABLE',
      );
    }
    return conn;
  }
  async slot(live: Live, deadline: number, signal?: AbortSignal | null): Promise<void> {
    if (live.running < SESSION_CONCURRENCY) {
      live.running++;
      return;
    }
    requireValue(live.slots.size < 64, 'QUEUE_FULL', 429);
    await waitFor(
      deadline,
      signal,
      (finish) => {
        const slot: Slot = {
          cancel: finish,
          release: () => {
            live.running++;
            finish();
          },
        };
        live.slots.add(slot);
        return () => live.slots.delete(slot);
      },
      this.now,
    );
  }
  releaseSlot(live: Live): void {
    live.running--;
    const first = live.slots.values().next().value;
    first?.release();
  }
  findTarget(agentId: string, tabId: unknown): Target {
    const owned = (target: Target | null | undefined): target is Target =>
      Boolean(target && target.live.agent_id === agentId);
    let target: Target | null | undefined = null;
    if (validShortId('t', tabId))
      for (const live of this.live.values()) {
        if (live.tabs.has(tabId)) {
          target = live.tabs.get(tabId);
          break;
        }
      }
    if (owned(target)) return target;
    const tombstone = this.tombstones.get(tabId as string);
    if (tombstone && tombstone.agent_id === agentId && tombstone.expires > this.now())
      throw new Fault(tombstone.reason);
    const row = validShortId('t', tabId) && this.store.tab(tabId);
    const session = row && this.store.session(row.session_id);
    if (session && session.agent_id === agentId) {
      requireValue(this.online(session.browser_id), 'BROWSER_OFFLINE');
      throw new Fault('SESSION_DETACHED');
    }
    throw new Fault('NOT_FOUND', 404);
  }
  async operate(
    agentId: string,
    tabId: unknown,
    operation: string,
    args: Wire,
    description: unknown,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const spec = operation === 'request_handoff' ? HANDOFF_SCHEMA : OPERATION_SCHEMAS[operation];
    requireArguments(spec ? [] : [{ field: 'operation', reason: 'invalid_enum' }]);
    requireArguments([
      ...schemaArgumentErrors(spec, args),
      ...schemaArgumentErrors(
        {
          properties: {
            tab_id: TAB_ID_SCHEMA,
            ...(operation === 'request_handoff' ? {} : { description: DESCRIPTION_SCHEMA }),
          },
          required: ['tab_id', ...(operation === 'request_handoff' ? [] : ['description'])],
        },
        { tab_id: tabId, ...(operation === 'request_handoff' ? {} : { description }) },
      ),
    ]);
    const target = this.findTarget(agentId, tabId);
    const live = target.live;
    const probe = { live, target, operation };
    if (operation === 'query_all') requireExtension(live.conn, 'query_all');
    this.checkAuthority(probe);
    if (operation === 'navigate') {
      try {
        navigationUrl(args.url, this.config.protectedOrigins);
      } catch {
        throw new Fault('HANDOFF_REQUIRED');
      }
    }
    if (operation === 'evaluate_script') args = { world: 'MAIN', ...args };
    if (args.return_as === 'artifact') requireExtension(live.conn, 'artifacts');
    requireValue(target.queued < 32 && this.calls.size < 1024, 'QUEUE_FULL', 429);
    const human = operation === 'request_handoff';
    const deadline = this.now() + (human ? waitMs : EXECUTION_MS);
    const queued = new AbortController();
    target.queuedControllers.add(queued);
    signal = signal ? AbortSignal.any([signal, queued.signal]) : queued.signal;
    const previous = target.tail;
    let release!: (value?: unknown) => void;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    // A cancelled predecessor must not let its successor overtake an earlier running call.
    target.tail = previous.then(() => mine);
    target.queued++;
    let hasSlot = false;
    try {
      await waitFor(
        deadline,
        signal,
        (finish) => {
          previous.then(() => finish(), finish);
        },
        this.now,
      );
      this.checkAuthority(probe);
      if (!human) {
        await this.slot(live, deadline, signal);
        hasSlot = true;
      }
      this.checkAuthority(probe);
      requireValue(!signal.aborted, 'COMMAND_CANCELLED');
      return await this.dispatch(live, target, operation, args, description, deadline, signal);
    } finally {
      target.queued--;
      target.queuedControllers.delete(queued);
      release();
      if (hasSlot) this.releaseSlot(live);
    }
  }
  async createTab(
    agentId: string,
    sessionId: unknown,
    args: Wire,
    description: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { live } = this.requireAttached(agentId, sessionId);
    if (args.url !== undefined) {
      try {
        navigationUrl(args.url, this.config.protectedOrigins);
      } catch {
        throw new Fault('HANDOFF_REQUIRED');
      }
    }
    requireValue(live.tabs.size + live.creating < SESSION_TAB_LIMIT, 'TAB_LIMIT_REACHED');
    const deadline = this.now() + EXECUTION_MS;
    live.creating++;
    let hasSlot = false;
    try {
      await this.slot(live, deadline, signal);
      hasSlot = true;
      this.checkAuthority({ live, target: null, operation: 'create_tab' });
      requireValue(!signal?.aborted, 'COMMAND_CANCELLED');
      return await this.dispatch(live, null, 'create_tab', args, description, deadline, signal);
    } finally {
      live.creating--;
      if (hasSlot) this.releaseSlot(live);
    }
  }
  async closeTab(
    agentId: string,
    tabId: unknown,
    description: unknown,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<Wire> {
    const target = this.findTarget(agentId, tabId),
      live = target.live;
    this.checkAuthority({ live, target: null, operation: 'close_tab' });
    requireExtension(live.conn, 'close_tabs');
    requireValue(this.calls.size < 1024, 'QUEUE_FULL', 429);
    const result = await this.dispatch(
      live,
      null,
      'close_tab',
      { tab_id: target.id },
      description,
      this.now() + waitMs,
      signal,
    );
    // Closing the last tab removes the group, so the extension ends the session right after this receipt.
    const ended = (result as Wire | undefined)?.session_ended === true;
    if (ended) this.endSession(live.session_id, 'SESSION_ENDED', false);
    return { tab_id: target.id, closed: true, session_ended: ended };
  }
  dispatch(
    live: Live,
    target: Target | null,
    operation: string,
    args: Wire,
    description: unknown,
    deadline: number,
    signal?: AbortSignal | null,
  ): Promise<unknown> {
    const conn = this.checkAuthority({ live, target, operation });
    const requestId = randomUUID();
    const before = new Set(live.tabs.keys());
    return new Promise((resolve, reject) => {
      let finished = false,
        timer: NodeJS.Timeout | undefined;
      const finish = (error: unknown, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.calls.delete(requestId);
        if (target) target.execution_state = 'idle';
        if (error) reject(error);
        else resolve(value);
      };
      const human = operation === 'request_handoff';
      const call: Call = {
        live,
        target,
        operation,
        connection_id: conn.connection_id,
        conn,
        phase: 'waiting',
        deadline,
        before,
        resolve: (value) => finish(null, value),
        reject: (error) => finish(error),
        cancel: (code) => {
          this.send(conn, { type: 'command.cancel', request_id: requestId, reason: code });
          finish(new Fault(call.phase === 'executing' && !human ? 'OUTCOME_UNKNOWN' : code));
        },
        execute: () => {
          if (call.phase !== 'waiting') return;
          call.phase = 'executing';
          clearTimeout(timer);
          if (target) target.execution_state = human ? 'waiting_for_human' : 'running';
          const executionMs = human ? Math.max(1, deadline - this.now()) : EXECUTION_MS;
          timer = setTimeout(() => call.cancel(human ? 'COMMAND_EXPIRED' : 'OUTCOME_UNKNOWN'), executionMs);
          if (!this.send(conn, { type: 'command.execute', request_id: requestId, execution_timeout_ms: executionMs })) {
            call.cancel('BROWSER_OFFLINE');
          }
        },
      };
      this.calls.set(requestId, call);
      if (target) target.execution_state = human ? 'waiting_for_human' : 'running';
      timer = setTimeout(() => call.cancel('COMMAND_EXPIRED'), Math.max(1, deadline - this.now()));
      const abort = () => call.cancel(signal?.reason instanceof Fault ? signal.reason.code : 'COMMAND_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      if (
        !this.send(conn, {
          type: 'command',
          request_id: requestId,
          session_id: live.session_id,
          tab_id: target?.id || null,
          operation,
          args,
          description: description || null,
          agent_id: live.agent_id,
          expires_at: deadline,
          wait_timeout_ms: Math.max(1, deadline - this.now()),
        })
      )
        call.cancel('BROWSER_OFFLINE');
    });
  }
  commandReady(conn: Conn, m: Wire): void {
    const call = this.calls.get(m.request_id);
    if (!call) return;
    requireValue(call.conn === conn, 'NOT_AUTHORIZED', 401);
    if (call.phase !== 'waiting') return;
    if (this.now() >= call.deadline) {
      call.cancel('COMMAND_EXPIRED');
      return;
    }
    try {
      this.checkAuthority(call);
      // eslint-disable-next-line no-catch-all/no-catch-all -- every failure must settle the call, never leave it pending
    } catch (error) {
      call.cancel(failureCode(error));
      return;
    }
    call.execute();
  }
  commandResult(conn: Conn, m: Wire): void {
    const call = this.calls.get(m.request_id);
    if (!call) {
      audit('result_discarded', { code: 'TARGET_STALE' });
      return;
    }
    requireValue(call.conn === conn, 'NOT_AUTHORIZED', 401);
    if (m.error) {
      requireValue(typeof m.error === 'object', 'INVALID_MESSAGE');
      const code = RESULT_ERRORS.has(m.error.code) ? m.error.code : 'OPERATION_FAILED';
      const diagnostics = sanitizeDiagnostics(m.error.diagnostics);
      call.reject(
        Object.assign(
          new Fault(code),
          waitErrorDetails(m.error),
          inspectionErrorDetails(m.error),
          dispatchDetails(m.error),
          errorDetails({ ...m.error, code }),
          diagnostics ? { diagnostics } : {},
        ),
      );
      return;
    }
    try {
      this.checkAuthority(call);
      // eslint-disable-next-line no-catch-all/no-catch-all -- every failure must settle the call, never leave it pending
    } catch (error) {
      call.cancel(failureCode(error));
      return;
    }
    requireValue(call.phase === 'executing', 'INVALID_MESSAGE');
    requireValue(
      Object.hasOwn(m, 'result') && Buffer.byteLength(JSON.stringify(m.result)) <= MAX_MESSAGE_BYTES,
      'INVALID_MESSAGE',
    );
    if (call.operation === 'create_tab') {
      const created = call.live.tabs.get(m.result?.tab_id);
      // A receipt cannot invent a tab: it must already be published by inventory sync.
      requireValue(created && !call.before.has(created.id), 'INVALID_MESSAGE');
      call.resolve(this.publicTab(created));
    } else call.resolve(m.result);
  }

  // ---------- lifecycle ----------
  disconnected(conn: Conn, code = 'BROWSER_OFFLINE', closeCode?: number): void {
    if (!conn.browser_id || conn.closed) return;
    conn.closed = true;
    conn.authenticated = false;
    if (this.connections.get(conn.browser_id) === conn) {
      this.connections.delete(conn.browser_id);
      const reasons: Record<string, string> = {
        REPLACED: 'connection_replaced',
        HEARTBEAT_TIMEOUT: 'heartbeat_timeout',
        SERVICE_STOPPED: 'service_stopped',
        BROWSER_OFFLINE: 'connection_lost',
        CONNECTION_ERROR: 'connection_lost',
      };
      const reason = conn.graceful ? 'graceful_disconnect' : (reasons[code] ?? 'unknown');
      this.recentDisconnects.set(conn.browser_id, { reason, at: this.now() });
    }
    for (const live of [...this.live.values()]) {
      if (live.conn !== conn) continue;
      this.invalidate(live, 'BROWSER_OFFLINE');
      this.live.delete(live.session_id);
    }
    for (const request of this.sessionRequests.values()) {
      if (request.conn === conn) {
        if (request.session_id) request.check?.();
        else request.finish?.(this.offlineFault(conn.browser_id));
      }
    }
    this.dropCodes(conn.browser_id, 'BROWSER_OFFLINE');
    audit('browser_disconnected', {
      browser_id: conn.browser_id,
      connection_id: conn.connection_id,
      code: conn.graceful ? 'GRACEFUL' : code,
      ...(closeCode === undefined ? {} : { close_code: closeCode }),
    });
  }
  reconcile(): void {
    for (const conn of [...this.connections.values()]) {
      if (!this.store.browser(conn.browser_id!)) {
        this.send(conn, { type: 'revoked' });
        this.disconnected(conn, 'REVOKED');
        conn.ws.close(1008, 'REVOKED');
        continue;
      }
      this.pushAgents(conn);
    }
    for (const live of [...this.live.values()]) {
      const row = this.store.session(live.session_id);
      if (!row || !this.agents.has(row.agent_id)) this.endSession(live.session_id, 'SESSION_ENDED', true);
    }
  }
  sweep(): void {
    for (const [id, recent] of this.recentDisconnects)
      if (this.now() - recent.at >= LIVENESS_MS) this.recentDisconnects.delete(id);
    for (const [key, entry] of this.codes)
      if (entry.expires <= this.now()) {
        this.codes.delete(key);
        for (const waiter of [...(entry.proposal?.waiters || [])]) waiter(new Fault('PAIRING_UNAVAILABLE'));
      }
    for (const [id, row] of this.tombstones) if (row.expires <= this.now()) this.tombstones.delete(id);
    if (this.now() - this.lastStoreSweep >= 5_000) {
      this.lastStoreSweep = this.now();
      for (const id of this.store.sweep().browsers) audit('browser_pruned', { browser_id: id });
      this.artifacts.sweep();
      this.reconcile();
    }
    for (const conn of [...this.connections.values()]) {
      if (this.now() - conn.lastSeen >= LIVENESS_MS) {
        this.disconnected(conn, 'HEARTBEAT_TIMEOUT');
        conn.ws.terminate();
      } else if (this.now() - conn.lastPing >= HEARTBEAT_MS) {
        conn.lastPing = this.now();
        this.send(conn, { type: 'ping' });
        this.store.touchBrowser(conn.browser_id!);
      }
    }
  }
  close(): void {
    clearInterval(this.timer);
    for (const conn of [...this.connections.values()]) this.disconnected(conn, 'SERVICE_STOPPED');
    for (const request of this.sessionRequests.values()) request.finish?.(new Fault('COMMAND_CANCELLED'));
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
  }
}
