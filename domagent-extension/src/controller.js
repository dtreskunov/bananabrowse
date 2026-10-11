import {
  VERSION, POLICY_ID, LIVENESS_MS, HUMAN_WAIT_MS, EXECUTION_MS, authPayload, enrollmentPayload, extensionOrigin,
  connectionUrl, grantPayload, parseConnectionUrl, serviceOrigin, sign, startPayload, statusPayload, tenantId, waitErrorDetails,
} from '../../shared/protocol.js';
import {
  MAX_MESSAGE_BYTES, MAX_QUEUE, boundedResult, checkBinding,
  errorCode, fail, id, localDeadline, originList, protectedUnion, text, validateCommand,
} from './security.js';

export const LOCAL_END_REASONS = new Set([
  'OWNER_PAUSED', 'HANDOFF', 'REVOKED', 'TARGET_CLOSED', 'CAPABILITY_UNAVAILABLE',
]);
const END_REASONS = new Set([...LOCAL_END_REASONS, 'OUTCOME_UNKNOWN', 'BROWSER_OFFLINE', 'REPLACED']);
const followsNavigation = operation => ['request_handoff', 'wait_for_page'].includes(operation);

export class Controller {
  constructor({ adapter, keys, storage, inventoryStorage, extensionUrl,
    fetcher = (...args) => globalThis.fetch(...args), Socket = WebSocket,
    now = () => Date.now(), notify = () => {}, changed = () => {} }) {
    Object.assign(this, { adapter, keys, storage, inventoryStorage, fetcher, Socket, now, notify, changed });
    const url = new URL(extensionUrl);
    this.extension_origin = extensionOrigin(`${url.protocol}//${url.host}`);
    this.config = { service_origin: '', local_protected_origins: [], enabled: false };
    this.record = null;
    this.savedConnections = [];
    this.enrollmentPolling = false;
    this.lastEnrollmentPoll = 0;
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
    this.busyTabs = new Set();
    this.teardowns = new Set();
    this.reconnectAttempts = 0;
    this.timer = null;
    this.reconnectTimer = null;
    this.adapter.onTabEvent = (...args) => this.tabEvent(...args);
    this.adapter.onWarning = error => this.report(error);
    this.adapter.onRequestClosed = requestId => {
      if (this.pending.has(requestId)) {
        try { this.deny(requestId); } catch (error) { this.report(error); }
      }
    };
  }

  report(error) {
    console.error('DomAgent:', errorCode(error));
    this.failures = [...this.failures.slice(-4), errorCode(error)];
    this.changed();
  }

  async initialize() {
    const saved = await this.storage.get(['config', 'savedConnections']);
    // No inventory survives a background/browser restart; identity is not authority.
    this.inventory = [];
    await this.adapter.initialize([]);
    this.savedConnections = (Array.isArray(saved.savedConnections) ? saved.savedConnections : [])
      .filter(pair => {
        try { return parseConnectionUrl(pair.connection_url).tenant_id === pair.tenant_id; } catch { return false; }
      }).slice(0, 32);
    if (saved.config?.service_origin && saved.config?.tenant_id) {
      this.config = { service_origin: serviceOrigin(saved.config.service_origin),
        tenant_id: tenantId(saved.config.tenant_id),
        connection_url: connectionUrl(saved.config.service_origin, saved.config.tenant_id),
        local_protected_origins: originList(saved.config.local_protected_origins || []),
        enabled: saved.config.enabled === true };
      this.record = await this.keys.get(this.config.service_origin, this.config.tenant_id);
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
      saved_connections: this.savedConnections,
      enrollment: this.record?.enrollment || null,
      protected_origins: this.config.service_origin ? this.protectedOrigins() : [],
      capabilities: this.adapter.capabilities(),
      pending: [...this.pending.values()].map(request => ({
        request_id: request.request_id, client_id: request.client_id, client_label: request.client_label,
        tenant_id: request.tenant_id,
        description: request.description, expires_at: request.expires_at, policy_id: request.policy_id,
      })),
      targets: [...this.grants.values()].map(grant => ({
        client_id: grant.client_id, client_label: grant.client_label,
        tabId: grant.tabId, target_id: grant.target_id, state: grant.state,
        allow_all: grant.allowAll === true,
        indicator_unavailable: grant.indicatorUnavailable === true,
        commands: grant.queue.map(queued => ({
          request_id: queued.message.request_id, operation: queued.message.operation,
          description: queued.message.description, expires_at: queued.deadline, state: queued.state,
        })),
      })),
      failures: this.failures,
    };
  }

  async configure(value) {
    const pair = value.connection_url ? parseConnectionUrl(value.connection_url) : {
      origin: serviceOrigin(value.service_origin), tenant_id: tenantId(value.tenant_id),
      connection_url: connectionUrl(value.service_origin, value.tenant_id),
    };
    const origin = pair.origin;
    const saved = this.savedConnections.find(connection => connection.connection_url === pair.connection_url);
    const local = originList(value.local_protected_origins ?? saved?.local_protected_origins ?? []);
    await this.disconnect();
    this.config = { service_origin: origin, tenant_id: pair.tenant_id,
      connection_url: pair.connection_url, local_protected_origins: local, enabled: false };
    this.record = await this.keys.get(origin, pair.tenant_id);
    await this.storage.set({ config: this.config });
    this.changed();
    return this.snapshot();
  }

  async switchConnection(connection) {
    if (!this.savedConnections.some(pair => pair.connection_url === connection)) fail('NOT_AUTHORIZED');
    await this.configure({ connection_url: connection });
    await this.enable();
    return this.snapshot();
  }

  async saveConnection(record = this.record) {
    if (!record?.identity) return;
    const pair = { connection_url: record.connection_url, tenant_id: record.tenant_id,
      origin: record.origin, label: record.identity.tenant_label,
      local_protected_origins: this.record === record ? this.config.local_protected_origins
        : this.savedConnections.find(saved => saved.connection_url === record.connection_url)?.local_protected_origins || [] };
    this.savedConnections = [...this.savedConnections.filter(saved => saved.connection_url !== pair.connection_url), pair].slice(-32);
    await this.storage.set({ savedConnections: this.savedConnections });
  }

  async api(path, body) {
    const response = await this.fetcher(`${this.config.service_origin}/api/tenants/${tenantId(this.config.tenant_id)}/enrollment/${path}`, {
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
    const tenant = this.config.tenant_id;
    if (challenge.origin !== origin || challenge.tenant_id !== tenant) fail('NOT_AUTHORIZED');
    text(challenge.nonce, 256);
    const request = { origin, tenant_id: tenant, nonce: challenge.nonce, key_id: record.key_id,
      public_key: record.public_key, extension_origin: this.extension_origin, label: text(label, 100) };
    const signature = await sign(record.privateKey, startPayload(request));
    const enrollment = await this.api('start', { ...request, origin: undefined, signature });
    id(enrollment.enrollment_id);
    const verification = new URL(enrollment.verification_url);
    if (enrollment.tenant_id !== tenant || verification.origin !== origin ||
        verification.pathname !== `/pair/${tenant}` || verification.username || verification.password ||
        verification.hash || verification.search !== `?enrollment=${enrollment.enrollment_id}` ||
        !enrollment.verification_url.startsWith('https://') ||
        !Number.isFinite(enrollment.expires_at) || enrollment.expires_at <= this.now()) fail('INVALID_MESSAGE');
    if (this.record !== record || this.config.service_origin !== origin || this.config.tenant_id !== tenant) fail('NOT_AUTHORIZED');
    record.enrollment = { enrollment_id: enrollment.enrollment_id,
      tenant_id: tenant,
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
    const request = { origin, tenant_id: record.tenant_id, enrollment_id: enrollment.enrollment_id };
    const signature = await sign(record.privateKey, statusPayload(request));
    const status = await this.api('status', { tenant_id: record.tenant_id, enrollment_id: request.enrollment_id, signature });
    if (this.record !== record || status.enrollment_id !== enrollment.enrollment_id ||
        status.tenant_id !== record.tenant_id ||
        !['pending', 'approved'].includes(status.state)) fail('NOT_AUTHORIZED');
    if (status.state === 'approved') {
      if (status.key_id !== record.key_id || status.extension_origin !== this.extension_origin ||
          !Number.isFinite(status.expires_at) || status.expires_at <= this.now()) fail('NOT_AUTHORIZED');
      id(status.owner_id);
      text(status.owner_label);
      text(status.tenant_label, 80);
      text(status.nonce);
      originList(status.protected_origins);
      record.enrollment = { ...status, verification_url: enrollment.verification_url };
      await this.keys.save(record);
      await this.confirmEnrollment(record);
    }
    this.changed();
    return record.enrollment || record.identity;
  }

  async confirmEnrollment(expectedRecord = this.record) {
    await this.disconnect();
    const record = this.record;
    if (record !== expectedRecord) fail('NOT_AUTHORIZED');
    const origin = this.config.service_origin;
    const status = record?.enrollment;
    if (!status || status.state !== 'approved' || status.expires_at <= this.now()) fail('ENROLLMENT_EXPIRED');
    const signature = await sign(record.privateKey, enrollmentPayload({ ...status, origin }));
    const identity = await this.api('confirm', { tenant_id: record.tenant_id, enrollment_id: status.enrollment_id, signature });
    if (this.record !== record || identity.key_id !== record.key_id ||
        identity.tenant_id !== record.tenant_id ||
        identity.owner_id !== status.owner_id) fail('NOT_AUTHORIZED');
    id(identity.device_id);
    text(identity.owner_label);
    text(identity.tenant_label, 80);
    record.protected_origins = protectedUnion(origin, record.protected_origins,
      status.protected_origins, identity.protected_origins);
    record.identity = { device_id: identity.device_id, owner_id: identity.owner_id,
      owner_label: identity.owner_label, tenant_id: identity.tenant_id, tenant_label: identity.tenant_label };
    record.enrollment = null;
    await this.keys.save(record);
    if (this.record !== record) fail('NOT_AUTHORIZED');
    await this.saveConnection(record);
    if (this.record !== record) fail('NOT_AUTHORIZED');
    await this.enable();
    this.changed();
    return record.identity;
  }

  async enable() {
    if (!this.record?.identity || this.record.identity.tenant_id !== this.config.tenant_id) fail('NOT_AUTHORIZED');
    this.config.enabled = true;
    await this.storage.set({ config: this.config });
    this.reconnectAttempts = 0;
    this.connect();
  }

  connect() {
    if (this.socket || !this.config.enabled || !this.record?.identity ||
        this.record.identity.tenant_id !== this.config.tenant_id) return;
    clearTimeout(this.reconnectTimer);
    const generation = ++this.generation;
    const socket = new this.Socket(`${this.config.service_origin.replace('https:', 'wss:')}/extension/${tenantId(this.config.tenant_id)}`);
    this.socket = socket;
    this.phase = 'connecting';
    this.lastPing = this.now();
    let messages = Promise.resolve();
    socket.onopen = () => {
      if (!this.current(socket, generation)) return;
      this.phase = 'authenticating';
      socket.send(JSON.stringify({ type: 'hello', version: VERSION, tenant_id: this.config.tenant_id, key_id: this.record.key_id }));
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
    this.socket.send(JSON.stringify({ ...message, tenant_id: this.config.tenant_id }));
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
    if (message.tenant_id !== this.config.tenant_id) fail('NOT_AUTHORIZED');
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
      if (this.current(socket, generation)) socket.send(JSON.stringify({ type: 'proof', tenant_id: this.config.tenant_id, signature }));
      return;
    }
    if (message.type === 'authenticated') {
      const record = this.record;
      const identity = record.identity;
      if (this.phase !== 'proving' || message.device_id !== identity.device_id ||
          message.owner_id !== identity.owner_id) fail('NOT_AUTHORIZED');
      checkBinding(message, this.challenge);
      text(message.owner_label);
      text(message.tenant_label, 80);
      record.protected_origins = protectedUnion(this.config.service_origin,
        record.protected_origins, message.protected_origins);
      identity.tenant_label = message.tenant_label;
      await this.keys.save(record);
      if (!this.current(socket, generation)) return;
      await this.saveConnection(record);
      if (!this.current(socket, generation)) return;
      this.connection = { tenant_id: message.tenant_id, epoch: message.epoch, connection_id: message.connection_id };
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
      const record = this.record;
      checkBinding(message, this.connection);
      id(message.request_id);
      id(message.client_id);
      text(message.client_label);
      text(message.description, 4096);
      text(message.nonce);
      message.expires_at = localDeadline(message, 'wait_timeout_ms', HUMAN_WAIT_MS, this.now());
      if (message.policy_id !== POLICY_ID || !Number.isFinite(message.expires_at) ||
          message.expires_at <= this.now() || message.expires_at > this.now() + HUMAN_WAIT_MS) fail('INVALID_MESSAGE');
      if (this.pending.size >= 32 || this.pending.has(message.request_id)) fail('INVALID_MESSAGE');
      const protectedOrigins = protectedUnion(this.config.service_origin,
        record.protected_origins, message.protected_origins);
      if (protectedOrigins.some(origin => !this.protectedOrigins().includes(origin))) {
        // Newly protected origins must never wait behind a still-active old filter.
        await Promise.all([...this.grants.values()].map(grant => this.end(grant.target_id, 'OWNER_PAUSED')));
      }
      if (!this.current(socket, generation)) return;
      record.protected_origins = protectedOrigins;
      await this.keys.save(record);
      if (!this.current(socket, generation)) return;
      this.pending.set(message.request_id, message);
      this.notify('Sharing request', `${message.client_label} would like to use a tab.`);
      void this.adapter.requestWindow?.(message.request_id).then(() => {
        if (!this.pending.has(message.request_id)) return this.adapter.closeRequestWindow?.(message.request_id);
      }).catch(() => this.report(new Error('INDICATOR_UNAVAILABLE')));
      this.changed();
    } else if (message.type === 'approval.cancel') {
      id(message.request_id);
      this.pending.delete(message.request_id);
      void this.adapter.closeRequestWindow?.(message.request_id);
      for (const grant of this.grants.values()) {
        if (grant.request_id === message.request_id && grant.state === 'awaiting_ack') {
          void this.end(grant.target_id, 'OWNER_PAUSED');
        }
      }
      this.changed();
    } else if (message.type === 'grant.active') {
      const grant = this.grants.get(message.target_id);
      if (!grant || !['awaiting_ack', 'active'].includes(grant.state) ||
          message.client_id !== grant.client_id || message.tab_id !== grant.tabId) fail('NOT_AUTHORIZED');
      if (grant.state === 'awaiting_ack' && grant.ackDeadline <= this.now()) {
        await this.end(grant.target_id, 'OWNER_PAUSED');
        fail('APPROVAL_REQUIRED');
      }
      checkBinding(grant, this.connection);
      grant.state = 'active';
      void this.updateIndicator(grant);
      this.changed();
    } else if (message.type === 'grant.end') {
      id(message.target_id);
      let reason = 'REVOKED';
      if (message.reason === 'HANDOFF_REQUIRED') reason = 'HANDOFF';
      else if (END_REASONS.has(message.reason)) reason = message.reason;
      await this.end(message.target_id, reason, false);
    } else if (message.type === 'command') {
      // Commands queue independently; the heartbeat/teardown stream never waits for page work.
      this.enqueue(message);
    } else if (message.type === 'command.execute') {
      this.executeReady(message);
    } else if (message.type === 'command.cancel') {
      this.cancelCommand(message);
    } else {
      fail('INVALID_MESSAGE');
    }
  }

  async approve(requestId, tabId) {
    const request = this.pending.get(requestId);
    if (!request || this.approving.has(requestId)) fail('APPROVAL_REQUIRED');
    checkBinding(request, this.connection);
    if (request.expires_at <= this.now()) fail('APPROVAL_REQUIRED');
    if (!Number.isSafeInteger(tabId) || tabId < 0) fail('INVALID_ARGUMENT');
    if (this.busyTabs.has(tabId)) fail('APPROVAL_REQUIRED');
    const capabilities = [...this.adapter.capabilities()];
    this.approving.add(requestId);
    this.busyTabs.add(tabId);
    const generation = this.generation;
    let grant;
    let reused = false;
    const checkApproval = () => {
      if (this.generation !== generation || request.expires_at <= this.now() ||
          !this.pending.has(requestId) || (grant && this.grants.get(grant.target_id) !== grant)) {
        fail('APPROVAL_REQUIRED');
      }
      if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
      checkBinding(request, this.connection);
    };
    try {
      const tab = await this.adapter.selectedTabById(tabId);
      checkApproval();
      await this.adapter.inspect(tab.id, this.protectedOrigins());
      checkApproval();
      grant = [...this.grants.values()].find(existing => existing.tabId === tab.id);
      if (grant && (grant.client_id !== request.client_id || grant.state !== 'active')) fail('APPROVAL_REQUIRED');
      reused = Boolean(grant);
      if (!grant) grant = { ...request, target_id: crypto.randomUUID(), tabId: tab.id, state: 'preparing',
        capabilities: [...capabilities], protected_origins: this.protectedOrigins(),
        documentGeneration: 0, queue: [], running: false, generation };
      this.grants.set(grant.target_id, grant);
      checkApproval();
      if (!reused) {
        await this.adapter.protect(tab.id, grant.protected_origins);
        checkApproval();
        await this.adapter.inspect(tab.id, grant.protected_origins);
        checkApproval();
        await this.adapter.attach(tab.id);
        checkApproval();
      }
      const signature = await sign(this.record.privateKey, grantPayload({
        ...request, origin: this.config.service_origin, target_id: grant.target_id, tab_id: tab.id, capabilities,
      }));
      checkApproval();
      if (!reused) grant.state = 'awaiting_ack';
      grant.ackDeadline = this.now() + 10_000;
      this.send({ type: 'grant.approve', request_id: requestId, client_id: request.client_id,
        target_id: grant.target_id, tab_id: tab.id, policy_id: POLICY_ID, nonce: request.nonce, capabilities, signature });
      this.pending.delete(requestId);
      void this.adapter.closeRequestWindow?.(requestId);
      this.changed();
    } catch (error) {
      if (grant && !reused && grant.client_id === request.client_id) {
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
      this.busyTabs.delete(tabId);
    }
  }

  deny(requestId) {
    if (!this.pending.has(requestId)) fail('APPROVAL_REQUIRED');
    this.send({ type: 'approval.deny', request_id: requestId });
    this.pending.delete(requestId);
    void this.adapter.closeRequestWindow?.(requestId);
    this.changed();
  }

  async end(targetId, reason, announce = true, retainProtection = false) {
    if (!END_REASONS.has(reason)) fail('INVALID_ARGUMENT');
    const grant = this.grants.get(targetId);
    if (!grant) return;
    // Disable authority synchronously, before any browser/API cleanup awaits.
    this.grants.delete(targetId);
    grant.state = 'ended';
    void this.adapter.closeActionWindow?.(targetId);
    const indicatorToken = grant.indicatorCleanupToken || grant.indicatorToken;
    grant.indicatorToken = null;
    this.changed();
    for (const queued of grant.queue.splice(0)) {
      queued.cancelled = true;
      queued.abort?.();
      this.result(queued.message, { code: queued.state === 'executing' ? 'OUTCOME_UNKNOWN' : 'APPROVAL_REQUIRED' });
    }
    if (announce && this.connection) {
      try {
        this.send({ type: 'grant.end', target_id: targetId,
          reason: LOCAL_END_REASONS.has(reason) ? reason : 'HANDOFF' });
      } catch (error) {
        this.report(error);
      }
    }
    this.busyTabs.add(grant.tabId);
    const cleanup = this.adapter.release(grant.tabId, { retainProtection, indicatorToken });
    this.teardowns.add(cleanup);
    try {
      await cleanup;
    } catch (error) {
      this.report(error);
    } finally {
      this.teardowns.delete(cleanup);
      // An in-progress approval still owns this tab until its own finally block.
      this.busyTabs.delete(grant.tabId);
    }
    if (reason === 'HANDOFF') this.notify('Human handoff required',
      'This protected page cannot be shared. Prior/scheduled JavaScript is not undone.');
    else if (['OUTCOME_UNKNOWN', 'BROWSER_OFFLINE', 'CAPABILITY_UNAVAILABLE'].includes(reason)) {
      this.notify('Browser control ended',
        `${reason}. The tab remains open. Prior/scheduled JavaScript is not undone. Fresh local approval is required.`);
    }
    this.changed();
  }

  async updateIndicator(grant) {
    if (grant.state !== 'active' || this.grants.get(grant.target_id) !== grant || !this.adapter.indicator) return;
    const token = crypto.randomUUID();
    const documentGeneration = grant.documentGeneration;
    grant.indicatorToken = token;
    grant.indicatorCleanupToken = token;
    try {
      const document = await this.adapter.indicator(grant.tabId, {
        target_id: grant.target_id, token, label: grant.client_label,
        command: grant.queue[0] ? {
          request_id: grant.queue[0].message.request_id, description: grant.queue[0].message.description,
          operation: grant.queue[0].message.operation, state: grant.queue[0].state,
        } : null,
      });
      if (!document) {
        if (grant.indicatorToken === token) {
          grant.indicatorToken = null;
          grant.indicatorUnavailable = false;
          this.changed();
        }
        return;
      }
      if (this.grants.get(grant.target_id) !== grant || grant.documentGeneration !== documentGeneration ||
          grant.indicatorToken !== token) {
        await this.adapter.removeIndicator?.(grant.tabId, token);
        return;
      }
      grant.indicatorDocument = document;
      grant.indicatorUnavailable = false;
      this.changed();
    } catch {
      if (this.grants.get(grant.target_id) === grant && grant.documentGeneration === documentGeneration &&
          grant.indicatorToken === token) {
        grant.indicatorUnavailable = true;
        this.report(new Error('INDICATOR_UNAVAILABLE'));
      }
    }
  }

  pageGrant(message, sender, extensionId) {
    const grant = this.grants.get(message?.target_id);
    if (!['page.stop', 'page.decision'].includes(message?.type) || sender?.id !== extensionId || sender.frameId !== 0 ||
        !grant || grant.state !== 'active' || sender.tab?.id !== grant.tabId ||
        !grant.indicatorToken || message.token !== grant.indicatorToken ||
        !grant.indicatorDocument || sender.url !== grant.indicatorDocument.url ||
        (grant.indicatorDocument.documentId && sender.documentId !== grant.indicatorDocument.documentId)) fail('NOT_AUTHORIZED');
    return grant;
  }

  stopFromPage(message, sender, extensionId) {
    if (message?.type !== 'page.stop') fail('NOT_AUTHORIZED');
    return this.end(this.pageGrant(message, sender, extensionId).target_id, 'OWNER_PAUSED');
  }

  decisionFromPage(message, sender, extensionId) {
    const grant = this.pageGrant(message, sender, extensionId);
    if (message.type !== 'page.decision') fail('NOT_AUTHORIZED');
    return this.decide(grant.target_id, message.request_id, message.action);
  }

  result(message, error, result) {
    if (!this.connection || message.epoch !== this.connection.epoch ||
        message.tenant_id !== this.connection.tenant_id ||
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
      message = { ...message, expires_at: localDeadline(message, 'wait_timeout_ms', HUMAN_WAIT_MS, this.now()) };
      grant = this.grants.get(message.target_id);
      if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
      validateCommand(message, grant, this.connection, this.protectedOrigins(), this.now());
      if (grant.queue.length >= MAX_QUEUE) fail('QUEUE_FULL');
      if (grant.seen?.has(message.request_id)) fail('INVALID_MESSAGE');
      grant.seen ||= new Set();
      if (grant.seen.size >= 10_000) fail('QUEUE_FULL');
      grant.seen.add(message.request_id);
      grant.queue.push({ message, deadline: message.expires_at, state: 'pending',
        documentGeneration: grant.documentGeneration });
      this.present(grant);
    } catch (error) {
      this.result(message, { code: errorCode(error) });
    }
  }

  present(grant) {
    const queued = grant.queue[0];
    if (queued?.state === 'pending' && grant.allowAll && queued.message.operation !== 'request_handoff') {
      try { this.decide(grant.target_id, queued.message.request_id, 'approve'); }
      catch (error) { this.report(error); }
    }
    if (queued?.state === 'pending' && grant.presentedRequest !== queued.message.request_id) {
      grant.presentedRequest = queued.message.request_id;
      void this.adapter.actionWindow?.(grant.target_id).catch(() => this.report(new Error('INDICATOR_UNAVAILABLE')));
    } else if (!queued) {
      grant.presentedRequest = null;
      void this.adapter.closeActionWindow?.(grant.target_id);
    }
    void this.updateIndicator(grant);
    this.changed();
  }

  decide(targetId, requestId, action) {
    const grant = this.grants.get(targetId);
    const queued = grant?.queue[0];
    if (!grant || grant.state !== 'active' || queued?.message.request_id !== requestId ||
        queued.state !== 'pending') fail('APPROVAL_REQUIRED');
    if (!['approve', 'decline', 'allow_all', 'done'].includes(action)) fail('INVALID_ARGUMENT');
    const human = queued.message.operation === 'request_handoff';
    if ((human && !['done', 'decline'].includes(action)) ||
        (!human && action === 'done')) fail('INVALID_ARGUMENT');
    if (action === 'decline') {
      this.finishQueued(grant, queued, { code: 'ACTION_DECLINED' });
      return;
    }
    try {
      validateCommand(queued.message, grant, this.connection, this.protectedOrigins(), this.now());
      if (!followsNavigation(queued.message.operation) && queued.documentGeneration !== grant.documentGeneration) fail('TARGET_STALE');
      if (followsNavigation(queued.message.operation)) queued.documentGeneration = grant.documentGeneration;
      if (action === 'allow_all') grant.allowAll = true;
      queued.state = 'ready';
      this.send({ type: 'command.ready', request_id: requestId, target_id: targetId });
      this.present(grant);
    } catch (error) {
      this.finishQueued(grant, queued, { code: errorCode(error) });
    }
  }

  finishQueued(grant, queued, error, value) {
    if (queued.cancelled || !grant.queue.includes(queued)) return;
    grant.queue.splice(grant.queue.indexOf(queued), 1);
    this.result(queued.message, error, value);
    this.present(grant);
  }

  cancelCommand(message) {
    id(message.request_id);
    id(message.target_id);
    const grant = this.grants.get(message.target_id);
    const queued = grant?.queue.find(item => item.message.request_id === message.request_id);
    if (!queued) return;
    if (queued.state === 'executing') {
      void this.end(grant.target_id, 'OUTCOME_UNKNOWN');
    } else {
      queued.cancelled = true;
      grant.queue.splice(grant.queue.indexOf(queued), 1);
      this.present(grant);
    }
  }

  executeReady(message) {
    id(message.request_id);
    id(message.target_id);
    const grant = this.grants.get(message.target_id);
    const queued = grant?.queue[0];
    // Late execute after local cancellation/stop never revives authority.
    if (!queued || queued.message.request_id !== message.request_id) return;
    if (queued.state !== 'ready') fail('APPROVAL_REQUIRED');
    let deadline;
    try {
      deadline = localDeadline(message, 'execution_timeout_ms', EXECUTION_MS, this.now());
      if (deadline > this.now() + EXECUTION_MS) fail('INVALID_MESSAGE');
    } catch (error) {
      this.report(error);
      this.finishQueued(grant, queued, { code: errorCode(error) });
      return;
    }
    if (queued.deadline <= this.now() || deadline <= this.now()) {
      this.finishQueued(grant, queued, { code: 'COMMAND_EXPIRED' });
      return;
    }
    if (!followsNavigation(queued.message.operation) &&
        queued.documentGeneration !== grant.documentGeneration) {
      this.finishQueued(grant, queued, { code: 'TARGET_STALE' });
      return;
    }
    queued.executionDeadline = deadline;
    queued.state = 'executing';
    this.present(grant);
    void this.runCommand(grant, queued);
  }

  async runCommand(grant, queued) {
    const { message } = queued;
    let timer;
    const checkCurrent = (after = false) => {
      if (queued.cancelled || this.grants.get(grant.target_id) !== grant ||
          this.generation !== grant.generation) fail('APPROVAL_REQUIRED');
      if (this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
      checkBinding(message, this.connection);
      if (this.now() >= queued.executionDeadline) fail('OUTCOME_UNKNOWN');
      if (!followsNavigation(message.operation) &&
          (!after || !['navigate', 'click', 'type_text', 'select_option', 'set_checked', 'press_key'].includes(message.operation)) &&
          grant.documentGeneration !== queued.documentGeneration) fail('TARGET_STALE');
    };
    try {
      checkCurrent();
      if (message.operation === 'request_handoff') {
        this.finishQueued(grant, queued, null, { state: 'completed', user_confirmed: true });
        return;
      }
      const execution = this.adapter.execute(grant, message.operation, message.args, checkCurrent);
      const timeout = new Promise((_, reject) => {
        queued.abort = () => reject(new Error('APPROVAL_REQUIRED'));
        timer = setTimeout(() => reject(new Error('OUTCOME_UNKNOWN')),
          Math.max(1, queued.executionDeadline - this.now()));
      });
      const value = await Promise.race([execution, timeout]);
      checkCurrent(true);
      this.finishQueued(grant, queued, null, boundedResult(value));
    } catch (error) {
      const code = errorCode(error);
      if (!queued.cancelled && this.grants.get(grant.target_id) === grant) {
        // Invalidate authority before advancing another queued action.
        if (code === 'OUTCOME_UNKNOWN' || code === 'PAGE_UNAVAILABLE') {
          this.result(message, { code });
          grant.queue.splice(grant.queue.indexOf(queued), 1);
          await this.end(grant.target_id, code === 'PAGE_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : 'OUTCOME_UNKNOWN');
        } else this.finishQueued(grant, queued, { code, ...waitErrorDetails(error) });
      }
    } finally {
      clearTimeout(timer);
      queued.abort = null;
    }
  }

  tabEvent(tabId, type, url) {
    for (const grant of this.grants.values()) {
      if (grant.tabId !== tabId) continue;
      if (type === 'navigation') {
        grant.documentGeneration++;
        grant.indicatorToken = null;
        grant.indicatorDocument = null;
        for (const queued of [...grant.queue]) {
          if (queued.state !== 'executing' && !followsNavigation(queued.message.operation)) {
            this.finishQueued(grant, queued, { code: 'TARGET_STALE' });
          }
        }
        if (url) {
          let protectedPage = true;
          let protectedOrigin = false;
          try {
            const page = new URL(url);
            protectedOrigin = this.protectedOrigins().includes(page.origin);
            protectedPage = !['http:', 'https:'].includes(page.protocol) || protectedOrigin;
          } catch (error) {
            this.report(error);
          }
          if (protectedPage) {
            void this.end(grant.target_id, 'HANDOFF', true, protectedOrigin);
          }
        }
      } else if (type === 'complete') {
        void this.updateIndicator(grant);
      } else {
        let reason = 'OWNER_PAUSED';
        if (type === 'protected_pending') reason = 'HANDOFF';
        else if (type === 'closed') reason = 'TARGET_CLOSED';
        void this.end(grant.target_id, reason, true, type === 'protected_pending');
      }
    }
  }

  tick() {
    const enrollment = this.record?.enrollment;
    if (enrollment && !this.enrollmentPolling && enrollment.expires_at > this.now() &&
        this.now() - this.lastEnrollmentPoll >= 2000) {
      this.enrollmentPolling = true;
      this.lastEnrollmentPoll = this.now();
      void this.enrollmentStatus().catch(error => {
        if (this.record?.enrollment === enrollment) this.report(error);
      }).finally(() => { this.enrollmentPolling = false; });
    }
    if (this.socket && this.now() - this.lastPing >= LIVENESS_MS) {
      this.loseConnection(this.socket, this.generation);
    }
    for (const [requestId, request] of this.pending) {
      if (request.expires_at <= this.now()) {
        this.pending.delete(requestId);
        void this.adapter.closeRequestWindow?.(requestId);
        this.changed();
      }
    }
    for (const grant of this.grants.values()) {
      for (const queued of [...grant.queue]) {
        if (queued.state !== 'executing' && queued.deadline <= this.now()) {
          this.finishQueued(grant, queued, { code: 'COMMAND_EXPIRED' });
        }
      }
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
    for (const requestId of this.pending.keys()) void this.adapter.closeRequestWindow?.(requestId);
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
    else this.generation++;
    for (const requestId of this.pending.keys()) void this.adapter.closeRequestWindow?.(requestId);
    this.pending.clear();
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
