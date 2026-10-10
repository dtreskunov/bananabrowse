import {
  VERSION, POLICY_ID, LIVENESS_MS, authPayload, enrollmentPayload, extensionOrigin,
  grantPayload, serviceOrigin, sign, startPayload, statusPayload,
} from '../../shared/protocol.js';
import {
  COMMAND_TIMEOUT_MS, MAX_MESSAGE_BYTES, MAX_QUEUE, boundedResult, checkBinding,
  errorCode, fail, id, originList, protectedUnion, text, validateCommand,
} from './security.js';

export const LOCAL_END_REASONS = new Set([
  'OWNER_PAUSED', 'HANDOFF', 'REVOKED', 'TARGET_CLOSED', 'CAPABILITY_UNAVAILABLE',
]);
const END_REASONS = new Set([...LOCAL_END_REASONS, 'OUTCOME_UNKNOWN', 'BROWSER_OFFLINE', 'REPLACED']);

export class Controller {
  constructor({ adapter, keys, storage, inventoryStorage, extensionUrl,
    fetcher = (...args) => globalThis.fetch(...args), Socket = WebSocket,
    now = () => Date.now(), notify = () => {}, changed = () => {} }) {
    Object.assign(this, { adapter, keys, storage, inventoryStorage, fetcher, Socket, now, notify, changed });
    const url = new URL(extensionUrl);
    this.extension_origin = extensionOrigin(`${url.protocol}//${url.host}`);
    this.config = { service_origin: '', local_protected_origins: [], enabled: false };
    this.record = null;
    this.socket = null;
    this.generation = 0;
    this.connection = null;
    this.phase = 'disconnected';
    this.lastPing = 0;
    this.pending = new Map();
    this.grants = new Map();
    this.inventory = [];
    this.failures = [];
    this.approving = new Set();
    this.approvingClients = new Set();
    this.busyTabs = new Set();
    this.teardowns = new Set();
    this.reconnectAttempts = 0;
    this.timer = null;
    this.reconnectTimer = null;
    this.adapter.onTabEvent = (...args) => this.tabEvent(...args);
    this.adapter.onWarning = error => this.report(error);
  }

  report(error) {
    console.error('DomAgent:', error);
    this.failures = [...this.failures.slice(-4), errorCode(error)];
    this.changed();
  }

  async initialize() {
    const [saved, session] = await Promise.all([
      this.storage.get(['config']), this.inventoryStorage.get(['dedicatedTabs']),
    ]);
    // Tab IDs are authoritative only within this browser session. Persisting
    // them across browser restarts could accidentally adopt an unrelated tab.
    this.inventory = Array.isArray(session.dedicatedTabs) ? session.dedicatedTabs : [];
    await this.adapter.initialize(this.inventory);
    if (saved.config?.service_origin) {
      this.config = { service_origin: serviceOrigin(saved.config.service_origin),
        local_protected_origins: originList(saved.config.local_protected_origins || []),
        enabled: saved.config.enabled === true };
      this.record = await this.keys.get(this.config.service_origin);
    }
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.config.enabled && this.record?.identity) this.connect();
    this.changed();
  }

  protectedOrigins() {
    return protectedUnion(this.config.service_origin, this.config.local_protected_origins,
      this.record?.protected_origins || []);
  }

  snapshot() {
    return {
      config: this.config, phase: this.phase, identity: this.record?.identity || null,
      key_id: this.record?.key_id || null,
      enrollment: this.record?.enrollment || null,
      protected_origins: this.config.service_origin ? this.protectedOrigins() : [],
      capabilities: this.adapter.capabilities(),
      pending: [...this.pending.values()].map(request => ({
        request_id: request.request_id, client_id: request.client_id, client_label: request.client_label,
        expires_at: request.expires_at, policy_id: request.policy_id,
      })),
      targets: this.inventory.filter(tab => tab.origin === this.config.service_origin &&
        tab.device_id === this.record?.identity?.device_id).map(tab => {
        const grant = [...this.grants.values()].find(grant => grant.tabId === tab.tabId);
        return { client_id: tab.client_id, tabId: tab.tabId, target_id: grant?.target_id,
          state: grant?.state || 'inactive' };
      }),
      failures: this.failures,
    };
  }

  async configure(value) {
    const origin = serviceOrigin(value.service_origin);
    const local = originList(value.local_protected_origins || []);
    await this.disconnect();
    this.config = { service_origin: origin, local_protected_origins: local, enabled: false };
    this.record = await this.keys.get(origin);
    await this.storage.set({ config: this.config });
    this.changed();
    return this.snapshot();
  }

  async api(path, body) {
    const response = await this.fetcher(`${this.config.service_origin}/api/enrollment/${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) fail('NOT_AUTHORIZED');
    const raw = await response.text();
    if (raw.length > 32_768) fail('INVALID_MESSAGE');
    return JSON.parse(raw);
  }

  async enroll(label) {
    if (!this.record || this.connection) fail('NOT_AUTHORIZED');
    await this.disconnect();
    const origin = this.config.service_origin;
    const record = this.record;
    const challenge = await this.api('challenge');
    if (challenge.origin !== origin) fail('NOT_AUTHORIZED');
    text(challenge.nonce, 256);
    const request = { origin, nonce: challenge.nonce, key_id: record.key_id,
      public_key: record.public_key, extension_origin: this.extension_origin, label: text(label, 100) };
    const signature = await sign(record.privateKey, startPayload(request));
    const enrollment = await this.api('start', { ...request, origin: undefined, signature });
    id(enrollment.enrollment_id);
    if (new URL(enrollment.verification_url).origin !== origin ||
        !enrollment.verification_url.startsWith('https://') ||
        !Number.isFinite(enrollment.expires_at) || enrollment.expires_at <= this.now()) fail('INVALID_MESSAGE');
    if (this.record !== record || this.config.service_origin !== origin) fail('NOT_AUTHORIZED');
    record.enrollment = { enrollment_id: enrollment.enrollment_id,
      verification_url: enrollment.verification_url, expires_at: enrollment.expires_at, state: 'pending' };
    await this.keys.save(record);
    this.changed();
    return record.enrollment;
  }

  async enrollmentStatus() {
    const record = this.record;
    const origin = this.config.service_origin;
    const enrollment = record?.enrollment;
    if (!enrollment || enrollment.expires_at <= this.now()) fail('ENROLLMENT_EXPIRED');
    const request = { origin, enrollment_id: enrollment.enrollment_id };
    const signature = await sign(record.privateKey, statusPayload(request));
    const status = await this.api('status', { enrollment_id: request.enrollment_id, signature });
    if (this.record !== record || status.enrollment_id !== enrollment.enrollment_id ||
        !['pending', 'approved'].includes(status.state)) fail('NOT_AUTHORIZED');
    if (status.state === 'approved') {
      if (status.key_id !== record.key_id || status.extension_origin !== this.extension_origin ||
          !Number.isFinite(status.expires_at) || status.expires_at <= this.now()) fail('NOT_AUTHORIZED');
      id(status.owner_id);
      text(status.owner_label);
      text(status.nonce);
      originList(status.protected_origins);
      record.enrollment = { ...status, verification_url: enrollment.verification_url };
      await this.keys.save(record);
    }
    this.changed();
    return record.enrollment;
  }

  async confirmEnrollment() {
    await this.disconnect();
    const record = this.record;
    const origin = this.config.service_origin;
    const status = record?.enrollment;
    if (!status || status.state !== 'approved' || status.expires_at <= this.now()) fail('ENROLLMENT_EXPIRED');
    const signature = await sign(record.privateKey, enrollmentPayload({ ...status, origin }));
    const identity = await this.api('confirm', { enrollment_id: status.enrollment_id, signature });
    if (this.record !== record || identity.key_id !== record.key_id ||
        identity.owner_id !== status.owner_id) fail('NOT_AUTHORIZED');
    id(identity.device_id);
    text(identity.owner_label);
    record.protected_origins = protectedUnion(origin, record.protected_origins,
      status.protected_origins, identity.protected_origins);
    record.identity = { device_id: identity.device_id, owner_id: identity.owner_id,
      owner_label: identity.owner_label };
    record.enrollment = null;
    await this.keys.save(record);
    this.changed();
    return record.identity;
  }

  async enable() {
    if (!this.record?.identity) fail('NOT_AUTHORIZED');
    this.config.enabled = true;
    await this.storage.set({ config: this.config });
    this.reconnectAttempts = 0;
    this.connect();
  }

  connect() {
    if (this.socket || !this.config.enabled || !this.record?.identity) return;
    clearTimeout(this.reconnectTimer);
    const generation = ++this.generation;
    const socket = new this.Socket(`${this.config.service_origin.replace('https:', 'wss:')}/extension`);
    this.socket = socket;
    this.phase = 'connecting';
    this.lastPing = this.now();
    let messages = Promise.resolve();
    socket.onopen = () => {
      if (!this.current(socket, generation)) return;
      this.phase = 'authenticating';
      socket.send(JSON.stringify({ type: 'hello', version: VERSION, key_id: this.record.key_id }));
      this.changed();
    };
    socket.onmessage = event => {
      if (!this.current(socket, generation)) return;
      messages = messages.then(() => this.receive(event.data, socket, generation)).catch(error => {
        this.report(error);
        if (this.current(socket, generation)) this.loseConnection(socket, generation);
      });
    };
    socket.onclose = () => this.loseConnection(socket, generation);
    socket.onerror = () => {
      if (this.current(socket, generation)) {
        this.report(new Error('BROWSER_OFFLINE'));
        this.loseConnection(socket, generation);
      }
    };
    this.changed();
  }

  current(socket, generation) {
    return this.socket === socket && this.generation === generation;
  }

  send(message) {
    if (!this.connection || this.socket?.readyState !== 1 ||
        this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
    this.socket.send(JSON.stringify(message));
  }

  async receive(raw, socket, generation) {
    if (!this.current(socket, generation)) return;
    if (this.now() - this.lastPing >= LIVENESS_MS) {
      this.loseConnection(socket, generation);
      fail('BROWSER_OFFLINE');
    }
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) fail('INVALID_MESSAGE');
    const message = JSON.parse(raw);
    if (!message || typeof message !== 'object') fail('INVALID_MESSAGE');
    if (message.type === 'error') {
      text(message.code);
      if (message.code === 'COMMAND_EXPIRED') fail('COMMAND_EXPIRED');
      fail('NOT_AUTHORIZED');
    }
    if (message.type === 'challenge') {
      if (this.phase !== 'authenticating' || message.origin !== this.config.service_origin ||
          message.key_id !== this.record.key_id) fail('NOT_AUTHORIZED');
      id(message.epoch);
      id(message.connection_id);
      text(message.nonce);
      this.phase = 'proving';
      this.challenge = message;
      const signature = await sign(this.record.privateKey, authPayload(message));
      if (this.current(socket, generation)) socket.send(JSON.stringify({ type: 'proof', signature }));
      return;
    }
    if (message.type === 'authenticated') {
      const identity = this.record.identity;
      if (this.phase !== 'proving' || message.device_id !== identity.device_id ||
          message.owner_id !== identity.owner_id) fail('NOT_AUTHORIZED');
      checkBinding(message, this.challenge);
      text(message.owner_label);
      this.record.protected_origins = protectedUnion(this.config.service_origin,
        this.record.protected_origins, message.protected_origins);
      await this.keys.save(this.record);
      if (!this.current(socket, generation)) return;
      this.connection = { epoch: message.epoch, connection_id: message.connection_id };
      this.phase = 'authenticated';
      this.lastPing = this.now();
      this.reconnectAttempts = 0;
      this.changed();
      return;
    }
    if (!this.connection || this.phase !== 'authenticated') fail('NOT_AUTHORIZED');
    if (message.type === 'ping') {
      this.lastPing = this.now();
      this.send({ type: 'pong' });
    } else if (message.type === 'approval.request') {
      checkBinding(message, this.connection);
      id(message.request_id);
      id(message.client_id);
      text(message.client_label);
      text(message.nonce);
      if (message.policy_id !== POLICY_ID || !Number.isFinite(message.expires_at) ||
          message.expires_at <= this.now() || message.expires_at > this.now() + 300_000) fail('INVALID_MESSAGE');
      if (this.pending.size >= 32 || this.pending.has(message.request_id)) fail('INVALID_MESSAGE');
      const protectedOrigins = protectedUnion(this.config.service_origin,
        this.record.protected_origins, message.protected_origins);
      if (protectedOrigins.some(origin => !this.protectedOrigins().includes(origin))) {
        // Newly protected origins must never wait behind a still-active old filter.
        await Promise.all([...this.grants.values()].map(grant => this.end(grant.target_id, 'OWNER_PAUSED')));
      }
      this.record.protected_origins = protectedOrigins;
      await this.keys.save(this.record);
      if (!this.current(socket, generation)) return;
      this.pending.set(message.request_id, message);
      this.notify('Browser approval needed', `Client ${message.client_id} is requesting page control.`);
      this.changed();
    } else if (message.type === 'grant.active') {
      const grant = this.grants.get(message.target_id);
      if (!grant || grant.state !== 'awaiting_ack' || message.client_id !== grant.client_id) fail('NOT_AUTHORIZED');
      if (grant.ackDeadline <= this.now()) {
        await this.end(grant.target_id, 'OWNER_PAUSED');
        fail('APPROVAL_REQUIRED');
      }
      checkBinding(grant, this.connection);
      grant.state = 'active';
      this.changed();
    } else if (message.type === 'grant.end') {
      id(message.target_id);
      const reason = END_REASONS.has(message.reason) ? message.reason : 'REVOKED';
      await this.end(message.target_id, reason, false);
    } else if (message.type === 'command') {
      // Commands queue independently; the heartbeat/teardown stream never waits for page work.
      this.enqueue(message);
    } else {
      fail('INVALID_MESSAGE');
    }
  }

  async approve(requestId, capabilities) {
    const request = this.pending.get(requestId);
    if (!request || this.approving.has(requestId)) fail('APPROVAL_REQUIRED');
    checkBinding(request, this.connection);
    if (request.expires_at <= this.now()) fail('APPROVAL_REQUIRED');
    if (!Array.isArray(capabilities) || !capabilities.length ||
        new Set(capabilities).size !== capabilities.length ||
        capabilities.some(value => !this.adapter.capabilities().includes(value))) fail('INVALID_ARGUMENT');
    if (this.approvingClients.has(request.client_id) ||
        [...this.grants.values()].some(grant => grant.client_id === request.client_id)) fail('APPROVAL_REQUIRED');
    this.approving.add(requestId);
    this.approvingClients.add(request.client_id);
    const generation = this.generation;
    let grant;
    let createdTabId;
    const checkApproval = () => {
      if (this.generation !== generation || request.expires_at <= this.now() ||
          !this.pending.has(requestId) || (grant && this.grants.get(grant.target_id) !== grant)) {
        fail('APPROVAL_REQUIRED');
      }
      if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
      checkBinding(request, this.connection);
    };
    try {
      const previous = this.inventory.find(tab => tab.origin === this.config.service_origin &&
        tab.device_id === this.record.identity.device_id && tab.client_id === request.client_id);
      const tab = await this.adapter.createTab(this.busyTabs.has(previous?.tabId) ? undefined : previous?.tabId);
      createdTabId = tab.id;
      this.busyTabs.add(tab.id);
      const inventory = { origin: this.config.service_origin, device_id: this.record.identity.device_id,
        client_id: request.client_id, tabId: tab.id };
      this.inventory = this.inventory.filter(existing => existing !== previous);
      this.inventory.push(inventory);
      await this.inventoryStorage.set({ dedicatedTabs: this.inventory });
      grant = { ...request, target_id: crypto.randomUUID(), tabId: tab.id, state: 'preparing',
        capabilities: [...capabilities], protected_origins: this.protectedOrigins(),
        blankAllowed: (tab.url || tab.pendingUrl) === 'about:blank',
        documentGeneration: 0, queue: [], running: false, generation };
      this.grants.set(grant.target_id, grant);
      checkApproval();
      await this.adapter.protect(tab.id, grant.protected_origins);
      checkApproval();
      await this.adapter.inspect(tab.id, grant.protected_origins, true);
      checkApproval();
      await this.adapter.attach(tab.id);
      checkApproval();
      const signature = await sign(this.record.privateKey, grantPayload({
        ...request, origin: this.config.service_origin, target_id: grant.target_id, capabilities,
      }));
      checkApproval();
      grant.state = 'awaiting_ack';
      grant.ackDeadline = this.now() + 10_000;
      this.send({ type: 'grant.approve', request_id: requestId, client_id: request.client_id,
        target_id: grant.target_id, policy_id: POLICY_ID, nonce: request.nonce, capabilities, signature });
      this.pending.delete(requestId);
      this.changed();
    } catch (error) {
      if (grant) {
        this.grants.delete(grant.target_id);
        try {
          await this.adapter.release(grant.tabId);
        } catch (cleanupError) {
          this.report(cleanupError);
        }
      }
      throw error;
    } finally {
      this.approving.delete(requestId);
      this.approvingClients.delete(request.client_id);
      if (createdTabId !== undefined) this.busyTabs.delete(createdTabId);
    }
  }

  deny(requestId) {
    if (!this.pending.has(requestId) || this.approving.has(requestId)) fail('APPROVAL_REQUIRED');
    this.send({ type: 'approval.deny', request_id: requestId });
    this.pending.delete(requestId);
    this.changed();
  }

  async end(targetId, reason, announce = true, retainProtection = false) {
    if (!END_REASONS.has(reason)) fail('INVALID_ARGUMENT');
    const grant = this.grants.get(targetId);
    if (!grant) return;
    // Disable authority synchronously, before any browser/API cleanup awaits.
    this.grants.delete(targetId);
    grant.state = 'ended';
    for (const queued of grant.queue.splice(0)) this.result(queued.message, { code: 'APPROVAL_REQUIRED' });
    if (announce && this.connection) {
      try {
        this.send({ type: 'grant.end', target_id: targetId, reason });
      } catch (error) {
        this.report(error);
      }
    }
    this.busyTabs.add(grant.tabId);
    const cleanup = this.adapter.release(grant.tabId, { retainProtection });
    this.teardowns.add(cleanup);
    try {
      await cleanup;
    } catch (error) {
      this.report(error);
    } finally {
      this.teardowns.delete(cleanup);
      // An in-progress approval still owns this tab until its own finally block.
      if (!this.approvingClients.has(grant.client_id)) this.busyTabs.delete(grant.tabId);
    }
    if (reason === 'HANDOFF') this.notify('Human handoff required',
      'Control stopped. Finish authentication or inspection, then request fresh approval. Prior/scheduled JavaScript is not undone.');
    else if (['OUTCOME_UNKNOWN', 'BROWSER_OFFLINE', 'CAPABILITY_UNAVAILABLE'].includes(reason)) {
      this.notify('Browser control ended',
        `${reason}. The tab remains open. Prior/scheduled JavaScript is not undone. Fresh local approval is required.`);
    }
    this.changed();
  }

  resume(clientId) {
    id(clientId);
    if (!this.inventory.some(tab => tab.origin === this.config.service_origin &&
        tab.device_id === this.record.identity.device_id && tab.client_id === clientId)) fail('NOT_AUTHORIZED');
    this.send({ type: 'access.request', client_id: clientId });
  }

  result(message, error, result) {
    if (!this.connection || message.epoch !== this.connection.epoch ||
        message.connection_id !== this.connection.connection_id) return;
    try {
      this.send({ type: 'result', request_id: message.request_id, target_id: message.target_id,
        ...(error ? { error } : { result }) });
    } catch (sendError) {
      this.report(sendError);
    }
  }

  enqueue(message) {
    let grant;
    try {
      grant = this.grants.get(message.target_id);
      if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
      validateCommand(message, grant, this.connection, this.protectedOrigins(), this.now());
      if (grant.queue.length >= MAX_QUEUE) fail('QUEUE_FULL');
      if (grant.seen?.has(message.request_id)) fail('INVALID_MESSAGE');
      grant.seen ||= new Set();
      if (grant.seen.size >= 10_000) fail('QUEUE_FULL');
      grant.seen.add(message.request_id);
      grant.queue.push({ message, deadline: Math.min(message.expires_at, this.now() + COMMAND_TIMEOUT_MS),
        documentGeneration: grant.documentGeneration });
      void this.drain(grant).catch(error => this.report(error));
    } catch (error) {
      this.result(message, { code: errorCode(error) });
      if (errorCode(error) === 'HANDOFF_REQUIRED' && grant) void this.end(grant.target_id, 'HANDOFF');
    }
  }

  async drain(grant) {
    if (grant.running) return;
    grant.running = true;
    try {
      while (grant.queue.length) {
        const queued = grant.queue.shift();
        const { message } = queued;
        let timer;
        const checkCurrent = (after = false) => {
          if (this.grants.get(grant.target_id) !== grant || this.generation !== grant.generation) fail('APPROVAL_REQUIRED');
          if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
          validateCommand(message, grant, this.connection, this.protectedOrigins(), this.now());
          if (this.now() >= queued.deadline) fail('OUTCOME_UNKNOWN');
          // These results acknowledge completed actions, not data from a new document.
          if ((!after || !['navigate', 'click', 'type_text'].includes(message.operation)) &&
              grant.documentGeneration !== queued.documentGeneration) fail('TARGET_STALE');
        };
        try {
          checkCurrent();
          const execution = this.adapter.execute(grant, message.operation, message.args, checkCurrent);
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('OUTCOME_UNKNOWN')), Math.max(1, queued.deadline - this.now()));
          });
          const result = await Promise.race([execution, timeout]);
          checkCurrent(true);
          this.result(message, null, boundedResult(result));
        } catch (error) {
          const code = errorCode(error);
          this.result(message, { code });
          if (['HANDOFF_REQUIRED', 'OUTCOME_UNKNOWN'].includes(code)) {
            await this.end(grant.target_id, 'HANDOFF');
          } else if (code === 'PAGE_UNAVAILABLE') {
            this.report(error);
            await this.end(grant.target_id, 'CAPABILITY_UNAVAILABLE');
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      grant.running = false;
    }
  }

  tabEvent(tabId, type, url) {
    if (type === 'closed') {
      this.inventory = this.inventory.filter(tab => tab.tabId !== tabId);
      this.inventoryStorage.set({ dedicatedTabs: this.inventory }).catch(error => this.report(error));
      this.changed();
    }
    for (const grant of this.grants.values()) {
      if (grant.tabId !== tabId) continue;
      if (type === 'navigation') {
        grant.documentGeneration++;
        if (url && !(url === 'about:blank' && grant.blankAllowed)) {
          let protectedPage = true;
          let protectedOrigin = false;
          try {
            const page = new URL(url);
            grant.blankAllowed = false;
            protectedOrigin = this.protectedOrigins().includes(page.origin);
            protectedPage = !['http:', 'https:'].includes(page.protocol) || protectedOrigin;
          } catch (error) {
            this.report(error);
          }
          if (protectedPage) {
            void this.end(grant.target_id, 'HANDOFF', true, protectedOrigin);
          }
        }
      } else {
        let reason = 'OWNER_PAUSED';
        if (type === 'protected_pending') reason = 'HANDOFF';
        else if (type === 'closed') reason = 'TARGET_CLOSED';
        void this.end(grant.target_id, reason, true, type === 'protected_pending');
      }
    }
  }

  tick() {
    if (this.socket && this.now() - this.lastPing >= LIVENESS_MS) {
      this.loseConnection(this.socket, this.generation);
    }
    for (const [requestId, request] of this.pending) {
      if (request.expires_at <= this.now()) {
        this.pending.delete(requestId);
        this.changed();
      }
    }
    for (const grant of this.grants.values()) {
      if (grant.state === 'awaiting_ack' && grant.ackDeadline <= this.now()) {
        void this.end(grant.target_id, 'OWNER_PAUSED');
      }
    }
  }

  loseConnection(socket, generation, reconnect = true) {
    if (!this.current(socket, generation)) return;
    this.socket = null;
    this.connection = null;
    this.challenge = null;
    this.phase = 'disconnected';
    this.generation++;
    this.pending.clear();
    for (const grant of [...this.grants.values()]) void this.end(grant.target_id, 'BROWSER_OFFLINE', false);
    socket.close();
    if (reconnect && this.config.enabled && this.reconnectAttempts < 6) {
      const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
    this.changed();
  }

  async disconnect() {
    this.config.enabled = false;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.loseConnection(this.socket, this.generation, false);
    await Promise.all([...this.grants.values()].map(grant => this.end(grant.target_id, 'BROWSER_OFFLINE', false)));
    await Promise.allSettled([...this.teardowns]);
    await this.storage.set({ config: this.config });
    this.changed();
  }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.loseConnection(this.socket, this.generation, false);
  }
}
