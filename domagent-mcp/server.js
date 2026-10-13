import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  VERSION, OPERATIONS, HEARTBEAT_MS, LIVENESS_MS, HUMAN_WAIT_MS, EXECUTION_MS,
  WORKSPACE_LEASE_MS, WORKSPACE_TAB_LIMIT, WORKSPACE_CONCURRENCY,
  authPayload, workspacePayload, verify, navigationUrl, validOperationArgs, validTargetId,
  validDescription, inspectionErrorDetails, waitErrorDetails, validBrowserInfo,
  validWorkspaceEndReason,
} from '../shared/protocol.js';
import { token } from './store.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['active','paused','inactive']);
const PAGE_STATES = new Set(['ready','loading','navigation_only','unavailable']);
const RESULT_ERRORS = new Set(['HANDOFF_REQUIRED','CAPABILITY_UNAVAILABLE','TARGET_STALE','NOT_AUTHORIZED',
  'INVALID_ARGUMENTS','OPERATION_FAILED','OUTCOME_UNKNOWN','COMMAND_EXPIRED','COMMAND_CANCELLED','ACTION_DECLINED',
  'INVALID_MESSAGE','ELEMENT_NOT_FOUND','INVALID_SELECTOR','PAGE_UNAVAILABLE','ELEMENT_AMBIGUOUS','ELEMENT_STALE',
  'ELEMENT_DISABLED','ELEMENT_READONLY','ELEMENT_NOT_VISIBLE','ELEMENT_OBSCURED','ELEMENT_NOT_EDITABLE',
  'OPTION_NOT_FOUND','WAIT_TIMEOUT','RESULT_TOO_LARGE','SCRIPT_POLICY_BLOCKED','SCRIPT_SYNTAX_ERROR',
  'SCRIPT_RUNTIME_ERROR','SCRIPT_SERIALIZATION_ERROR','SCRIPT_EXECUTION_UNAVAILABLE','WORKSPACE_CHANGED',
  'WORKSPACE_PAUSED','WORKSPACE_INACTIVE','TAB_NOT_IN_WORKSPACE','DOCUMENT_NOT_CONTROLLABLE',
  'TAB_LIMIT_REACHED','NOTIFICATION_UNAVAILABLE']);
const validInt = value => Number.isSafeInteger(value) && value >= 0;

export class BridgeServer {
  constructor(store, config) {
    this.store = store; this.config = config; this.now = config.now || Date.now;
    this.epoch = randomUUID();
    this.startedAt = this.now();
    this.connections = new Map(); this.workspaces = new Map(); this.targets = new Map();
    this.calls = new Map(); this.waiters = new Set(); this.tombstones = new Map(); this.sockets = new Set();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.connected(ws, req));
    this.timer = setInterval(() => this.sweep(), 250);
    this.timer.unref();
  }
  upgrade(req, socket, head) {
    const tenant = /^\/extension\/(t_[A-Za-z0-9_-]{22})$/.exec(req.url || '')?.[1];
    if (!tenant || !this.store.tenant(tenant) || this.sockets.size >= 128 ||
      !/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(req.headers.origin || '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
  }
  connected(ws, req) {
    this.sockets.add(ws);
    const session = { ws, origin: req.headers.origin, tenant_id: req.url.split('/')[2],
      connection_id: randomUUID(), lastSeen: this.now(), lastPing: this.now(), authenticated: false,
      device: null, challenge: null, processing: Promise.resolve(), queued: 0, workspaces: new Set(), usedTargets: new Set() };
    const timeout = setTimeout(() => { if (!session.authenticated) ws.close(1008, 'AUTH_TIMEOUT'); }, 5000);
    ws.on('message', raw => {
      if ((!session.authenticated && raw.length > 8192) || ++session.queued > 32) { ws.close(1008, 'MESSAGE_LIMIT'); return; }
      session.processing = session.processing.then(async () => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { throw new Fault('INVALID_MESSAGE'); }
        requireValue(message && typeof message === 'object' && !Array.isArray(message), 'INVALID_MESSAGE');
        await this.message(session, message);
      }).catch(error => {
        const code = failureCode(error);
        audit('ws_failure', { device_id: session.device?.id, code });
        this.send(session, { type: 'error', code });
        if (['WORKSPACE_INACTIVE','WORKSPACE_PAUSED','TARGET_STALE'].includes(code)) return;
        this.disconnected(session, code); ws.close(1008, code);
      }).finally(() => { session.queued--; });
    });
    ws.on('close', () => { clearTimeout(timeout); this.sockets.delete(ws); this.disconnected(session); });
    ws.on('error', () => { audit('ws_failure', { code: 'CONNECTION_ERROR' }); this.disconnected(session); ws.terminate(); });
  }
  send(session, message) {
    if (session.ws.readyState !== 1) return false;
    session.ws.send(JSON.stringify({ ...message, tenant_id: session.tenant_id })); return true;
  }
  current(session) {
    return session.authenticated && this.connections.get(session.device.id) === session &&
      this.store.linked(session.client_id, session.device.id, session.tenant_id) &&
      this.store.client(session.client_id)?.credential_hash === session.credential_hash;
  }
  async message(session, m) {
    requireValue(m.tenant_id === session.tenant_id, 'NOT_AUTHORIZED', 403);
    if (!session.authenticated) {
      if (m.type === 'hello' && !session.challenge) {
        requireValue(m.version === VERSION, 'UPGRADE_REQUIRED');
        requireValue(m.browser_info === undefined || validBrowserInfo(m.browser_info), 'INVALID_MESSAGE');
        session.browser_info = m.browser_info || null;
        const device = this.store.deviceByKey(m.key_id, session.tenant_id);
        const clients = device && this.store.clientsForDevice(device.id, session.tenant_id);
        requireValue(device && device.extension_origin === session.origin && clients.length === 1, 'NOT_AUTHORIZED', 403);
        session.device = device; session.client_id = clients[0].id;
        session.credential_hash = this.store.client(session.client_id).credential_hash;
        session.challenge = { origin: this.config.origin, tenant_id: session.tenant_id, epoch: this.epoch,
          connection_id: session.connection_id, nonce: token(), key_id: device.key_id };
        this.send(session, { type: 'challenge', ...session.challenge }); return;
      }
      requireValue(m.type === 'proof' && session.challenge, 'NOT_AUTHORIZED', 403);
      const challenge = session.challenge; session.challenge = null;
      let verified = false;
      try { verified = await verify(JSON.parse(session.device.public_key), authPayload(challenge), m.signature); }
      catch { throw new Fault('NOT_AUTHORIZED', 403); }
      requireValue(verified && this.store.linked(session.client_id, session.device.id, session.tenant_id) &&
        this.store.client(session.client_id)?.credential_hash === session.credential_hash && session.ws.readyState === 1,
        'NOT_AUTHORIZED', 403);
      const old = this.connections.get(session.device.id);
      if (old) { this.disconnected(old, 'REPLACED'); old.ws.close(1000, 'REPLACED'); }
      session.authenticated = true; session.lastSeen = this.now(); this.connections.set(session.device.id, session);
      this.send(session, { type: 'authenticated', device_id: session.device.id, client_id: session.client_id,
        client_label: this.store.client(session.client_id).label, epoch: this.epoch,
        connection_id: session.connection_id, service_started_at: this.startedAt,
        protected_origins: this.config.protectedOrigins });
      return;
    }
    requireValue(this.current(session), 'NOT_AUTHORIZED', 403);
    session.lastSeen = this.now();
    if (m.type === 'pong') return;
    if (m.type === 'session.status') {
      requireValue(validWorkspaceEndReason(m.end_reason) &&
        (m.previous_service_epoch === null || UUID.test(m.previous_service_epoch || '')), 'INVALID_MESSAGE');
      session.last_session_end = { reason: m.end_reason, reported_at: this.now(),
        previous_service_epoch: m.previous_service_epoch, source: 'extension_reported' };
      return;
    }
    if (m.type === 'workspace.sync') { await this.syncWorkspace(session, m); return; }
    if (m.type === 'command.ready') {
      const call = this.calls.get(m.request_id);
      if (!call) return;
      this.checkCallBinding(session, m, call);
      if (call.phase !== 'waiting') return;
      if (this.now() >= call.deadline) { call.cancel('COMMAND_EXPIRED'); return; }
      try { this.checkAuthority(call.workspace, call.target, call.operation, call.credential_hash); }
      catch (error) { call.cancel(failureCode(error)); return; }
      call.execute(); return;
    }
    if (m.type === 'result') {
      const call = this.calls.get(m.request_id);
      if (!call) { audit('result_discarded', { code: 'TARGET_STALE' }); return; }
      this.checkCallBinding(session, m, call);
      try { this.checkAuthority(call.workspace, call.target, m.error ? 'request_handoff' : call.operation, call.credential_hash); }
      catch (error) { call.cancel(failureCode(error)); return; }
      if (m.error) {
        requireValue(m.error && typeof m.error === 'object', 'INVALID_RESULT');
        const code = RESULT_ERRORS.has(m.error.code) ? m.error.code : 'OPERATION_FAILED';
        call.reject(Object.assign(new Fault(code), waitErrorDetails(m.error), inspectionErrorDetails(m.error)));
        return;
      }
      requireValue(call.phase === 'executing', 'ACTION_NOT_READY', 403);
      requireValue(Object.hasOwn(m, 'result') && Buffer.byteLength(JSON.stringify(m.result)) <= 4 * 1024 * 1024, 'INVALID_RESULT');
      if (call.operation === 'create_workspace_tab') {
        const id = m.result?.target_id, created = this.targets.get(id);
        requireValue(UUID.test(id || '') && created && created.workspace === call.workspace &&
          created.activation_id === call.activation_id && !call.initialTargets.has(id), 'INVALID_RESULT');
        // Receipts cannot invent a grant or change metadata published by a signed snapshot.
        call.resolve({ target_id: id, tab_handle: id, workspace_id: call.workspace.workspace_id,
          title: created.title, url: created.url, page_state: created.page_state, capabilities: created.capabilities });
      } else call.resolve(m.result);
      return;
    }
    throw new Fault('INVALID_MESSAGE');
  }
  checkCallBinding(session, m, call) {
    requireValue(call.device_id === session.device.id && call.connection_id === session.connection_id &&
      call.target_id === m.target_id && (m.workspace_id === undefined || m.workspace_id === call.workspace.workspace_id) &&
      (m.activation_id === undefined || m.activation_id === call.activation_id), 'NOT_AUTHORIZED', 403);
  }
  async syncWorkspace(session, m) {
    requireValue(UUID.test(m.workspace_id || '') && UUID.test(m.activation_id || '') &&
      m.client_id === session.client_id && validInt(m.group_id) && validInt(m.window_id) &&
      STATES.has(m.state) && Number.isSafeInteger(m.revision) && m.revision > 0 &&
      Number.isSafeInteger(m.lease_ms) && m.lease_ms > 0 && m.lease_ms <= WORKSPACE_LEASE_MS &&
      Array.isArray(m.tabs) && m.tabs.length <= WORKSPACE_TAB_LIMIT, 'INVALID_WORKSPACE');
    requireValue(m.end_reason === undefined ||
      (m.state !== 'active' && validWorkspaceEndReason(m.end_reason)), 'INVALID_WORKSPACE');
    requireValue(m.state === 'active' || m.tabs.length === 0, 'INVALID_WORKSPACE');
    const seenTargets = new Set(), seenTabs = new Set();
    for (const tab of m.tabs) {
      requireValue(tab && UUID.test(tab.target_id || '') && validInt(tab.tab_id) &&
        typeof tab.title === 'string' && [...tab.title].length <= 160 &&
        typeof tab.url === 'string' && tab.url.length <= 2048 && PAGE_STATES.has(tab.page_state) &&
        Array.isArray(tab.capabilities) && tab.capabilities.every(op => OPERATIONS.includes(op)) &&
        new Set(tab.capabilities).size === tab.capabilities.length &&
        !seenTargets.has(tab.target_id) && !seenTabs.has(tab.tab_id), 'INVALID_WORKSPACE');
      seenTargets.add(tab.target_id); seenTabs.add(tab.tab_id);
      let ordinary = false;
      try { navigationUrl(tab.url, this.config.protectedOrigins); ordinary = true; }
      catch {
        // Privileged documents can be organization-only navigation starting points, never DOM authority.
        let url;
        try { url = new URL(tab.url); } catch { throw new Fault('INVALID_WORKSPACE'); }
        requireValue(!this.config.protectedOrigins.includes(url.origin), 'NOT_AUTHORIZED', 403);
      }
      requireValue((ordinary || ['navigation_only','unavailable'].includes(tab.page_state)) &&
        (!['navigation_only','unavailable'].includes(tab.page_state) || tab.capabilities.every(op => op === 'navigate')),
        'INVALID_WORKSPACE');
    }
    let verified = false;
    try { verified = await verify(JSON.parse(session.device.public_key), workspacePayload({
      ...m, origin: this.config.origin, tenant_id: session.tenant_id, epoch: this.epoch, connection_id: session.connection_id,
    }), m.signature); } catch { throw new Fault('NOT_AUTHORIZED', 403); }
    requireValue(verified && this.current(session), 'NOT_AUTHORIZED', 403);
    let workspace = this.workspaces.get(m.workspace_id);
    if (workspace) {
      requireValue(workspace.device_id === session.device.id &&
        workspace.client_id === session.client_id, 'NOT_AUTHORIZED', 403);
      if (workspace.connection_id !== session.connection_id) {
        requireValue(workspace.state === 'inactive' && m.state === 'inactive' &&
          m.tabs.length === 0 && workspace.activation_id !== m.activation_id, 'WORKSPACE_INACTIVE');
      }
      requireValue(m.revision > workspace.revision, 'TARGET_STALE');
      this.expire(workspace);
      requireValue(!workspace.retiredActivations.has(m.activation_id), 'WORKSPACE_INACTIVE');
      if (workspace.activation_id === m.activation_id) {
        requireValue(!(m.state === 'active' && workspace.state !== 'active'), 'WORKSPACE_INACTIVE');
        requireValue(workspace.group_id === m.group_id && workspace.window_id === m.window_id, 'INVALID_WORKSPACE');
      } else requireValue(workspace.retiredActivations.size < 128, 'WORKSPACE_LIMIT');
    } else {
      requireValue(session.workspaces.size < 8 && this.workspaces.size < 1024, 'WORKSPACE_LIMIT');
    }
    for (const id of session.workspaces) {
      const other = this.workspaces.get(id);
      requireValue(!other || other === workspace || other.window_id !== m.window_id || other.state === 'inactive',
        'INVALID_WORKSPACE');
      for (const tab of m.tabs) {
        requireValue(!other || other === workspace || ![...other.tabs.values()].some(t => t.tab_id === tab.tab_id),
          'INVALID_WORKSPACE');
      }
    }
    for (const tab of m.tabs) {
      const old = this.targets.get(tab.target_id);
      requireValue((old || !session.usedTargets.has(tab.target_id)) && !this.tombstones.has(tab.target_id) &&
        (!old || old.workspace === workspace && old.activation_id === m.activation_id && old.tab_id === tab.tab_id),
        'TARGET_STALE');
      if (workspace?.activation_id === m.activation_id) {
        const oldTab = [...workspace.tabs.values()].find(t => t.tab_id === tab.tab_id);
        requireValue(!oldTab || oldTab.target_id === tab.target_id, 'TARGET_STALE');
      }
    }
    requireValue(session.usedTargets.size + m.tabs.filter(t => !session.usedTargets.has(t.target_id)).length <= 4096,
      'WORKSPACE_LIMIT');
    if (!workspace) {
      workspace = { workspace_id: m.workspace_id, client_id: session.client_id, device_id: session.device.id,
        tenant_id: session.tenant_id, connection_id: session.connection_id, tabs: new Map(),
        retiredActivations: new Set(), running: 0, creating: 0, slots: new Set(), leaseTimer: null };
      this.workspaces.set(m.workspace_id, workspace); session.workspaces.add(m.workspace_id);
    }
    if (workspace.activation_id && workspace.activation_id !== m.activation_id) {
      this.invalidate(workspace, 'WORKSPACE_INACTIVE');
      workspace.retiredActivations.add(workspace.activation_id);
    }
    Object.assign(workspace, { activation_id: m.activation_id, group_id: m.group_id, window_id: m.window_id,
      revision: m.revision, state: m.state, credential_hash: session.credential_hash, expires_at: this.now() + m.lease_ms });
    workspace.connection_id = session.connection_id;
    session.workspaces.add(m.workspace_id);
    this.recordEnd(workspace, m.state === 'active' ? null : m.end_reason ||
      (m.state === 'paused' ? 'USER_PAUSED' : 'USER_ENDED'));
    if (m.state !== 'active') this.invalidate(workspace, m.state === 'paused' ? 'WORKSPACE_PAUSED' : 'WORKSPACE_INACTIVE');
    else {
      for (const id of [...workspace.tabs.keys()]) if (!seenTargets.has(id)) this.removeTarget(workspace, id, 'TAB_NOT_IN_WORKSPACE');
      for (const tab of m.tabs) {
        let target = workspace.tabs.get(tab.target_id);
        if (!target) {
          target = { ...tab, workspace, activation_id: m.activation_id, tail: Promise.resolve(), queued: 0,
            execution_state: 'idle', queuedControllers: new Set() };
          workspace.tabs.set(tab.target_id, target); this.targets.set(tab.target_id, target);
          session.usedTargets.add(tab.target_id);
        } else Object.assign(target, tab);
        for (const call of [...this.calls.values()]) {
          if (call.target === target && !['request_handoff','navigate'].includes(call.operation) &&
            !target.capabilities.includes(call.operation)) call.cancel('DOCUMENT_NOT_CONTROLLABLE');
        }
      }
    }
    clearTimeout(workspace.leaseTimer);
    if (m.state === 'active') {
      workspace.leaseTimer = setTimeout(() => this.expire(workspace), m.lease_ms);
      workspace.leaseTimer.unref();
    }
    this.send(session, { type: 'workspace.active', workspace_id: m.workspace_id,
      activation_id: m.activation_id, revision: m.revision });
    for (const waiter of [...this.waiters]) waiter.check();
  }
  expire(workspace) {
    if (workspace.state === 'active' && this.now() >= workspace.expires_at) {
      workspace.state = 'inactive'; this.recordEnd(workspace, 'LEASE_EXPIRED');
      this.invalidate(workspace, 'WORKSPACE_INACTIVE');
    }
  }
  recordEnd(workspace, reason) {
    if (reason === null) {
      workspace.end_reason = null; workspace.ended_at = null; workspace.retained_until = null;
      return;
    }
    if (workspace.end_reason !== reason || !workspace.ended_at) {
      workspace.end_reason = reason; workspace.ended_at = this.now();
    }
    workspace.retained_until = workspace.state === 'inactive' ? this.now() + 600000 : null;
  }
  tombstone(target, reason) {
    this.tombstones.set(target.target_id, { client_id: target.workspace.client_id, tenant_id: target.workspace.tenant_id,
      reason, expires: this.now() + 600_000 });
    while (this.tombstones.size > 4096) this.tombstones.delete(this.tombstones.keys().next().value);
  }
  removeTarget(workspace, id, reason) {
    const target = workspace.tabs.get(id); if (!target) return;
    this.tombstone(target, reason); this.targets.delete(id); workspace.tabs.delete(id);
    for (const call of [...this.calls.values()]) if (call.target === target) call.cancel(reason);
    for (const controller of target.queuedControllers) controller.abort(new Fault(reason));
  }
  invalidate(workspace, reason) {
    clearTimeout(workspace.leaseTimer);
    for (const id of [...workspace.tabs.keys()]) this.removeTarget(workspace, id, reason);
    for (const call of [...this.calls.values()]) if (call.workspace === workspace) call.cancel(reason);
    for (const slot of [...workspace.slots]) slot.cancel(new Fault(reason));
  }
  disconnected(session, code = 'BROWSER_OFFLINE') {
    if (!session.device) return;
    if (this.connections.get(session.device.id) === session) this.connections.delete(session.device.id);
    for (const id of session.workspaces) {
      const workspace = this.workspaces.get(id);
      if (!workspace || workspace.connection_id !== session.connection_id) continue;
      workspace.state = 'inactive';
      let reason = 'CONNECTION_LOST';
      if (code === 'REPLACED') reason = 'CONNECTION_REPLACED';
      else if (code === 'REVOKED') reason = 'CLIENT_REVOKED';
      this.recordEnd(workspace, reason);
      this.invalidate(workspace, code);
    }
    session.workspaces.clear(); session.authenticated = false;
    for (const waiter of [...this.waiters]) waiter.check();
  }
  checkAuthority(workspace, target, operation, credentialHash = workspace.credential_hash) {
    this.expire(workspace);
    requireValue(this.workspaces.get(workspace.workspace_id) === workspace &&
      this.store.linked(workspace.client_id, workspace.device_id, workspace.tenant_id) &&
      this.store.client(workspace.client_id)?.credential_hash === credentialHash, 'NOT_AUTHORIZED', 403);
    requireValue(workspace.state !== 'paused', 'WORKSPACE_PAUSED');
    requireValue(workspace.state === 'active' && this.now() < workspace.expires_at, 'WORKSPACE_INACTIVE');
    const session = this.connections.get(workspace.device_id);
    requireValue(session && this.current(session) && session.connection_id === workspace.connection_id, 'BROWSER_OFFLINE');
    if (target) {
      requireValue(this.targets.get(target.target_id) === target && target.activation_id === workspace.activation_id, 'TAB_NOT_IN_WORKSPACE');
      requireValue(operation === 'request_handoff' || target.capabilities.includes(operation),
        ['navigation_only','unavailable'].includes(target.page_state) ? 'DOCUMENT_NOT_CONTROLLABLE' : 'CAPABILITY_UNAVAILABLE');
    }
    return session;
  }
  ownedWorkspace(clientId, workspaceId, tenant) {
    const workspace = this.workspaces.get(workspaceId);
    requireValue(workspace && workspace.client_id === clientId && workspace.tenant_id === tenant &&
      this.store.linked(clientId, workspace.device_id, tenant), 'NOT_AUTHORIZED', 403);
    this.expire(workspace); return workspace;
  }
  workspaceMetadata(workspace) {
    this.expire(workspace);
    return { workspace_id: workspace.workspace_id, activation_id: workspace.activation_id, state: workspace.state,
      tab_count: workspace.state === 'active' ? workspace.tabs.size : 0,
      window_id: workspace.window_id, group_id: workspace.group_id, revision: workspace.revision,
      end_reason: workspace.end_reason || null, ended_at: workspace.ended_at ?? null,
      service_epoch: this.epoch, connection_id: workspace.connection_id };
  }
  listWorkspaces(clientId, tenant) {
    requireValue(this.store.client(clientId, tenant), 'NOT_AUTHORIZED', 403);
    return this.store.devicesForClient(clientId, tenant).map(device => {
      const session = this.connections.get(device.id), connected = Boolean(session && this.current(session));
      return { device_id: device.id, label: device.label, browser_info: connected ? session.browser_info : null,
        connection_state: connected ? 'connected' : 'offline',
        service_epoch: this.epoch, service_started_at: this.startedAt,
        connection_id: connected ? session.connection_id : null,
        last_session_end: connected ? session.last_session_end || null : null,
        workspaces: [...this.workspaces.values()].filter(w => w.device_id === device.id && w.client_id === clientId)
          .map(w => this.workspaceMetadata(w)) };
    });
  }
  listTabs(clientId, workspaceId, tenant) {
    const workspace = this.ownedWorkspace(clientId, workspaceId, tenant);
    if (workspace.state !== 'active') return [];
    return [...workspace.tabs.values()].map(t => ({ target_id: t.target_id, tab_handle: t.target_id,
      title: t.title, url: t.url, capabilities: [...t.capabilities], page_state: t.page_state, execution_state: t.execution_state }));
  }
  waitWorkspace(clientId, deviceId, description, timeoutMs = 300_000, signal, tenant) {
    requireValue(this.store.linked(clientId, deviceId, tenant), 'NOT_AUTHORIZED', 403);
    requireValue(validDescription(description) && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 &&
      timeoutMs <= HUMAN_WAIT_MS, 'INVALID_ARGUMENTS');
    requireValue(this.waiters.size < 256, 'QUEUE_FULL', 429);
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort); this.waiters.delete(waiter);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(signal?.reason instanceof Fault ? signal.reason : new Fault('COMMAND_CANCELLED'));
      const timer = setTimeout(() => finish(new Fault('COMMAND_EXPIRED')), timeoutMs);
      const credentialHash = this.store.client(clientId, tenant).credential_hash;
      const waiter = { check: () => {
        if (!this.store.linked(clientId, deviceId, tenant) || this.store.client(clientId)?.credential_hash !== credentialHash) {
          finish(new Fault('NOT_AUTHORIZED', 403)); return;
        }
        const workspace = [...this.workspaces.values()].find(w => {
          this.expire(w); return w.client_id === clientId && w.device_id === deviceId && w.state === 'active';
        });
        if (workspace) finish(null, { device_id: deviceId, ...this.workspaceMetadata(workspace) });
      }, cancel: abort };
      this.waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else waiter.check();
    });
  }
  async slot(workspace, deadline, signal) {
    if (workspace.running < WORKSPACE_CONCURRENCY) { workspace.running++; return; }
    requireValue(workspace.slots.size < 64, 'QUEUE_FULL', 429);
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer); workspace.slots.delete(slot);
        signal?.removeEventListener('abort', abort); error ? reject(error) : resolve();
      };
      const abort = () => finish(signal?.reason instanceof Fault ? signal.reason : new Fault('COMMAND_CANCELLED'));
      const timer = setTimeout(() => finish(new Fault('COMMAND_EXPIRED')), Math.max(1, deadline - this.now()));
      const slot = { cancel: finish, release: () => { workspace.running++; finish(); } };
      workspace.slots.add(slot); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  releaseSlot(workspace) {
    workspace.running--; const first = workspace.slots.values().next().value; first?.release();
  }
  async operate(clientId, targetId, operation, args, signal, tenant,
    description, waitMs = 300_000) {
    requireValue(validTargetId(targetId) && (OPERATIONS.includes(operation) || operation === 'request_handoff') &&
      validOperationArgs(operation, args) && validDescription(description), 'INVALID_ARGUMENTS');
    requireValue(Number.isSafeInteger(waitMs) && waitMs >= 1000 && waitMs <= HUMAN_WAIT_MS, 'INVALID_ARGUMENTS');
    const target = this.targets.get(targetId);
    if (!target || target.workspace.client_id !== clientId || target.workspace.tenant_id !== tenant) {
      const tombstone = this.tombstones.get(targetId);
      requireValue(!tombstone || tombstone.client_id !== clientId || tombstone.tenant_id !== tenant ||
        tombstone.expires <= this.now(), tombstone?.reason || 'TAB_NOT_IN_WORKSPACE');
      throw new Fault('NOT_AUTHORIZED', 403);
    }
    const workspace = target.workspace;
    this.checkAuthority(workspace, target, operation);
    if (operation === 'navigate') {
      try { navigationUrl(args.url, this.config.protectedOrigins); } catch { throw new Fault('HANDOFF_REQUIRED'); }
    }
    requireValue(target.queued < 32, 'QUEUE_FULL', 429);
    requireValue(this.calls.size < 1024, 'QUEUE_FULL', 429);
    const deadline = this.now() + (operation === 'request_handoff' ? waitMs : EXECUTION_MS);
    const credentialHash = this.store.client(clientId).credential_hash;
    const queued = new AbortController();
    target.queuedControllers.add(queued);
    signal = signal ? AbortSignal.any([signal, queued.signal]) : queued.signal;
    const previous = target.tail; let release;
    const mine = new Promise(resolve => { release = resolve; });
    // A cancelled tail must not let its successor overtake an earlier running call.
    target.tail = previous.then(() => mine); target.queued++;
    let hasSlot = false;
    try {
      await this.waitTail(previous, deadline, signal);
      this.checkAuthority(workspace, target, operation, credentialHash);
      if (operation !== 'request_handoff') { await this.slot(workspace, deadline, signal); hasSlot = true; }
      this.checkAuthority(workspace, target, operation, credentialHash);
      requireValue(!signal?.aborted, 'COMMAND_CANCELLED');
      return await this.dispatch(workspace, target, operation, args, description, deadline, signal, credentialHash);
    } finally {
      target.queued--; target.queuedControllers.delete(queued); release(); if (hasSlot) this.releaseSlot(workspace);
    }
  }
  waitTail(previous, deadline, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(signal?.reason instanceof Fault ? signal.reason : new Fault('COMMAND_CANCELLED'));
      const timer = setTimeout(() => finish(new Fault('COMMAND_EXPIRED')), Math.max(1, deadline - this.now()));
      signal?.addEventListener('abort', abort, { once: true });
      previous.then(() => finish(), finish); if (signal?.aborted) abort();
    });
  }
  async createTab(clientId, workspaceId, args, description, signal, tenant) {
    requireValue(UUID.test(workspaceId || '') && validDescription(description) && args && typeof args === 'object' &&
      Object.keys(args).every(k => k === 'url') && (args.url === undefined || typeof args.url === 'string'), 'INVALID_ARGUMENTS');
    if (args.url !== undefined) {
      try { navigationUrl(args.url, this.config.protectedOrigins); } catch { throw new Fault('HANDOFF_REQUIRED'); }
    }
    const workspace = this.ownedWorkspace(clientId, workspaceId, tenant);
    this.checkAuthority(workspace, null, 'create_workspace_tab');
    requireValue(workspace.tabs.size + workspace.creating < WORKSPACE_TAB_LIMIT, 'TAB_LIMIT_REACHED');
    const credentialHash = workspace.credential_hash, activation = workspace.activation_id;
    const deadline = this.now() + EXECUTION_MS; workspace.creating++;
    let hasSlot = false;
    try {
      await this.slot(workspace, deadline, signal); hasSlot = true;
      this.checkAuthority(workspace, null, 'create_workspace_tab', credentialHash);
      requireValue(workspace.activation_id === activation, 'WORKSPACE_INACTIVE');
      requireValue(!signal?.aborted, 'COMMAND_CANCELLED');
      return await this.dispatch(workspace, null, 'create_workspace_tab', args, description, deadline, signal, credentialHash);
    } finally { workspace.creating--; if (hasSlot) this.releaseSlot(workspace); }
  }
  dispatch(workspace, target, operation, args, description, deadline, signal, credentialHash) {
    const session = this.checkAuthority(workspace, target, operation, credentialHash);
    requireValue(this.calls.size < 1024 && this.now() < deadline, 'COMMAND_EXPIRED');
    const requestId = randomUUID(), targetId = target?.target_id || workspace.workspace_id;
    const activation = workspace.activation_id;
    return new Promise((resolve, reject) => {
      let finished = false, timer;
      const finish = (error, value) => {
        if (finished) return; finished = true; clearTimeout(timer);
        signal?.removeEventListener('abort', abort); this.calls.delete(requestId);
        if (target) target.execution_state = 'idle';
        error ? reject(error) : resolve(value);
      };
      const call = {
        workspace, target, target_id: targetId, activation_id: activation, operation, client_id: workspace.client_id,
        device_id: workspace.device_id, connection_id: workspace.connection_id, credential_hash: credentialHash,
        initialTargets: new Set(workspace.tabs.keys()), phase: 'waiting', deadline,
        resolve: value => finish(null, value), reject: error => finish(error),
        cancel: code => {
          this.send(session, { type: 'command.cancel', request_id: requestId, target_id: targetId,
            workspace_id: workspace.workspace_id, activation_id: activation, reason: code });
          finish(new Fault(call.phase === 'executing' && operation !== 'request_handoff' ? 'OUTCOME_UNKNOWN' : code));
        },
        execute: () => {
          if (call.phase !== 'waiting') return;
          call.phase = 'executing'; clearTimeout(timer);
          const human = operation === 'request_handoff';
          if (target) target.execution_state = human ? 'waiting_for_human' : 'running';
          const executionDeadline = human ? deadline : this.now() + EXECUTION_MS;
          timer = setTimeout(() => call.cancel(human ? 'COMMAND_EXPIRED' : 'OUTCOME_UNKNOWN'),
            Math.max(1, executionDeadline - this.now()));
          if (!this.send(session, { type: 'command.execute', request_id: requestId, target_id: targetId,
            workspace_id: workspace.workspace_id, activation_id: activation, epoch: this.epoch,
            connection_id: workspace.connection_id, client_id: workspace.client_id,
            expires_at: executionDeadline, execution_timeout_ms: human ? Math.max(1, deadline - this.now()) : EXECUTION_MS })) {
            call.cancel('BROWSER_OFFLINE');
          }
        },
      };
      this.calls.set(requestId, call);
      if (target) target.execution_state = operation === 'request_handoff' ? 'waiting_for_human' : 'running';
      timer = setTimeout(() => call.cancel('COMMAND_EXPIRED'), Math.max(1, deadline - this.now()));
      const abort = () => call.cancel(signal?.reason instanceof Fault ? signal.reason.code : 'COMMAND_CANCELLED');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (!this.send(session, { type: 'command', request_id: requestId, target_id: targetId,
        workspace_id: workspace.workspace_id, activation_id: activation, client_id: workspace.client_id,
        operation, args, epoch: this.epoch, connection_id: workspace.connection_id, description,
        expires_at: deadline, wait_timeout_ms: Math.max(1, deadline - this.now()) })) call.cancel('BROWSER_OFFLINE');
    });
  }
  reconcile() {
    for (const session of [...this.connections.values()]) {
      if (!this.current(session)) { this.disconnected(session, 'REVOKED'); session.ws.close(1008, 'REVOKED'); }
    }
    for (const workspace of this.workspaces.values()) this.expire(workspace);
    for (const waiter of [...this.waiters]) waiter.check();
  }
  sweep() {
    this.reconcile();
    for (const [id, workspace] of this.workspaces) {
      if (workspace.state === 'inactive' && Number.isFinite(workspace.retained_until) &&
          workspace.retained_until <= this.now()) {
        this.workspaces.delete(id);
        this.connections.get(workspace.device_id)?.workspaces.delete(id);
      }
    }
    for (const [id, row] of this.tombstones) if (row.expires <= this.now()) this.tombstones.delete(id);
    for (const session of [...this.connections.values()]) {
      if (this.now() - session.lastSeen >= LIVENESS_MS) { this.disconnected(session); session.ws.terminate(); }
      else if (this.now() - session.lastPing >= HEARTBEAT_MS) {
        session.lastPing = this.now(); this.send(session, { type: 'ping' });
      }
    }
  }
  close() {
    clearInterval(this.timer);
    for (const session of [...this.connections.values()]) this.disconnected(session, 'SERVICE_STOPPED');
    for (const waiter of [...this.waiters]) waiter.cancel();
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
  }
}
