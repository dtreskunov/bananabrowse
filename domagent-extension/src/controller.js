import {
  VERSION, POLICY_ID, LIVENESS_MS, WORKSPACE_LEASE_MS, WORKSPACE_TAB_LIMIT, WORKSPACE_CONCURRENCY,
  authPayload, workspacePayload, serviceOrigin, tenantId, sign, pairingStartPayload, pairingStatusPayload,
  pairingConfirmPayload, pairingCancelPayload, validBrowserInfo, validDescription, OPERATIONS,
  navigationUrl, inspectionErrorDetails, waitErrorDetails, validOperationArgs,
} from '../../shared/protocol.js';
import { boundedResult, checkBinding, errorCode, fail, id, originList, protectedUnion } from './security.js';
import { ActivityHistory } from './activity.js';

export class Controller {
  constructor({ adapter, keys, storage, extensionUrl, Socket = WebSocket,
    fetcher = (...args) => fetch(...args), now = () => Date.now(), changed = () => {},
    notify = async () => {}, clearNotification = async () => {} }) {
    Object.assign(this, { adapter, keys, storage, Socket, fetcher, now, changed, notify, clearNotification });
    const url = new URL(extensionUrl);
    this.extension_origin = `${url.protocol}//${url.host}`;
    this.config = { service_origin: '', enabled: false, local_protected_origins: [] };
    this.record = null;
    this.pairing = null;
    this.savedConnections = [];
    this.connection = null;
    this.socket = null;
    this.generation = 0;
    this.phase = 'disconnected';
    this.lastPing = 0;
    this.workspaces = new Map();
    this.failures = [];
    this.syncing = false;
    this.notificationTasks = new Map();
    this.endingTasks = new Set();
    this.history = new ActivityHistory(storage, () => this.report(new Error('HISTORY_UNAVAILABLE')));
    this.adapter.onWarning = error => this.report(error);
    this.adapter.onPanelClosed = windowId => {
      for (const workspace of this.workspaces.values()) {
        if (workspace.windowId === windowId) void this.stopWorkspace(workspace, 'inactive').catch(error => this.report(error));
      }
    };
    this.adapter.onGroupsChanged = () => { void this.refresh().catch(error => this.report(error)); };
    this.adapter.onTabEvent = (tabId, event) => {
      for (const workspace of this.workspaces.values()) {
        const tab = [...workspace.tabs.values()].find(tab => tab.tabId === tabId);
        if (!tab) continue;
        if (event === 'closed' || event === 'detached' || event === 'protected_pending') {
          this.dropTab(workspace, tab, 'TAB_NOT_IN_WORKSPACE', event === 'protected_pending');
          void this.sync(workspace).catch(error => this.report(error));
        } else if (event === 'navigation') {
          tab.documentGeneration++;
          tab.pageState = 'loading';
          for (const task of [...tab.queue]) {
            if (task.executing) continue;
            if (!['wait_for_page', 'request_handoff'].includes(task.message.operation)) {
              const freshRead = !task.executing && !task.ready &&
                ['get_text', 'get_page_snapshot', 'get_interactive_elements', 'inspect_element', 'get_screenshot'].includes(task.message.operation) &&
                !task.message.args.ref && !task.message.args.document;
              if (freshRead) task.documentGeneration = tab.documentGeneration;
              else this.finishTask(workspace, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : 'TARGET_STALE' });
            }
          }
        }
      }
    };
  }

  report(error) {
    const code = errorCode(error);
    console.error('DomAgent:', code);
    this.failures = [...this.failures.slice(-4), code];
    this.changed();
  }

  async initialize() {
    this.browserInfo = await this.adapter.browserInfo();
    if (!validBrowserInfo(this.browserInfo)) fail('INVALID_MESSAGE');
    await this.history.load();
    const saved = await this.storage.get(['config', 'savedConnections']);
    this.savedConnections = Array.isArray(saved.savedConnections) ? saved.savedConnections.slice(0, 32) : [];
    if (saved.config?.service_origin) {
      this.config = { ...saved.config, service_origin: serviceOrigin(saved.config.service_origin),
        local_protected_origins: originList(saved.config.local_protected_origins || []) };
      if (this.config.tenant_id) this.record = await this.keys.get(this.config.service_origin, tenantId(this.config.tenant_id));
    }
    await this.adapter.initialize();
    this.timer = setInterval(() => { void this.tick().catch(error => this.report(error)); }, 1000);
    if (this.config.enabled && this.record?.identity) this.connect();
    this.changed();
  }

  protectedOrigins() {
    return this.config.service_origin ? protectedUnion(this.config.service_origin,
      this.config.local_protected_origins, this.record?.protected_origins || []) : [];
  }

  snapshot() {
    return {
      config: this.config, phase: this.phase, browser_info: this.browserInfo,
      identity: this.record?.identity || null, saved_connections: this.savedConnections,
      pairing: this.pairing ? { code: this.pairing.code, expires_at: this.pairing.expires_at,
        state: this.pairing.state, proposal: this.pairing.proposal } : null,
      failures: this.failures, activity: this.history.entries, history_unavailable: this.history.unavailable,
      workspaces: [...this.workspaces.values()].map(workspace => ({
        workspace_id: workspace.id, windowId: workspace.windowId, groupId: workspace.groupId,
        state: workspace.state, tabs: [...workspace.tabs.values()].map(tab => ({
          target_id: tab.targetId, tabId: tab.tabId, title: tab.title, url: tab.url,
          page_state: tab.pageState, commands: tab.queue.map(task => ({
            request_id: task.message.request_id, operation: task.message.operation,
            description: task.message.description, human: task.human, executing: task.executing,
          })),
        })),
      })),
      pending_human: [...this.notificationTasks.values()].map(({ workspace, tab, task }) => ({
        request_id: task.message.request_id, workspace_id: workspace.id, tabId: tab.tabId,
        description: task.message.description,
      })),
    };
  }

  async configure(value) {
    let candidate = value.service_origin.trim();
    if (!candidate.includes('://')) candidate = `https://${candidate}`;
    const origin = serviceOrigin(candidate);
    await this.disconnect();
    this.config = { service_origin: origin, enabled: false,
      local_protected_origins: originList(value.local_protected_origins || []) };
    this.record = null;
    this.pairing = null;
    await this.storage.set({ config: this.config });
    this.changed();
  }

  async api(action, body) {
    if (body) {
      const fields = action === 'start'
        ? ['request_id', 'key_id', 'public_key', 'extension_origin', 'pairing_code', 'receipt', 'nonce', 'label', 'signature']
        : action === 'confirm' ? ['request_id', 'key_id', 'receipt', 'signature', 'proposal_id', 'tenant_id', 'client_id', 'nonce']
          : ['request_id', 'key_id', 'receipt', 'signature'];
      body = Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
    }
    const response = await this.fetcher(`${this.config.service_origin}/api/pairing/${action}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'X-DomAgent-Extension-Origin': this.extension_origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    if (raw.length > 16384) fail('INVALID_MESSAGE');
    const value = JSON.parse(raw);
    if (!response.ok) fail(value.error || 'PAIRING_UNAVAILABLE');
    return value;
  }

  async beginPairing() {
    if (!this.config.service_origin || this.connection) fail('NOT_AUTHORIZED');
    if (this.pairing) await this.cancelPairing();
    const record = await this.keys.pending(this.config.service_origin);
    const challenge = await this.api('challenge');
    if (challenge.origin !== this.config.service_origin || typeof challenge.nonce !== 'string') fail('INVALID_MESSAGE');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const code = [...crypto.getRandomValues(new Uint8Array(8))].map(value => alphabet[value % 32]).join('');
    const receipt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const request = { origin: this.config.service_origin, request_id: crypto.randomUUID(), key_id: record.key_id,
      public_key: record.public_key, extension_origin: this.extension_origin, label: 'My browser',
      pairing_code: code, receipt, nonce: challenge.nonce };
    request.signature = await sign(record.privateKey, pairingStartPayload(request));
    const result = await this.api('start', request);
    if (result.request_id !== request.request_id || !Number.isFinite(result.expires_at) ||
        result.expires_at <= this.now() || result.expires_at > this.now() + 300000) fail('INVALID_MESSAGE');
    this.pairing = { ...request, record, code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: result.expires_at, state: 'pending' };
    this.changed();
  }

  async pairingStatus() {
    const pairing = this.pairing;
    if (!pairing || pairing.expires_at <= this.now()) fail('PAIRING_UNAVAILABLE');
    const proof = { origin: this.config.service_origin, request_id: pairing.request_id,
      key_id: pairing.key_id, receipt: pairing.receipt };
    const result = await this.api('status', { ...proof,
      signature: await sign(pairing.record.privateKey, pairingStatusPayload(proof)) });
    if (this.pairing !== pairing) return;
    if (!['pending', 'proposed', 'confirmed'].includes(result.state)) fail('INVALID_MESSAGE');
    pairing.state = result.state;
    if (result.state === 'proposed') {
      const proposal = result.proposed || result;
      id(proposal.proposal_id); tenantId(proposal.tenant_id); id(proposal.client_id); id(proposal.nonce);
      if (typeof proposal.client_label !== 'string' || [...proposal.client_label].length > 80) fail('INVALID_MESSAGE');
      pairing.proposal = { proposal_id: proposal.proposal_id, tenant_id: proposal.tenant_id,
        client_id: proposal.client_id, client_label: proposal.client_label, nonce: proposal.nonce };
    }
    this.changed();
  }

  async confirmPairing() {
    const pairing = this.pairing;
    if (!pairing?.proposal || pairing.expires_at <= this.now()) fail('PAIRING_UNAVAILABLE');
    const proof = { ...pairing.proposal, origin: this.config.service_origin, request_id: pairing.request_id,
      key_id: pairing.key_id, receipt: pairing.receipt };
    const identity = await this.api('confirm', { ...proof,
      signature: await sign(pairing.record.privateKey, pairingConfirmPayload(proof)) });
    if (this.pairing !== pairing || identity.tenant_id !== proof.tenant_id ||
        identity.client_id !== proof.client_id) fail('NOT_AUTHORIZED');
    id(identity.device_id);
    const record = await this.keys.bind(pairing.record, identity);
    record.protected_origins = protectedUnion(this.config.service_origin, identity.protected_origins);
    await this.keys.save(record);
    this.record = record;
    this.config = { ...this.config, tenant_id: identity.tenant_id, enabled: true };
    this.savedConnections = [...this.savedConnections.filter(saved => saved.tenant_id !== identity.tenant_id ||
      saved.origin !== this.config.service_origin), { origin: this.config.service_origin,
      tenant_id: identity.tenant_id, label: identity.client_label }].slice(-32);
    await this.storage.set({ config: this.config, savedConnections: this.savedConnections });
    this.pairing = null;
    this.connect();
    this.changed();
  }

  async cancelPairing() {
    const pairing = this.pairing;
    if (!pairing) return;
    const proof = { origin: this.config.service_origin, request_id: pairing.request_id,
      key_id: pairing.key_id, receipt: pairing.receipt };
    await this.api('cancel', { ...proof,
      signature: await sign(pairing.record.privateKey, pairingCancelPayload(proof)) });
    this.pairing = null;
    this.changed();
  }

  async enable() {
    if (!this.record?.identity) fail('NOT_AUTHORIZED');
    this.config.enabled = true;
    await this.storage.set({ config: this.config });
    this.connect();
  }

  async switchConnection(origin, tenant) {
    if (!this.savedConnections.some(saved => saved.origin === origin && saved.tenant_id === tenant)) fail('NOT_AUTHORIZED');
    await this.disconnect();
    const record = await this.keys.get(origin, tenant);
    if (!record.identity) fail('NOT_AUTHORIZED');
    this.config = { ...this.config, service_origin: origin, tenant_id: tenant, enabled: true };
    this.record = record;
    this.workspaces.clear();
    await this.storage.set({ config: this.config });
    this.connect();
  }

  connect() {
    if (this.socket || !this.config.enabled || !this.record?.identity) return;
    const generation = ++this.generation;
    const socket = new this.Socket(`${this.config.service_origin.replace('https:', 'wss:')}/extension/${this.config.tenant_id}`);
    this.socket = socket; this.phase = 'connecting'; this.lastPing = this.now();
    let messages = Promise.resolve();
    socket.onopen = () => {
      if (!this.current(socket, generation)) return;
      this.phase = 'authenticating';
      socket.send(JSON.stringify({ type: 'hello', version: VERSION, tenant_id: this.config.tenant_id,
        key_id: this.record.key_id, browser_info: this.browserInfo }));
    };
    socket.onmessage = event => {
      messages = messages.then(() => this.receive(event.data, socket, generation)).catch(error => {
        this.report(error); this.loseConnection(socket, generation);
      });
    };
    socket.onclose = socket.onerror = () => this.loseConnection(socket, generation);
    this.changed();
  }

  current(socket, generation) { return this.socket === socket && this.generation === generation; }
  send(message) {
    if (!this.connection || this.socket?.readyState !== 1 || this.now() - this.lastPing >= LIVENESS_MS) fail('BROWSER_OFFLINE');
    this.socket.send(JSON.stringify({ ...message, tenant_id: this.config.tenant_id }));
  }

  async receive(raw, socket, generation) {
    if (!this.current(socket, generation)) return;
    if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) fail('INVALID_MESSAGE');
    const message = JSON.parse(raw);
    if (message.tenant_id !== this.config.tenant_id) fail('NOT_AUTHORIZED');
    if (message.type === 'challenge') {
      if (this.phase !== 'authenticating' || message.origin !== this.config.service_origin ||
          message.key_id !== this.record.key_id) fail('NOT_AUTHORIZED');
      id(message.epoch); id(message.connection_id); id(message.nonce);
      this.challenge = message; this.phase = 'proving';
      const signature = await sign(this.record.privateKey, authPayload(message));
      if (this.current(socket, generation)) socket.send(JSON.stringify({ type: 'proof',
        tenant_id: this.config.tenant_id, signature }));
      return;
    }
    if (message.type === 'authenticated') {
      if (this.phase !== 'proving' || message.device_id !== this.record.identity.device_id) fail('NOT_AUTHORIZED');
      checkBinding(message, this.challenge); id(message.client_id);
      if (typeof message.client_label !== 'string' || !message.client_label ||
          [...message.client_label].length > 80) fail('INVALID_MESSAGE');
      this.connection = { epoch: message.epoch, connection_id: message.connection_id, tenant_id: message.tenant_id,
        client_id: message.client_id, client_label: message.client_label };
      this.record.protected_origins = protectedUnion(this.config.service_origin, message.protected_origins);
      this.record.identity = { ...this.record.identity, client_id: message.client_id, client_label: message.client_label };
      await this.keys.save(this.record);
      if (!this.current(socket, generation)) return;
      this.phase = 'authenticated'; this.lastPing = this.now(); this.history.record('connected'); this.changed();
      return;
    }
    if (!this.connection) fail('NOT_AUTHORIZED');
    if (message.type === 'ping') { this.lastPing = this.now(); this.send({ type: 'pong' }); return; }
    if (message.type === 'workspace.active') {
      const workspace = this.workspaces.get(message.workspace_id);
      if (workspace && workspace.activationId === message.activation_id && message.revision === workspace.revision) {
        workspace.ackRevision = message.revision;
        this.changed();
      }
      return;
    }
    if (message.type === 'command') { this.enqueue(message); return; }
    if (message.type === 'command.execute') { void this.executeReady(message).catch(error => this.report(error)); return; }
    if (message.type === 'command.cancel') {
      for (const workspace of this.workspaces.values()) for (const tab of [null, ...workspace.tabs.values()]) {
        const task = (tab?.queue || workspace.tasks).find(task => task.message.request_id === message.request_id);
        if (task) this.finishTask(workspace, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_CANCELLED' });
      }
      return;
    }
    if (message.type === 'workspace.end') {
      const workspace = this.workspaces.get(message.workspace_id);
      if (workspace) await this.stopWorkspace(workspace, 'inactive');
      return;
    }
    if (message.type === 'error') fail(message.code || 'NOT_AUTHORIZED');
    fail('INVALID_MESSAGE');
  }

  async startWorkspace(windowId) {
    if (!this.connection) fail('BROWSER_OFFLINE');
    if (!await this.adapter.panelOpen(windowId)) fail('PANEL_OPEN_REQUIRED');
    await this.adapter.permissions();
    await Promise.all([...this.endingTasks]);
    let workspace = [...this.workspaces.values()].find(workspace => workspace.windowId === windowId);
    if (!workspace) {
      const created = await this.adapter.makeGroup(windowId, this.connection.client_label);
      workspace = { id: crypto.randomUUID(), groupId: created.groupId, windowId,
        activationId: crypto.randomUUID(), state: 'inactive', revision: 0, ackRevision: 0,
        tabs: new Map(), excluded: new Set(), previouslyExcluded: new Set(), tasks: [], running: 0, seen: new Set() };
      this.workspaces.set(workspace.id, workspace);
    }
    if (workspace.state === 'active') return;
    workspace.activationId = crypto.randomUUID();
    workspace.state = 'active'; workspace.localLease = this.now() + WORKSPACE_LEASE_MS;
    await this.refreshWorkspace(workspace);
    await this.sync(workspace);
    await this.adapter.api.tabGroups.update(workspace.groupId, { color: 'blue', collapsed: false });
    this.changed();
  }

  async sync(workspace) {
    if (!this.connection) return;
    const connection = this.connection;
    const message = {
      origin: this.config.service_origin, ...connection, workspace_id: workspace.id,
      activation_id: workspace.activationId, group_id: workspace.groupId, window_id: workspace.windowId,
      state: workspace.state, revision: ++workspace.revision,
      lease_ms: WORKSPACE_LEASE_MS,
      tabs: workspace.state === 'active' ? [...workspace.tabs.values()].sort((a, b) => a.tabId - b.tabId).map(tab => ({
        target_id: tab.targetId, tab_id: tab.tabId, title: tab.title, url: tab.url,
        page_state: tab.pageState, capabilities: tab.pageState === 'navigation_only' || tab.pageState === 'unavailable'
          ? ['navigate'] : [...this.adapter.capabilities()],
      })) : [],
    };
    const signature = await sign(this.record.privateKey, workspacePayload(message));
    if (this.connection !== connection || this.workspaces.get(workspace.id) !== workspace ||
        workspace.revision !== message.revision || workspace.state !== message.state ||
        workspace.activationId !== message.activation_id) return;
    this.send({ ...message, type: 'workspace.sync', signature });
    return message.revision;
  }

  async refreshWorkspace(workspace) {
    if (workspace.refreshing) return workspace.refreshing;
    const work = this.scanWorkspace(workspace);
    workspace.refreshing = work;
    try { await work; } finally { if (workspace.refreshing === work) workspace.refreshing = null; }
  }

  async scanWorkspace(workspace) {
    if (workspace.state !== 'active') return;
    const activation = workspace.activationId;
    if (!await this.adapter.panelOpen(workspace.windowId)) { await this.stopWorkspace(workspace, 'inactive'); return; }
    const group = await this.adapter.api.tabGroups.get(workspace.groupId);
    if (group.windowId !== workspace.windowId) { await this.stopWorkspace(workspace, 'inactive'); return; }
    const tabs = await this.adapter.api.tabs.query({ groupId: workspace.groupId });
    for (const [tabId, tab] of workspace.tabs) {
      if (!tabs.some(current => current.id === tabId)) this.dropTab(workspace, tab, 'TAB_NOT_IN_WORKSPACE');
    }
    for (const excluded of workspace.excluded) {
      if (!tabs.some(tab => tab.id === excluded)) workspace.previouslyExcluded.add(excluded);
    }
    for (const current of tabs) {
      if (workspace.tabs.has(current.id)) {
        const tab = workspace.tabs.get(current.id);
        const currentUrl = current.pendingUrl || current.url || '';
        if (/^https?:/.test(currentUrl)) {
          try { navigationUrl(currentUrl, this.protectedOrigins()); }
          catch {
            this.dropTab(workspace, tab, 'HANDOFF_REQUIRED');
            continue;
          }
          if (this.adapter.browserName === 'chrome' && !this.adapter.attached.has(tab.tabId)) {
            await this.adapter.attach(tab.tabId);
          }
        }
        tab.title = (current.title || 'Untitled').slice(0, 160);
        const navigatingOld = tab.navigation && currentUrl === tab.navigation.from && currentUrl !== tab.navigation.url;
        if (!navigatingOld) tab.url = currentUrl.slice(0, 2048);
        if (navigatingOld) continue;
        if (!/^https?:/.test(currentUrl)) tab.pageState = 'navigation_only';
        else if ((tab.pageState === 'loading' || tab.pageState === 'navigation_only') && current.status === 'complete') {
          tab.pageState = 'ready';
        }
        continue;
      }
      if (this.adapter.createdTabs.has(current.id)) workspace.excluded.add(current.id);
      if (workspace.previouslyExcluded.has(current.id)) {
        workspace.excluded.delete(current.id); this.adapter.createdTabs.delete(current.id);
      }
      if (workspace.excluded.has(current.id)) continue;
      if (workspace.tabs.size >= WORKSPACE_TAB_LIMIT) { this.report(new Error('TAB_LIMIT_REACHED')); continue; }
      const url = current.pendingUrl || current.url || '';
      let ordinary = false;
      try { navigationUrl(url, this.protectedOrigins()); ordinary = true; }
      catch {
        if (/^https?:/.test(url)) continue;
      }
      const tab = { targetId: crypto.randomUUID(), tabId: current.id, groupId: workspace.groupId,
        windowId: workspace.windowId, title: (current.title || 'Untitled').slice(0, 160), url: url.slice(0, 2048),
        pageState: ordinary ? (current.status === 'loading' ? 'loading' : 'ready') : 'navigation_only',
        protected_origins: this.protectedOrigins(), queue: [], documentGeneration: 0 };
      await this.adapter.protect(tab.tabId, tab.protected_origins);
      if (ordinary) await this.adapter.attach(tab.tabId);
      if (workspace.state !== 'active' || workspace.activationId !== activation ||
          !await this.adapter.panelOpen(workspace.windowId)) {
        await this.adapter.release(tab.tabId);
        return;
      }
      workspace.tabs.set(tab.tabId, tab);
      this.adapter.controlledTabs?.add(tab.tabId);
      this.history.record('sharing_started', { target_id: tab.targetId, client_id: this.connection?.client_id });
    }
  }

  async refresh() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const workspace of this.workspaces.values()) {
        try {
          await this.refreshWorkspace(workspace);
          if (workspace.state === 'active') {
            workspace.localLease = this.now() + WORKSPACE_LEASE_MS;
            await this.sync(workspace);
          }
        } catch (error) {
          await this.stopWorkspace(workspace, 'inactive');
          this.report(error);
        }
      }
    } finally { this.syncing = false; this.changed(); }
  }

  dropTab(workspace, tab, code, retainProtection = false) {
    workspace.tabs.delete(tab.tabId);
    this.adapter.controlledTabs?.delete(tab.tabId);
    for (const task of [...tab.queue]) this.finishTask(workspace, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : code });
    const cleanup = this.adapter.release(tab.tabId, { retainProtection }).catch(error => this.report(error));
    this.endingTasks.add(cleanup); void cleanup.finally(() => this.endingTasks.delete(cleanup));
    this.history.record('sharing_ended', { target_id: tab.targetId, code });
  }

  async stopWorkspace(workspace, state = 'inactive') {
    workspace.state = state; workspace.localLease = 0;
    for (const tab of [...workspace.tabs.values()]) this.dropTab(workspace, tab,
      state === 'paused' ? 'WORKSPACE_PAUSED' : 'WORKSPACE_INACTIVE');
    for (const task of [...workspace.tasks]) this.finishTask(workspace, null, task,
      { code: task.executing ? 'OUTCOME_UNKNOWN' : state === 'paused' ? 'WORKSPACE_PAUSED' : 'WORKSPACE_INACTIVE' });
    this.changed();
    await this.sync(workspace);
    await this.adapter.api.tabGroups.update(workspace.groupId, { color: 'grey' });
  }

  check(workspace, tab, task, after = false) {
    if (workspace.state !== 'active') fail(workspace.state === 'paused' ? 'WORKSPACE_PAUSED' : 'WORKSPACE_INACTIVE');
    if (workspace.localLease <= this.now() || !this.connection) fail('WORKSPACE_INACTIVE');
    if (task.message.activation_id !== workspace.activationId || task.message.workspace_id !== workspace.id) fail('WORKSPACE_INACTIVE');
    if (task.cancelled || (tab && workspace.tabs.get(tab.tabId) !== tab)) fail('TAB_NOT_IN_WORKSPACE');
    if (task.deadline <= this.now()) fail(task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_EXPIRED');
    if (tab && task.documentGeneration !== tab.documentGeneration &&
        !['wait_for_page', 'request_handoff'].includes(task.message.operation) &&
        !(after && ['navigate', 'click', 'type_text', 'select_option', 'set_checked', 'press_key'].includes(task.message.operation))) {
      fail('TARGET_STALE');
    }
    checkBinding(task.message, this.connection);
  }

  enqueue(message) {
    const workspace = this.workspaces.get(message.workspace_id);
    let tab, task;
    try {
      if (!workspace || workspace.activationId !== message.activation_id ||
          message.client_id !== this.connection.client_id || workspace.ackRevision === 0) fail('WORKSPACE_INACTIVE');
      if (!validDescription(message.description)) fail('INVALID_ARGUMENT');
      id(message.request_id);
      if (workspace.seen.has(message.request_id)) fail('INVALID_MESSAGE');
      if (workspace.seen.size >= 4096) fail('QUEUE_FULL');
      const create = message.operation === 'create_workspace_tab';
      if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args)) fail('INVALID_ARGUMENT');
      tab = create ? null : [...workspace.tabs.values()].find(tab => tab.targetId === message.target_id);
      if (!create && !tab) fail('TAB_NOT_IN_WORKSPACE');
      if (create) {
        if (message.target_id !== workspace.id || Object.keys(message.args).some(key => key !== 'url')) fail('INVALID_ARGUMENT');
        if (message.args.url !== undefined && typeof message.args.url !== 'string') fail('INVALID_ARGUMENT');
        if (message.args.url) navigationUrl(message.args.url, this.protectedOrigins());
      } else if (!validOperationArgs(message.operation, message.args)) fail('INVALID_ARGUMENT');
      const duration = message.wait_timeout_ms;
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 600000) fail('INVALID_MESSAGE');
      task = { message, human: message.operation === 'request_handoff', deadline: this.now() + duration,
        documentGeneration: tab?.documentGeneration, executing: false, cancelled: false };
      this.check(workspace, tab, task);
      const queue = tab?.queue || workspace.tasks;
      if (queue.length >= 16 || queue.some(old => old.message.request_id === message.request_id)) fail('QUEUE_FULL');
      queue.push(task);
      workspace.seen.add(message.request_id);
      this.history.record('command_requested', { target_id: message.target_id, request_id: message.request_id,
        operation: message.operation });
      if (task.human) {
        this.notificationTasks.set(message.request_id, { workspace, tab, task });
        void this.groupColor(workspace).catch(error => this.report(error));
        void this.notify(message.request_id).catch(error => {
          this.report(error);
          this.finishTask(workspace, tab, task, { code: 'NOTIFICATION_UNAVAILABLE' });
        });
      }
      this.drain(workspace); this.changed();
    } catch (error) { this.result(message, { code: errorCode(error) }); }
  }

  drain(workspace) {
    if (workspace.state !== 'active' || workspace.running >= WORKSPACE_CONCURRENCY) return;
    for (const tab of [null, ...workspace.tabs.values()]) {
      const task = (tab?.queue || workspace.tasks)[0];
      if (!task || task.preparing || task.ready || task.executing || task.human) continue;
      task.preparing = true;
      void this.prepare(workspace, tab, task).catch(error => this.report(error));
    }
  }

  async prepare(workspace, tab, task) {
    try {
      this.check(workspace, tab, task);
      if (!await this.adapter.panelOpen(workspace.windowId)) fail('WORKSPACE_INACTIVE');
      if (tab) {
        task.preview = await this.adapter.prepareAction(tab, task.message.operation, task.message.args,
          () => this.check(workspace, tab, task));
        this.check(workspace, tab, task);
        if (task.documentGeneration !== tab.documentGeneration && task.message.operation !== 'wait_for_page') fail('TARGET_STALE');
      }
      task.ready = true;
      this.send({ type: 'command.ready', request_id: task.message.request_id, target_id: task.message.target_id });
    } catch (error) {
      if (tab && error.code === 'PAGE_UNAVAILABLE') {
        this.finishTask(workspace, tab, task, { code: 'DOCUMENT_NOT_CONTROLLABLE', ...inspectionErrorDetails(error) });
        tab.pageState = 'unavailable'; await this.sync(workspace);
        return;
      }
      this.finishTask(workspace, tab, task, { code: error.code === 'PAGE_UNAVAILABLE'
        ? 'DOCUMENT_NOT_CONTROLLABLE' : errorCode(error), ...inspectionErrorDetails(error) });
    } finally { task.preparing = false; }
  }

  async decide(requestId, action) {
    const entry = this.notificationTasks.get(requestId);
    if (!entry) fail('COMMAND_EXPIRED');
    const { workspace, tab, task } = entry;
    this.check(workspace, tab, task);
    if (action === 'cancel') return this.finishTask(workspace, tab, task, { code: 'ACTION_DECLINED' });
    if (action !== 'done' || tab.queue[0] !== task) fail('INVALID_ARGUMENT');
    task.ready = true;
    this.send({ type: 'command.ready', request_id: requestId, target_id: tab.targetId });
  }

  async executeReady(message) {
    for (const workspace of this.workspaces.values()) {
      for (const tab of [null, ...workspace.tabs.values()]) {
        const task = (tab?.queue || workspace.tasks)[0];
        if (!task || task.message.request_id !== message.request_id || task.message.target_id !== message.target_id) continue;
        if (!task.ready || task.executing || (!task.human && workspace.running >= WORKSPACE_CONCURRENCY)) {
          this.finishTask(workspace, tab, task, { code: 'QUEUE_FULL' }); return;
        }
        if (!Number.isSafeInteger(message.execution_timeout_ms) || message.execution_timeout_ms > (task.human ? 600000 : 25000) ||
            message.execution_timeout_ms <= 0) fail('INVALID_MESSAGE');
        task.deadline = this.now() + message.execution_timeout_ms;
        task.executing = true;
        if (!task.human) workspace.running++;
        let timer;
        try {
          this.check(workspace, tab, task);
          if (!await this.adapter.panelOpen(workspace.windowId)) fail('WORKSPACE_INACTIVE');
          this.check(workspace, tab, task);
          this.history.record('execution_started', { request_id: message.request_id, operation: task.message.operation });
          const operation = task.human ? Promise.resolve({ state: 'completed', user_confirmed: true }) :
            tab ? this.adapter.execute(tab, task.message.operation, task.message.args,
              after => this.check(workspace, tab, task, after), task.preview) : this.createTab(workspace, task);
          const timeout = new Promise((_, reject) => {
            task.abort = () => reject(Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN' }));
            timer = setTimeout(task.abort, message.execution_timeout_ms);
          });
          const value = await Promise.race([operation, timeout]);
          this.check(workspace, tab, task, true);
          if (tab && task.message.operation === 'navigate') await this.sync(workspace);
          this.finishTask(workspace, tab, task, null, boundedResult(value));
        } catch (error) {
          if (tab && error.code === 'PAGE_UNAVAILABLE') {
            this.finishTask(workspace, tab, task, { code: 'DOCUMENT_NOT_CONTROLLABLE', ...inspectionErrorDetails(error) });
            tab.pageState = 'unavailable'; await this.sync(workspace);
          }
          this.finishTask(workspace, tab, task, { code: error.code === 'PAGE_UNAVAILABLE'
            ? 'DOCUMENT_NOT_CONTROLLABLE' : errorCode(error), ...inspectionErrorDetails(error), ...waitErrorDetails(error) });
        } finally {
          clearTimeout(timer); task.abort = null;
          if (!task.human) workspace.running--;
          this.drain(workspace); this.changed();
        }
      }
    }
  }

  async createTab(workspace, task) {
    if (workspace.tabs.size + (workspace.creating || 0) >= WORKSPACE_TAB_LIMIT) fail('TAB_LIMIT_REACHED');
    workspace.creating = (workspace.creating || 0) + 1;
    let created;
    try { created = await this.adapter.api.tabs.create({ windowId: workspace.windowId, url: 'about:blank', active: false }); }
    catch (error) { workspace.creating--; throw error; }
    try {
      this.check(workspace, null, task);
      this.adapter.createdTabs.add(created.id);
      await this.adapter.api.tabs.group({ groupId: workspace.groupId, tabIds: [created.id] });
      this.check(workspace, null, task);
      this.adapter.createdTabs.delete(created.id);
      workspace.excluded.delete(created.id);
      await this.refreshWorkspace(workspace);
      this.check(workspace, null, task);
      const tab = workspace.tabs.get(created.id);
      if (!tab) fail('TAB_NOT_IN_WORKSPACE');
      if (task.message.args.url) await this.adapter.execute(tab, 'navigate', { url: task.message.args.url },
        () => this.check(workspace, null, task));
      const revision = await this.sync(workspace);
      const deadline = this.now() + 3000;
      while (workspace.ackRevision < revision) {
        this.check(workspace, null, task);
        if (this.now() >= deadline) fail('OUTCOME_UNKNOWN');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return { target_id: tab.targetId, tab_handle: tab.targetId, workspace_id: workspace.id };
    } catch (error) {
      const tab = workspace.tabs.get(created.id);
      if (tab) this.dropTab(workspace, tab, 'TAB_NOT_IN_WORKSPACE');
      await this.adapter.api.tabs.remove(created.id);
      throw error;
    } finally {
      workspace.creating--;
    }
  }

  finishTask(workspace, tab, task, error, value) {
    if (task.cancelled) return;
    task.cancelled = true; task.abort?.();
    const queue = tab?.queue || workspace.tasks;
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    this.result(task.message, error, value);
    this.notificationTasks.delete(task.message.request_id);
    void this.groupColor(workspace).catch(error => this.report(error));
    void this.clearNotification(task.message.request_id).catch(error => this.report(error));
    if (tab && task.preview) void this.adapter.releaseAction(tab, task.preview).catch(error => this.report(error));
    this.history.record(error ? 'failed' : 'completed', { request_id: task.message.request_id,
      operation: task.message.operation, code: error?.code });
    this.drain(workspace); this.changed();
  }

  result(message, error, value) {
    if (!this.connection || message.connection_id !== this.connection.connection_id) return;
    try { this.send({ type: 'result', request_id: message.request_id, target_id: message.target_id,
      ...(error ? { error } : { result: value }) }); }
    catch (failure) { this.report(failure); }
  }

  async groupColor(workspace) {
    const human = [...this.notificationTasks.values()].some(entry => entry.workspace === workspace);
    let color = 'grey';
    if (workspace.state === 'active') color = human ? 'yellow' : 'blue';
    await this.adapter.api.tabGroups.update(workspace.groupId, { color });
  }

  async tick() {
    if (this.socket && this.now() - this.lastPing >= LIVENESS_MS) this.loseConnection(this.socket, this.generation);
    if (this.pairing && !this.polling && this.pairing.expires_at > this.now()) {
      this.polling = true;
      try { await this.pairingStatus(); } finally { this.polling = false; }
    }
    for (const workspace of this.workspaces.values()) for (const tab of workspace.tabs.values()) {
      for (const task of [...tab.queue]) if (task.deadline <= this.now()) {
        this.finishTask(workspace, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_EXPIRED' });
      }
    }
    if (this.connection) await this.refresh();
  }

  loseConnection(socket, generation) {
    if (!this.current(socket, generation)) return;
    this.connection = null; this.socket = null; this.phase = 'disconnected'; this.generation++;
    for (const workspace of this.workspaces.values()) {
      void this.stopWorkspace(workspace, 'inactive').catch(error => this.report(error));
    }
    socket.close(); this.history.record('disconnected'); this.changed();
    if (this.config.enabled) this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }

  async disconnect() {
    this.config.enabled = false; clearTimeout(this.reconnectTimer);
    if (this.socket) this.loseConnection(this.socket, this.generation);
    for (const workspace of this.workspaces.values()) await this.stopWorkspace(workspace, 'inactive');
    await Promise.all([...this.endingTasks]);
    await this.storage.set({ config: this.config });
    this.changed();
  }

  dispose() {
    clearInterval(this.timer); clearTimeout(this.reconnectTimer);
    this.config.enabled = false;
    if (this.socket) this.loseConnection(this.socket, this.generation);
  }
}
