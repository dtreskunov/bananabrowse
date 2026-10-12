import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  VERSION, POLICY_ID, OPERATIONS, HEARTBEAT_MS, LIVENESS_MS, HUMAN_WAIT_MS, EXECUTION_MS,
  authPayload, grantPayload, verify, navigationUrl, validOperationArgs, validTargetId, waitErrorDetails,
  validDescription, inspectionErrorDetails,
} from '../shared/protocol.js';
import { token } from './store.js';
import { Fault, requireValue, failureCode, audit } from './errors.js';

const ID = /^[a-zA-Z0-9_-]{8,128}$/;
const END_REASONS = new Set(['OWNER_PAUSED', 'HANDOFF', 'REVOKED', 'TARGET_CLOSED', 'CAPABILITY_UNAVAILABLE']);

export class BridgeServer {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.epoch = randomUUID();
    this.connections = new Map();
    this.requests = new Map();
    this.requestCredentials = new Map();
    this.shareWaiters = new Map();
    this.denials = new Map();
    this.grants = new Map();
    this.calls = new Map();
    this.sockets = new Set();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => this.connected(ws, req));
    this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.timer.unref();
  }
  upgrade(req, socket, head) {
    const tenant = /^\/extension\/(t_[A-Za-z0-9_-]{22})$/.exec(req.url || '')?.[1];
    if (!tenant || !this.store.tenant(tenant) || this.sockets.size >= 128 ||
        !/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(req.headers.origin || '')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      audit('ws_rejected', { code: 'NOT_AUTHORIZED' });
      return;
    }
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit('connection', ws, req));
  }
  connected(ws, req) {
    this.sockets.add(ws);
    const session = {
      ws, origin: req.headers.origin, tenant_id: req.url.split('/')[2], connection_id: randomUUID(),
      lastSeen: Date.now(), connectedAt: Date.now(), authenticated: false, device: null, challenge: null,
      processing: Promise.resolve(), queued: 0,
    };
    const timeout = setTimeout(() => {
      if (!session.authenticated) ws.close(1008, 'AUTH_TIMEOUT');
    }, 5000);
    ws.on('message', raw => {
      if ((!session.authenticated && raw.length > 8192) || ++session.queued > 32) {
        ws.close(1008, 'MESSAGE_LIMIT');
        return;
      }
      session.processing = session.processing.then(async () => {
        let message;
        try { message = JSON.parse(raw.toString()); }
        catch { throw new Fault('INVALID_MESSAGE'); }
        requireValue(message && typeof message === 'object' && !Array.isArray(message), 'INVALID_MESSAGE');
        await this.message(session, message);
      }).catch(error => {
        audit('ws_failure', { device_id: session.device?.id, code: failureCode(error) });
        this.send(session, { type: 'error', code: failureCode(error) });
        this.disconnected(session, failureCode(error));
        ws.close(1008, 'PROTOCOL_FAILURE');
      }).finally(() => { session.queued--; });
    });
    ws.on('close', closeCode => {
      clearTimeout(timeout);
      this.sockets.delete(ws);
      this.disconnected(session, 'SOCKET_CLOSED', closeCode);
      audit('socket_closed', { device_id: session.device?.id, tenant_id: session.tenant_id,
        close_code: closeCode, duration_ms: Date.now() - session.connectedAt });
    });
    ws.on('error', () => {
      audit('ws_failure', { device_id: session.device?.id, code: 'CONNECTION_ERROR' });
      this.disconnected(session, 'CONNECTION_ERROR');
      ws.terminate();
    });
  }
  send(session, message) {
    if (session.ws.readyState !== 1) return false;
    session.ws.send(JSON.stringify({ ...message, tenant_id: session.tenant_id }));
    return true;
  }
  current(session) {
    return session.authenticated && this.connections.get(session.device.id) === session &&
      Boolean(this.store.device(session.device.id, session.tenant_id));
  }
  refreshLiveness(session) {
    session.lastSeen = Date.now();
    clearTimeout(session.liveness);
    session.liveness = setTimeout(() => {
      this.disconnected(session, 'HEARTBEAT_TIMEOUT');
      session.ws.terminate();
    }, LIVENESS_MS);
    session.liveness.unref();
  }
  async message(session, m) {
    requireValue(m.tenant_id === session.tenant_id, 'NOT_AUTHORIZED', 403);
    if (!session.authenticated) {
      if (m.type === 'hello' && !session.challenge) {
        requireValue(m.version === VERSION, 'VERSION_UNSUPPORTED');
        const device = this.store.deviceByKey(m.key_id, session.tenant_id);
        requireValue(device && device.extension_origin === session.origin, 'NOT_AUTHORIZED', 403);
        session.device = device;
        session.challenge = {
          origin: this.config.origin, tenant_id: session.tenant_id, epoch: this.epoch, connection_id: session.connection_id,
          nonce: token(), key_id: device.key_id,
        };
        this.send(session, { type: 'challenge', ...session.challenge });
        return;
      }
      requireValue(m.type === 'proof' && session.challenge, 'NOT_AUTHORIZED', 403);
      const challenge = session.challenge;
      session.challenge = null;
      requireValue(await verify(JSON.parse(session.device.public_key), authPayload(challenge), m.signature),
        'NOT_AUTHORIZED', 403);
      requireValue(this.store.device(session.device.id, session.tenant_id) && session.ws.readyState === 1,
        'NOT_AUTHORIZED', 403);
      const old = this.connections.get(session.device.id);
      if (old) {
        this.disconnected(old, 'REPLACED');
        old.ws.close(1000, 'REPLACED');
      }
      session.authenticated = true;
      this.refreshLiveness(session);
      this.connections.set(session.device.id, session);
      this.send(session, {
        type: 'authenticated', device_id: session.device.id, owner_id: session.device.owner_id,
        owner_label: this.store.owner(session.device.owner_id).label,
        tenant_label: this.store.tenant(session.tenant_id).label,
        eligible_clients: this.store.clientsForDevice(session.device.id, session.tenant_id),
        epoch: this.epoch, connection_id: session.connection_id,
        protected_origins: this.config.protectedOrigins,
      });
      audit('device_connected', { device_id: session.device.id, tenant_id: session.tenant_id });
      return;
    }
    requireValue(this.current(session), 'NOT_AUTHORIZED', 403);
    this.refreshLiveness(session);
    if (m.type === 'pong') return;
    if (m.type === 'access.request') {
      this.requestAccess(m.client_id, session.device.id, true, session.tenant_id,
        'Share this selected browser tab with your assistant', HUMAN_WAIT_MS);
      return;
    }
    if (m.type === 'approval.deny') {
      const request = this.requests.get(m.request_id);
      requireValue(request && request.device_id === session.device.id &&
        request.connection_id === session.connection_id, 'NOT_AUTHORIZED', 403);
      this.finishRequest(m.request_id, new Fault('ACTION_DECLINED'));
      this.denials.set(`${request.client_id}:${request.device_id}`, Date.now());
      audit('access_denied', { device_id: session.device.id, client_id: request.client_id });
      return;
    }
    if (m.type === 'grant.approve') {
      const r = this.requests.get(m.request_id);
      const existing = this.grants.get(m.target_id);
      requireValue(r && r.device_id === session.device.id && r.expires_at > Date.now() &&
        this.store.client(r.client_id, session.tenant_id)?.credential_hash === this.requestCredentials.get(r.request_id) &&
        r.connection_id === session.connection_id && r.client_id === m.client_id &&
        m.policy_id === POLICY_ID && m.nonce === r.nonce &&
        Number.isSafeInteger(m.tab_id) && m.tab_id >= 0 &&
        Number.isSafeInteger(m.window_id) && m.window_id >= 0 &&
        ID.test(m.target_id) &&
        Array.isArray(m.capabilities) && m.capabilities.length > 0 &&
        new Set(m.capabilities).size === m.capabilities.length &&
        m.capabilities.every(op => OPERATIONS.includes(op)), 'INVALID_GRANT');
      requireValue(!existing || (
        existing.tenant_id === session.tenant_id && existing.client_id === r.client_id &&
        existing.device_id === r.device_id && existing.connection_id === session.connection_id &&
        existing.tab_id === m.tab_id && existing.window_id === m.window_id &&
        existing.capabilities.length === m.capabilities.length &&
        m.capabilities.every(op => existing.capabilities.includes(op))
      ), 'INVALID_GRANT');
      requireValue(await verify(JSON.parse(session.device.public_key), grantPayload({
        ...r, origin: this.config.origin, target_id: m.target_id, tab_id: m.tab_id, window_id: m.window_id, capabilities: m.capabilities,
      }), m.signature), 'NOT_AUTHORIZED', 403);
      requireValue(this.current(session) && this.store.linked(r.client_id, r.device_id),
        'NOT_AUTHORIZED', 403);
      requireValue(this.requests.get(r.request_id) === r && r.expires_at > Date.now() &&
        this.store.client(r.client_id, session.tenant_id)?.credential_hash === this.requestCredentials.get(r.request_id) &&
        this.grants.get(m.target_id) === existing, 'INVALID_GRANT');
      if (!existing) {
        for (const [id, grant] of this.grants) {
          if (grant.device_id === r.device_id && grant.tab_id === m.tab_id) this.endGrant(id, 'REPLACED');
        }
        this.grants.set(m.target_id, {
          tenant_id: session.tenant_id, client_id: r.client_id, device_id: r.device_id, connection_id: r.connection_id,
          target_id: m.target_id, tab_id: m.tab_id, window_id: m.window_id, capabilities: m.capabilities, queued: 0, tail: Promise.resolve(),
        });
      }
      this.send(session, { type: 'grant.active', client_id: r.client_id, target_id: m.target_id, tab_id: m.tab_id, window_id: m.window_id });
      this.finishRequest(r.request_id, null, {
        state: 'active', request_id: r.request_id, target_id: m.target_id, tab_handle: m.target_id,
        tab_id: m.tab_id, window_id: m.window_id, capabilities: m.capabilities,
      });
      audit('grant_activated', { device_id: r.device_id, client_id: r.client_id, target_id: m.target_id });
      return;
    }
    if (m.type === 'command.ready') {
      const call = this.calls.get(m.request_id);
      if (!call) { audit('approval_discarded', { device_id: session.device.id, code: 'COMMAND_EXPIRED' }); return; }
      requireValue(call.target_id === m.target_id && call.device_id === session.device.id &&
        call.connection_id === session.connection_id, 'NOT_AUTHORIZED', 403);
      if (call.phase !== 'waiting') return;
      if (Date.now() >= call.deadline) { call.cancel('COMMAND_EXPIRED'); return; }
      requireValue(this.store.linked(call.client_id, call.device_id, session.tenant_id) &&
        this.grants.has(call.target_id), 'NOT_AUTHORIZED', 403);
      call.execute();
      return;
    }
    if (m.type === 'grant.end') {
      requireValue(typeof m.target_id === 'string' && ID.test(m.target_id), 'INVALID_GRANT');
      requireValue(END_REASONS.has(m.reason), 'INVALID_REASON');
      const grant = this.grants.get(m.target_id);
      if (!grant) {
        audit('grant_end_discarded', { device_id: session.device.id, code: 'TARGET_STALE' });
        return;
      }
      requireValue(grant.device_id === session.device.id &&
        grant.connection_id === session.connection_id, 'NOT_AUTHORIZED', 403);
      this.endGrant(m.target_id, m.reason);
      return;
    }
    if (m.type === 'result') {
      requireValue(typeof m.request_id === 'string' && ID.test(m.request_id) &&
        typeof m.target_id === 'string' && ID.test(m.target_id), 'INVALID_RESULT');
      const call = this.calls.get(m.request_id);
      if (!call) {
        audit('result_discarded', { device_id: session.device.id, code: 'TARGET_STALE' });
        return;
      }
      requireValue(call.device_id === session.device.id &&
        call.connection_id === session.connection_id && call.target_id === m.target_id,
        'INVALID_RESULT');
      const grant = this.grants.get(m.target_id);
      if (!grant || !this.store.linked(grant.client_id, grant.device_id)) {
        call.reject(new Fault('OUTCOME_UNKNOWN'));
        this.endGrant(m.target_id, 'REVOKED');
        audit('result_discarded', { device_id: session.device.id, code: 'REVOKED' });
        return;
      }
      if (m.error) {
        const code = ['HANDOFF_REQUIRED', 'CAPABILITY_UNAVAILABLE', 'TARGET_STALE',
          'NOT_AUTHORIZED', 'INVALID_ARGUMENTS', 'OPERATION_FAILED', 'OUTCOME_UNKNOWN',
          'COMMAND_EXPIRED', 'COMMAND_CANCELLED', 'ACTION_DECLINED', 'INVALID_MESSAGE',
          'ELEMENT_NOT_FOUND', 'INVALID_SELECTOR', 'PAGE_UNAVAILABLE', 'ELEMENT_AMBIGUOUS',
          'ELEMENT_STALE', 'ELEMENT_DISABLED', 'ELEMENT_READONLY', 'ELEMENT_NOT_VISIBLE',
          'ELEMENT_OBSCURED', 'ELEMENT_NOT_EDITABLE', 'OPTION_NOT_FOUND', 'WAIT_TIMEOUT',
          'RESULT_TOO_LARGE', 'SCRIPT_POLICY_BLOCKED', 'SCRIPT_SYNTAX_ERROR', 'SCRIPT_RUNTIME_ERROR',
          'SCRIPT_SERIALIZATION_ERROR', 'SCRIPT_EXECUTION_UNAVAILABLE', 'WORKSPACE_CHANGED'].includes(m.error.code)
          ? m.error.code : 'OPERATION_FAILED';
        call.reject(Object.assign(new Fault(code), waitErrorDetails(m.error), inspectionErrorDetails(m.error)));
        if (code === 'OUTCOME_UNKNOWN') this.endGrant(m.target_id, code);
        else if (code === 'PAGE_UNAVAILABLE') this.endGrant(m.target_id, 'CAPABILITY_UNAVAILABLE');
      } else {
        requireValue(call.phase === 'executing', 'ACTION_NOT_APPROVED', 403);
        requireValue(Object.hasOwn(m, 'result') && Buffer.byteLength(JSON.stringify(m.result)) <= 4 * 1024 * 1024,
          'INVALID_RESULT');
        call.resolve(m.result);
      }
      return;
    }
    throw new Fault('INVALID_MESSAGE');
  }
  disconnected(session, code = 'SOCKET_CLOSED', closeCode) {
    clearTimeout(session.liveness);
    if (!session.device) return;
    if (session.authenticated) {
      audit('device_disconnected', { device_id: session.device.id, tenant_id: session.tenant_id,
        code, close_code: closeCode, duration_ms: Date.now() - session.connectedAt });
    }
    if (this.connections.get(session.device.id) === session) this.connections.delete(session.device.id);
    for (const [id, grant] of this.grants) {
      if (grant.connection_id === session.connection_id) this.endGrant(id, 'BROWSER_OFFLINE');
    }
    for (const [id, request] of this.requests) {
      if (request.connection_id === session.connection_id) this.finishRequest(id, new Fault('BROWSER_OFFLINE'));
    }
    session.authenticated = false;
  }
  endGrant(targetId, reason) {
    const grant = this.grants.get(targetId);
    if (!grant) return;
    this.grants.delete(targetId);
    const connection = this.connections.get(grant.device_id);
    if (connection?.connection_id === grant.connection_id) {
      this.send(connection, { type: 'grant.end', target_id: targetId, reason });
    }
    for (const call of this.calls.values()) {
      if (call.target_id === targetId) {
        call.reject(new Fault(call.phase === 'executing' ? 'OUTCOME_UNKNOWN' : 'NOT_AUTHORIZED'));
      }
    }
    audit('grant_ended', { client_id: grant.client_id, device_id: grant.device_id, target_id: targetId, code: reason });
  }
  requestAccess(clientId, deviceId, ownerInitiated = false, tenant,
    description = 'Please choose a tab to share with your assistant', waitMs = HUMAN_WAIT_MS) {
    const client = this.store.client(clientId, tenant);
    requireValue(client && this.store.linked(clientId, deviceId, client.tenant_id), 'NOT_AUTHORIZED', 403);
    const session = this.connections.get(deviceId);
    requireValue(session && this.current(session), 'BROWSER_OFFLINE', 409);
    requireValue(validDescription(description) &&
      Number.isInteger(waitMs) && waitMs >= 1000 && waitMs <= HUMAN_WAIT_MS, 'INVALID_ARGUMENTS');
    for (const request of this.requests.values()) {
      if (request.client_id === clientId && request.device_id === deviceId && request.expires_at > Date.now()) {
        return { state: 'pending', request_id: request.request_id };
      }
    }
    requireValue(ownerInitiated ||
      Date.now() - (this.denials.get(`${clientId}:${deviceId}`) || 0) >= 30_000,
      'RATE_LIMITED', 429);
    requireValue(this.requests.size < 1000, 'RATE_LIMITED', 429);
    const request = {
      type: 'approval.request', request_id: randomUUID(), client_id: clientId,
      tenant_id: client.tenant_id,
      client_label: this.store.client(clientId).label, device_id: deviceId,
      epoch: this.epoch, connection_id: session.connection_id, nonce: token(),
      policy_id: POLICY_ID, expires_at: Date.now() + waitMs,
      wait_timeout_ms: waitMs,
      description: description.trim(),
      protected_origins: this.config.protectedOrigins,
    };
    this.requests.set(request.request_id, request);
    this.requestCredentials.set(request.request_id, client.credential_hash);
    if (!this.send(session, request)) {
      this.finishRequest(request.request_id, new Fault('BROWSER_OFFLINE'));
      throw new Fault('BROWSER_OFFLINE', 409);
    }
    audit('access_requested', { client_id: clientId, device_id: deviceId, request_id: request.request_id });
    return { state: 'pending', request_id: request.request_id };
  }
  finishRequest(id, error, value) {
    const request = this.requests.get(id);
    this.requests.delete(id);
    this.requestCredentials.delete(id);
    if (error && request) {
      const session = this.connections.get(request.device_id);
      if (session?.connection_id === request.connection_id) {
        this.send(session, { type: 'approval.cancel', request_id: id, reason: error.code });
      }
    }
    for (const waiter of this.shareWaiters.get(id) || []) waiter.finish(error, value);
    this.shareWaiters.delete(id);
  }
  waitAccess(clientId, deviceId, description, waitMs, signal, tenant) {
    if (signal?.aborted) return Promise.reject(new Fault('COMMAND_CANCELLED'));
    const pending = this.requestAccess(clientId, deviceId, false, tenant, description, waitMs);
    return new Promise((resolve, reject) => {
      const waiters = this.shareWaiters.get(pending.request_id) || new Set();
      requireValue(waiters.size < 64, 'QUEUE_FULL', 429);
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        waiters.delete(waiter);
        error ? reject(error) : resolve(value);
      };
      const cancel = code => {
        finish(new Fault(code));
        if (!waiters.size) this.finishRequest(pending.request_id, new Fault(code));
      };
      const abort = () => cancel('COMMAND_CANCELLED');
      const timer = setTimeout(() => cancel('COMMAND_EXPIRED'), waitMs);
      const waiter = { finish };
      waiters.add(waiter);
      this.shareWaiters.set(pending.request_id, waiters);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  targets(clientId, tenant) {
    const client = this.store.client(clientId, tenant);
    requireValue(client, 'NOT_AUTHORIZED', 403);
    return this.store.devicesForClient(clientId, client.tenant_id).map(device => {
      const grants = [...this.grants.values()].filter(g =>
        g.client_id === clientId && g.device_id === device.id);
      const grant = grants[0];
      const pending = [...this.requests.values()].find(r =>
        r.client_id === clientId && r.device_id === device.id && r.expires_at > Date.now());
      const connection = this.connections.get(device.id);
      const connected = Boolean(connection && this.current(connection));
      let state = 'approval_required';
      if (grant) state = 'active';
      else if (!connected) state = 'offline';
      else if (pending) state = 'pending';
      return {
        device_id: device.id, label: device.label,
        tenant_id: device.tenant_id,
        state,
        connection_state: connected ? 'connected' : 'offline',
        sharing_state: grant ? 'active' : 'none',
        pending_request_id: pending?.request_id ?? null,
        target_id: grant?.target_id ?? null, capabilities: grant?.capabilities ?? [],
        shared_tabs: grants.map(g => ({ target_id: g.target_id, tab_handle: g.target_id,
          tab_id: g.tab_id, window_id: g.window_id, capabilities: g.capabilities })),
      };
    });
  }
  async operate(clientId, targetId, operation, args, signal, tenant,
    description = 'Perform the requested action in this shared browser tab', waitMs = HUMAN_WAIT_MS) {
    requireValue(validTargetId(targetId), 'INVALID_ARGUMENTS');
    requireValue((OPERATIONS.includes(operation) || operation === 'request_handoff') &&
      args && typeof args === 'object' && !Array.isArray(args),
      'INVALID_ARGUMENTS');
    requireValue(validOperationArgs(operation, args), 'INVALID_ARGUMENTS');
    const grant = this.grants.get(targetId);
    requireValue(grant && grant.client_id === clientId && (!tenant || grant.tenant_id === tenant) &&
      this.store.linked(clientId, grant.device_id, grant.tenant_id),
      'NOT_AUTHORIZED', 403);
    requireValue(operation === 'request_handoff' || grant.capabilities.includes(operation), 'CAPABILITY_UNAVAILABLE');
    requireValue(validDescription(description) &&
      Number.isInteger(waitMs) && waitMs >= 1000 && waitMs <= HUMAN_WAIT_MS, 'INVALID_ARGUMENTS');
    if (operation === 'navigate') {
      try { navigationUrl(args.url, this.config.protectedOrigins); }
      catch {
        this.endGrant(targetId, 'HANDOFF_REQUIRED');
        throw new Fault('HANDOFF_REQUIRED');
      }
    }
    requireValue(grant.queued < 32, 'QUEUE_FULL', 429);
    const deadline = Date.now() + waitMs;
    grant.queued++;
    const previous = grant.tail;
    let release;
    grant.tail = new Promise(resolve => { release = resolve; });
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve();
        };
        const abort = () => finish(new Fault('COMMAND_CANCELLED'));
        const timer = setTimeout(() => finish(new Fault('COMMAND_EXPIRED')), Math.max(1, deadline - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        previous.then(() => finish(), error => finish(error));
        if (signal?.aborted) abort();
      });
      requireValue(!signal?.aborted && Date.now() < deadline, 'COMMAND_EXPIRED');
      requireValue(this.grants.get(targetId) === grant && this.store.linked(clientId, grant.device_id, grant.tenant_id),
        'NOT_AUTHORIZED', 403);
      const session = this.connections.get(grant.device_id);
      requireValue(session?.connection_id === grant.connection_id && this.current(session), 'BROWSER_OFFLINE');
      const requestId = randomUUID();
      const started = Date.now();
      let result;
      try {
        result = await new Promise((resolve, reject) => {
          const finish = (error, value) => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
            this.calls.delete(requestId);
            error ? reject(error) : resolve(value);
          };
          const cancel = code => {
            this.send(session, { type: 'command.cancel', request_id: requestId, target_id: targetId, reason: code });
            const executing = this.calls.get(requestId)?.phase === 'executing';
            finish(new Fault(executing ? 'OUTCOME_UNKNOWN' : code));
            if (executing) this.endGrant(targetId, 'OUTCOME_UNKNOWN');
          };
          const abort = () => cancel('COMMAND_CANCELLED');
          let timeout = setTimeout(() => cancel('COMMAND_EXPIRED'), Math.max(1, deadline - Date.now()));
          signal?.addEventListener('abort', abort, { once: true });
          this.calls.set(requestId, {
            target_id: targetId, client_id: clientId, device_id: grant.device_id, connection_id: grant.connection_id,
            phase: 'waiting', deadline, cancel,
            resolve: value => finish(null, value), reject: error => finish(error),
            execute: () => {
              const call = this.calls.get(requestId);
              call.phase = 'executing';
              audit('action_execution_started', { client_id: clientId, target_id: targetId,
                request_id: requestId, operation, duration_ms: Date.now() - started });
              clearTimeout(timeout);
              timeout = setTimeout(() => cancel('OUTCOME_UNKNOWN'), EXECUTION_MS);
              if (!this.send(session, { type: 'command.execute', request_id: requestId,
                target_id: targetId, expires_at: Date.now() + EXECUTION_MS,
                execution_timeout_ms: EXECUTION_MS })) cancel('BROWSER_OFFLINE');
            },
          });
          if (signal?.aborted) { abort(); return; }
          if (!this.send(session, {
            type: 'command', request_id: requestId, target_id: targetId,
            client_id: clientId, operation, args, epoch: this.epoch, connection_id: grant.connection_id,
            description: description.trim(), expires_at: deadline,
            wait_timeout_ms: Math.max(1, deadline - Date.now()),
          })) {
            this.endGrant(targetId, 'BROWSER_OFFLINE');
          }
        });
      } catch (error) {
        audit('operation_finished', { client_id: clientId, target_id: targetId, operation,
          request_id: requestId, duration_ms: Date.now() - started, code: failureCode(error), ...inspectionErrorDetails(error) });
        throw error;
      }
      audit('operation_finished', { client_id: clientId, target_id: targetId, operation,
        request_id: requestId, duration_ms: Date.now() - started, code: 'OK' });
      return result;
    } finally {
      grant.queued--;
      release();
    }
  }
  reconcile() {
    for (const [id, grant] of this.grants) {
      if (!this.store.linked(grant.client_id, grant.device_id)) this.endGrant(id, 'REVOKED');
    }
    for (const [id, request] of this.requests) {
      if (!this.store.linked(request.client_id, request.device_id) ||
          this.store.client(request.client_id)?.credential_hash !== this.requestCredentials.get(id) ||
          request.expires_at < Date.now()) {
        this.finishRequest(id, new Fault(request.expires_at < Date.now() ? 'COMMAND_EXPIRED' : 'NOT_AUTHORIZED'));
      }
    }
    for (const session of this.connections.values()) {
      if (!this.store.device(session.device.id)) {
        this.disconnected(session, 'REVOKED');
        session.ws.close(1008, 'REVOKED');
      }
    }
  }
  sweep() {
    this.reconcile();
    for (const [id, time] of this.denials) {
      if (Date.now() - time >= 30_000) this.denials.delete(id);
    }
    for (const session of this.connections.values()) {
      if (Date.now() - session.lastSeen > LIVENESS_MS) {
        this.disconnected(session, 'HEARTBEAT_TIMEOUT');
        session.ws.terminate();
      } else {
        this.send(session, { type: 'ping' });
      }
    }
  }
  close() {
    clearInterval(this.timer);
    for (const session of this.connections.values()) this.disconnected(session, 'SERVICE_STOPPED');
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
  }
}
