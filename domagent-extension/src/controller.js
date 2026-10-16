import {
  VERSION, LIVENESS_MS, SESSION_TAB_LIMIT, SESSION_CONCURRENCY, HUMAN_WAIT_MS, EXECUTION_MS,
  registerPayload, tokenPayload, connectPayload, serviceOrigin, sign, pairingCode, validBrowserInfo,
  validDescription, validOperationArgs, navigationUrl, inspectionErrorDetails, waitErrorDetails, agentColor,
  validName, errorDetails,
} from '../../shared/protocol.js';
import { boundedResult, errorCode, fail, id as validId, originList, protectedUnion } from './security.js';
import { diagnosticDetails } from '../../shared/diagnostics.js';

const FEED_LIMIT = 200;
const SYNC_KEEPALIVE_MS = 30 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_VALUE = 'domagent';
const READ_OPERATIONS = ['get_text', 'get_page_snapshot', 'get_interactive_elements', 'inspect_element', 'get_screenshot'];
// Tab closing waits for an explicit user approval in the DomAgent window; nothing closes tabs automatically.
const CLOSE_OPERATIONS = ['close_tab', 'close_session'];
const MUTATIONS = ['navigate', 'click', 'type_text', 'select_option', 'set_checked', 'press_key'];

export function defaultBrowserName(browserName, platform = globalThis.navigator?.userAgentData?.platform ||
  globalThis.navigator?.platform || '') {
  const os = /mac/i.test(platform) ? 'Mac' : /win/i.test(platform) ? 'Windows' : /linux/i.test(platform) ? 'Linux' :
    /cros/i.test(platform) ? 'ChromeOS' : 'this computer';
  return `${browserName === 'firefox' ? 'Firefox' : 'Chrome'} on ${os}`;
}

/** Candidate native groups for a session whose group IDs did not survive a browser restart. */
export function reattachCandidates(record, groups, tabsByGroup) {
  const urls = new Set((record.tabs || []).map(tab => tab.url));
  return groups.filter(group => group.title === record.title).map(group => {
    const tabs = tabsByGroup.get(group.id) || [];
    return { groupId: group.id, title: group.title, tab_count: tabs.length,
      matching: tabs.filter(tab => urls.has(tab.url)).length };
  }).sort((a, b) => b.matching - a.matching || b.tab_count - a.tab_count);
}

export class Controller {
  constructor({ api, adapter, identity, storage, sessionStorage, browserName, extensionUrl, Socket = WebSocket,
    fetcher = (...args) => fetch(...args), now = () => Date.now(), appWindowId = null }) {
    Object.assign(this, { api, adapter, identityStore: identity, storage, sessionStorage, browserName, Socket, fetcher,
      now, appWindowId });
    const url = new URL(extensionUrl);
    this.extension_origin = `${url.protocol}//${url.host}`;
    this.identity = null; this.phase = 'loading'; this.error = null; this.lastSetup = null;
    this.socket = null; this.generation = 0; this.connection = null; this.lastPing = 0; this.access = null;
    this.reconnectDelay = 1000; this.reconnectTimer = null; this.closing = false;
    this.agents = new Map(); this.sessions = new Map(); this.requests = new Map(); this.pairing = null;
    this.handoffs = new Map(); this.closures = new Map(); this.feed = []; this.settings = { openAtStartup: false };
    this.protectedOrigins = []; this.records = []; this.knownTabs = new Map();
    this.lastInventory = ''; this.lastSyncAt = 0; this.flashOn = false; this.refreshing = null;
    this.refreshQueued = false; this.listeners = new Set(); this.endingTasks = new Set();
    this.adapter.onWarning = error => console.warn('DomAgent:', errorCode(error));
    this.adapter.onTabEvent = (tabId, event, destination) => this.tabEvent(tabId, event, destination);
  }

  // ---------- observation ----------
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed() {
    for (const listener of this.listeners) listener();
    void this.updateBadge().catch(() => {});
  }
  report(error) {
    this.error = errorCode(error);
    console.error('DomAgent:', this.error);
    this.changed();
  }
  addFeed(entry) {
    const existing = entry.id && this.feed.find(item => item.id === entry.id);
    if (existing) Object.assign(existing, entry, { updated_at: this.now() });
    else if (!entry.description) return;
    else this.feed.push({ id: entry.id || crypto.randomUUID(), time: this.now(), updated_at: this.now(), ...entry });
    this.feed = this.feed.slice(-FEED_LIMIT);
    this.persistSoon();
  }
  persistSoon() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(error => this.report(error));
    }, 200);
  }
  async persist() {
    const records = [...this.sessions.values()].filter(session => session.session_id).map(session => ({
      client_id: session.client_id, session_id: session.session_id, agent_id: session.agent_id, title: session.title,
      groupId: session.groupId, tabs: [...session.tabs.values()].filter(tab => tab.id)
        .map(tab => ({ key: tab.tabId, id: tab.id, url: tab.url })),
    }));
    // Unconfirmed sessions keep their previous record so a later reattach can still match tabs.
    const keep = this.records.filter(record => this.sessions.get(record.client_id)?.state === 'unconfirmed');
    this.records = [...records.filter(record => !keep.some(old => old.client_id === record.client_id)), ...keep];
    await this.storage.set({ sessions: this.records, feed: this.feed, settings: this.settings });
  }

  snapshot() {
    const agentsById = this.agents;
    const sessionView = session => {
      const agent = agentsById.get(session.agent_id) || { id: session.agent_id, name: session.agent_id };
      return {
        client_id: session.client_id, session_id: session.session_id, agent, title: session.title,
        purpose: session.purpose, state: session.state, candidates: session.candidates || [],
        tabs: [...session.tabs.values()].map(tab => ({ tabId: tab.tabId, id: tab.id, title: tab.title, url: tab.url,
          page_state: tab.pageState, working: tab.queue.some(task => task.executing && !task.human),
          help: tab.queue.some(task => task.human) })),
        excluded: session.excluded || 0,
      };
    };
    return {
      phase: this.phase, error: this.error, browser: this.browserName,
      identity: this.identity?.browser_id ? { origin: this.identity.origin, name: this.identity.name,
        browser_id: this.identity.browser_id } : null,
      last_setup: this.lastSetup,
      agents: [...this.agents.values()],
      sessions: [...this.sessions.values()].filter(session => session.state !== 'pending').map(sessionView),
      requests: [...this.requests.values()],
      pairing: this.pairing ? { code: this.pairing.code, state: this.pairing.state, expires_at: this.pairing.expires_at,
        proposal: this.pairing.proposal || null } : null,
      handoffs: [...this.handoffs.values()].map(({ session, tab, task }) => ({
        request_id: task.message.request_id, agent: agentsById.get(session.agent_id) || { name: session.agent_id },
        session_title: session.title, tab_title: tab.title, tabId: tab.tabId,
        instructions: task.message.args.instructions })),
      closures: [...this.closures.values()].map(({ session, task }) => {
        const one = task.message.operation === 'close_tab';
        const tabs = one ? [this.sessionTab(session, task.message.args.tab_id)].filter(Boolean) : [...session.tabs.values()];
        return { request_id: task.message.request_id, agent: agentsById.get(session.agent_id) || { name: session.agent_id },
          kind: one ? 'tab' : 'session', session_title: session.title, description: task.message.description,
          tabs: tabs.map(t => ({ tabId: t.tabId, title: t.title, url: t.url })), excluded: one ? 0 : session.excluded || 0 };
      }),
      feed: this.feed.slice(-100),
      settings: { ...this.settings },
      pending_count: this.pendingCount(),
    };
  }
  pendingCount() {
    return this.handoffs.size + this.closures.size + this.requests.size + (this.pairing?.proposal ? 1 : 0) +
      [...this.sessions.values()].filter(session => session.state === 'unconfirmed').length;
  }
  async updateBadge() {
    const action = this.api.action;
    const count = this.pendingCount();
    await action.setBadgeText({ text: count ? String(count) : '' });
    await action.setBadgeBackgroundColor({ color: '#be6824' });
    await action.setTitle({ title: count ? `DomAgent: ${count} item(s) need your attention` :
      this.phase === 'online' ? 'DomAgent: connected' : 'DomAgent' });
  }

  // ---------- startup ----------
  async initialize() {
    this.browserInfo = await this.adapter.browserInfo();
    if (!validBrowserInfo(this.browserInfo)) fail('INVALID_MESSAGE');
    const saved = await this.storage.get(['feed', 'settings', 'sessions', 'lastSetup']);
    this.feed = Array.isArray(saved.feed) ? saved.feed.slice(-FEED_LIMIT) : [];
    this.settings = { openAtStartup: saved.settings?.openAtStartup === true };
    this.records = Array.isArray(saved.sessions) ? saved.sessions.slice(0, 64) : [];
    this.lastSetup = saved.lastSetup || null;
    await this.adapter.initialize();
    this.listen();
    this.timer = setInterval(() => { void this.tick().catch(error => this.report(error)); }, 1000);
    try { this.identity = await this.identityStore.load(); }
    catch (error) { this.identity = null; this.report(error); }
    if (this.identity?.browser_id) this.connect();
    else this.phase = 'setup';
    this.changed();
  }
  listen() {
    const refresh = () => this.scheduleRefresh();
    const { tabs, tabGroups } = this.api;
    tabs.onCreated.addListener(refresh); tabs.onRemoved.addListener(refresh);
    tabs.onAttached.addListener(refresh); tabs.onDetached.addListener(refresh);
    tabs.onUpdated.addListener((_id, change) => {
      if ('groupId' in change || 'title' in change || 'url' in change || 'status' in change) refresh();
    });
    tabGroups.onUpdated.addListener(refresh); tabGroups.onRemoved.addListener(refresh);
    tabGroups.onMoved?.addListener(refresh);
    const menus = this.api.menus || this.api.contextMenus;
    menus?.onClicked.addListener((info, tab) => { void this.menuClicked(info, tab).catch(error => this.report(error)); });
    this.api.notifications?.onClicked.addListener(id => { void this.notificationClicked(id).catch(error => this.report(error)); });
  }

  // ---------- identity and connection ----------
  async http(path, body) {
    const response = await this.fetcher(`${this.identity.origin}${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: { 'X-DomAgent-Extension-Origin': this.extension_origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    if (raw.length > 16_384) fail('INVALID_MESSAGE');
    let value;
    try { value = JSON.parse(raw); } catch { fail(response.ok ? 'INVALID_MESSAGE' : 'SERVICE_UNREACHABLE'); }
    if (!response.ok) fail(value.error || 'SERVICE_UNREACHABLE');
    return value;
  }
  async setup({ domain, name }) {
    let candidate = String(domain || '').trim();
    if (!candidate.includes('://')) candidate = `https://${candidate}`;
    const origin = serviceOrigin(candidate);
    if (!validName(name)) fail('INVALID_ARGUMENT');
    let metadata;
    try {
      const response = await this.fetcher(`${origin}/.well-known/domagent`, { credentials: 'omit', redirect: 'error',
        cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      const raw = await response.text();
      if (!response.ok || raw.length > 4096) fail('INVALID_SERVICE');
      metadata = JSON.parse(raw);
    } catch (error) { fail(error.code === 'INVALID_SERVICE' ? error.code : 'SERVICE_UNREACHABLE'); }
    if (metadata.service !== 'domagent' || metadata.origin !== origin) fail('INVALID_SERVICE');
    if (metadata.protocol_version !== VERSION) fail('UPGRADE_REQUIRED');
    const record = await this.identityStore.create(origin);
    this.identity = record;
    try {
      const { nonce } = await this.http('/api/challenge');
      const data = { name: name.trim(), key_id: record.key_id, public_key: record.public_key, nonce };
      data.signature = await sign(record.privateKey, registerPayload({ ...data, origin, extension_origin: this.extension_origin }));
      const result = await this.http('/api/browsers', data);
      validId(result.browser_id);
      Object.assign(record, { browser_id: result.browser_id, refresh_token: result.refresh_token, name: result.name });
      await this.identityStore.save(record);
      this.access = { token: result.access_token, expires_at: result.expires_at };
    } catch (error) { this.identity = null; throw error; }
    this.lastSetup = { origin, name: record.name };
    this.error = null;
    await this.storage.set({ lastSetup: this.lastSetup, sessions: [] });
    this.records = [];
    this.connect();
  }
  async accessToken() {
    if (this.access && this.access.expires_at > this.now() + 30_000) return this.access.token;
    const record = this.identity;
    const { nonce } = await this.http('/api/challenge');
    const data = { browser_id: record.browser_id, refresh_token: record.refresh_token, nonce };
    data.signature = await sign(record.privateKey, tokenPayload({ ...data, origin: record.origin, key_id: record.key_id }));
    const result = await this.http('/api/token', data);
    // Persist the rotated refresh token before anything else can fail.
    record.refresh_token = result.refresh_token;
    await this.identityStore.save(record);
    this.access = { token: result.access_token, expires_at: result.expires_at };
    return this.access.token;
  }
  async connect() {
    if (this.socket || this.closing || !this.identity?.browser_id) return;
    clearTimeout(this.reconnectTimer);
    const generation = ++this.generation;
    this.phase = 'connecting'; this.changed();
    let accessToken;
    try { accessToken = await this.accessToken(); }
    catch (error) {
      if (generation !== this.generation) return;
      if (error.code === 'NOT_AUTHORIZED') { await this.revoked(); return; }
      this.phase = 'offline'; this.error = errorCode(error) === 'OUTCOME_UNKNOWN' ? 'SERVICE_UNREACHABLE' : errorCode(error);
      this.scheduleReconnect(); this.changed(); return;
    }
    if (generation !== this.generation || this.socket) return;
    const socket = new this.Socket(`${this.identity.origin.replace('https:', 'wss:')}/extension`);
    this.socket = socket; this.lastPing = this.now();
    let messages = Promise.resolve();
    socket.onopen = () => {
      if (!this.current(socket, generation)) return;
      socket.send(JSON.stringify({ type: 'hello', version: VERSION, access_token: accessToken, browser_info: this.browserInfo }));
    };
    socket.onmessage = event => {
      messages = messages.then(() => this.receive(event.data, socket, generation)).catch(error => {
        this.report(error);
        if (['NOT_AUTHORIZED', 'INVALID_MESSAGE', 'UPGRADE_REQUIRED'].includes(errorCode(error))) this.lost(socket, generation);
      });
    };
    socket.onclose = socket.onerror = () => this.lost(socket, generation);
  }
  current(socket, generation) { return this.socket === socket && this.generation === generation; }
  scheduleReconnect() {
    if (this.closing || !this.identity?.browser_id) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
  retry() { this.reconnectDelay = 1000; clearTimeout(this.reconnectTimer); void this.connect(); }
  lost(socket, generation) {
    if (!this.current(socket, generation)) return;
    this.socket = null; this.connection = null; this.ready = false; this.generation++;
    try { socket.close(); } catch { /* already closed */ }
    this.phase = this.identity?.browser_id ? 'offline' : 'setup';
    // Keeps the offline notice up across reconnect attempts; welcome clears it.
    if (!['UPGRADE_REQUIRED', 'NOT_AUTHORIZED', 'INVALID_SERVICE'].includes(this.error)) this.error = 'BROWSER_OFFLINE';
    this.lastInventory = '';
    for (const request of this.requests.keys()) this.clearNotification(`domagent-request-${request}`);
    this.requests.clear();
    if (this.pairing) { this.pairing = null; this.clearNotification('domagent-pairing'); }
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs.values()) for (const task of [...tab.queue]) {
        this.finishTask(session, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : 'BROWSER_OFFLINE' });
      }
      for (const task of [...session.tasks]) this.finishTask(session, null, task, { code: 'BROWSER_OFFLINE' });
    }
    this.scheduleReconnect();
    this.changed();
  }
  async revoked() {
    this.closing = true;
    if (this.socket) this.lost(this.socket, this.generation);
    this.closing = false;
    clearTimeout(this.reconnectTimer);
    for (const session of [...this.sessions.values()]) await this.closeLocal(session, false);
    await this.identityStore.clear().catch(() => {});
    this.identity = null; this.access = null; this.agents.clear(); this.records = [];
    await this.storage.set({ sessions: [] });
    this.phase = 'setup'; this.error = 'BROWSER_REVOKED';
    this.changed();
  }
  send(message) {
    if (!this.connection || this.socket?.readyState !== 1) fail('BROWSER_OFFLINE');
    this.socket.send(JSON.stringify(message));
  }

  async receive(raw, socket, generation) {
    if (!this.current(socket, generation)) return;
    if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) fail('INVALID_MESSAGE');
    const message = JSON.parse(raw);
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') fail('INVALID_MESSAGE');
    if (!this.connection) {
      if (message.type === 'challenge') {
        const signature = await sign(this.identity.privateKey, connectPayload({ origin: this.identity.origin,
          nonce: message.nonce, browser_id: this.identity.browser_id, connection_id: message.connection_id }));
        if (this.current(socket, generation)) socket.send(JSON.stringify({ type: 'proof', signature }));
        return;
      }
      if (message.type === 'welcome') return this.welcome(message);
      if (message.type === 'error') {
        if (['NOT_AUTHORIZED', 'UPGRADE_REQUIRED'].includes(message.code)) this.access = null;
        fail(message.code === 'NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : message.code || 'NOT_AUTHORIZED');
      }
      fail('INVALID_MESSAGE');
    }
    this.lastPing = this.now();
    switch (message.type) {
      case 'ping':
        this.send({ type: 'pong' });
        if (this.now() - this.lastSyncAt >= SYNC_KEEPALIVE_MS) await this.sync(true);
        return;
      case 'sync.ack': return this.acknowledged(message);
      case 'agents': this.setAgents(message.agents); return;
      case 'browser':
        if (validName(message.name)) { this.identity.name = message.name; await this.identityStore.save(this.identity); }
        this.changed(); return;
      case 'pairing.code.ok':
        if (this.pairing?.code === message.code) {
          this.pairing.state = 'waiting'; this.pairing.expires_at = message.expires_at; this.changed();
        }
        return;
      case 'pairing.proposal': return this.proposal(message);
      case 'session.request': return this.sessionRequest(message);
      case 'session.request.cancel': return this.requestCancelled(message.request_id);
      case 'session.created': return this.sessionCreated(message);
      case 'session.end': return this.sessionEnded(message);
      case 'progress': return this.progress(message);
      case 'command': this.enqueue(message); return;
      case 'command.execute': void this.executeReady(message).catch(error => this.report(error)); return;
      case 'command.cancel': return this.cancelCommand(message);
      case 'revoked': return this.revoked();
      case 'sessions': return;
      case 'error':
        if (message.in_reply_to === 'pairing.code' && message.code === 'PAIRING_CODE_COLLISION' && this.pairing) {
          return this.startPairing();
        }
        this.report(Object.assign(new Error(message.code), { code: message.code }));
        return;
      default: fail('INVALID_MESSAGE');
    }
  }
  async welcome(message) {
    validId(message.browser_id);
    if (message.browser_id !== this.identity.browser_id) fail('NOT_AUTHORIZED');
    this.connection = { connection_id: message.connection_id };
    // An inventory sent before reattach finishes would tell the server every session is gone.
    this.ready = false;
    this.phase = 'online'; this.error = null; this.reconnectDelay = 1000;
    this.protectedOrigins = protectedUnion(this.identity.origin, originList(message.protected_origins || []));
    if (validName(message.name) && message.name !== this.identity.name) {
      this.identity.name = message.name; await this.identityStore.save(this.identity);
    }
    this.setAgents(message.agents);
    await this.reattach(Array.isArray(message.sessions) ? message.sessions : []);
    this.ready = true;
    await this.refresh();
    await this.sync(true);
    this.changed();
  }
  setAgents(agents) {
    if (!Array.isArray(agents)) fail('INVALID_MESSAGE');
    this.agents = new Map(agents.filter(agent => agent && typeof agent.id === 'string').map(agent => [agent.id, {
      id: agent.id, name: String(agent.name || agent.id).slice(0, 80), url: typeof agent.url === 'string' ? agent.url : null,
      color: agent.color || agentColor(agent.id) }]));
    this.buildMenus();
    this.changed();
  }

  // ---------- reattach ----------
  async reattach(serverSessions) {
    const server = new Map(serverSessions.filter(s => UUID.test(s.client_id || '')).map(s => [s.client_id, s]));
    const run = await this.sessionStorage.get('run').catch(() => ({}));
    const sameRun = run.run === true;
    const groups = await this.api.tabGroups.query({});
    const groupIds = new Set(groups.map(group => group.id));
    const allTabs = await this.api.tabs.query({});
    const tabsByGroup = new Map();
    for (const tab of allTabs) if (tab.groupId >= 0) {
      if (!tabsByGroup.has(tab.groupId)) tabsByGroup.set(tab.groupId, []);
      tabsByGroup.get(tab.groupId).push(tab);
    }
    // Firefox persists per-tab values across restarts; Chrome only keeps group IDs for one browser run.
    const located = new Map();
    if (this.api.sessions?.getTabValue) {
      for (const tab of allTabs) {
        if (tab.groupId < 0) continue;
        const value = await this.api.sessions.getTabValue(tab.id, TAB_VALUE).catch(() => null);
        if (!value || !UUID.test(value.client_id || '')) continue;
        const entry = located.get(value.client_id) || { groups: new Map(), tabs: new Map() };
        entry.groups.set(tab.groupId, (entry.groups.get(tab.groupId) || 0) + 1);
        if (typeof value.tab_id === 'string') entry.tabs.set(tab.id, value.tab_id);
        located.set(value.client_id, entry);
      }
    }
    for (const [clientId, local] of [...this.sessions]) {
      if (local.state === 'pending') {
        // The decision may have been committed while the connection dropped.
        if (server.has(clientId)) await this.commitPending(local, server.get(clientId).session_id);
        else await this.discardPending(local);
        continue;
      }
      if (!server.has(clientId)) { await this.closeLocal(local, true); continue; }
    }
    for (const [clientId, info] of server) {
      const existing = this.sessions.get(clientId);
      if (existing && existing.state === 'attached' && groupIds.has(existing.groupId)) {
        existing.session_id = info.session_id; continue;
      }
      if (existing?.state === 'unconfirmed') continue;
      const record = this.records.find(r => r.client_id === clientId) || { client_id: clientId, title: info.title, tabs: [] };
      const base = { client_id: clientId, session_id: info.session_id, agent_id: info.agent_id, title: info.title,
        purpose: info.purpose, tabs: new Map(), tasks: [], running: 0, creating: 0, excluded: 0 };
      const found = located.get(clientId);
      let groupId = null;
      const knownTabs = new Map();
      const claimed = new Set([...this.sessions.values()].map(s => s.groupId).filter(id => id !== null && id !== undefined));
      if (found) {
        const [candidate, tagged] = [...found.groups].sort((a, b) => b[1] - a[1])[0];
        // A tagged tab dragged into someone else's group must not pull that whole group into scope.
        if (!claimed.has(candidate) && tagged * 2 > (tabsByGroup.get(candidate) || []).length) {
          groupId = candidate;
          for (const [tabId, serverTabId] of found.tabs) knownTabs.set(tabId, serverTabId);
        }
      } else if (sameRun && groupIds.has(record.groupId)) {
        groupId = record.groupId;
        for (const tab of record.tabs || []) knownTabs.set(tab.key, tab.id);
      }
      if (groupId !== null) {
        const group = groups.find(g => g.id === groupId);
        this.sessions.set(clientId, { ...base, state: 'attached', groupId, windowId: group.windowId,
          title: group.title || info.title });
        for (const [key, value] of knownTabs) this.knownTabs.set(key, value);
        continue;
      }
      if (!sameRun || found) {
        const candidates = reattachCandidates({ ...record, title: record.title || info.title }, groups, tabsByGroup)
          .filter(candidate => ![...this.sessions.values()].some(s => s.groupId === candidate.groupId));
        if (candidates.length) {
          this.sessions.set(clientId, { ...base, state: 'unconfirmed', groupId: null, candidates });
          continue;
        }
      }
      // The group is gone: leaving it out of the next inventory ends the session server-side.
    }
    await this.sessionStorage.set({ run: true }).catch(() => {});
    this.buildMenus();
  }
  async confirmReattach(clientId, groupId) {
    const session = this.sessions.get(clientId);
    if (!session || session.state !== 'unconfirmed' || !session.candidates.some(c => c.groupId === groupId)) fail('ACTION_EXPIRED');
    const group = await this.api.tabGroups.get(groupId);
    const record = this.records.find(r => r.client_id === clientId);
    const tabs = await this.api.tabs.query({ groupId });
    const unused = [...(record?.tabs || [])];
    for (const tab of tabs) {
      const index = unused.findIndex(old => old.url === tab.url);
      if (index >= 0) { this.knownTabs.set(tab.id, unused[index].id); unused.splice(index, 1); }
    }
    Object.assign(session, { state: 'attached', groupId, windowId: group.windowId, candidates: [] });
    await this.refresh();
    await this.sync(true);
  }
  async discardReattach(clientId) {
    const session = this.sessions.get(clientId);
    if (!session || session.state !== 'unconfirmed') fail('ACTION_EXPIRED');
    this.sessions.delete(clientId);
    this.records = this.records.filter(record => record.client_id !== clientId);
    await this.persist();
    await this.sync(true);
    this.changed();
  }

  // ---------- inventory ----------
  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { void this.refresh().catch(error => this.report(error)); }, 100);
  }
  async refresh() {
    if (this.refreshing) { this.refreshQueued = true; return this.refreshing; }
    this.refreshCount = (this.refreshCount || 0) + 1;
    this.refreshing = (async () => {
      do {
        this.refreshQueued = false;
        for (const session of [...this.sessions.values()]) {
          if (session.state !== 'attached') continue;
          try { await this.scan(session); }
          catch (error) { this.report(error); }
        }
      } while (this.refreshQueued);
    })();
    try { await this.refreshing; } finally { this.refreshing = null; }
    this.persistSoon();
    await this.sync();
    this.changed();
  }
  async scan(session) {
    let group = null;
    try { group = await this.api.tabGroups.get(session.groupId); } catch { group = null; }
    if (!group) {
      // The user closed or ungrouped the tab group: the session ends.
      this.addFeed({ session_id: session.session_id, agent_id: session.agent_id, kind: 'session',
        description: `Session “${session.title}” ended: its tab group was closed.`, status: 'cancelled' });
      await this.closeLocal(session, false);
      return;
    }
    if (group.title && group.title !== session.title) session.title = group.title;
    session.windowId = group.windowId;
    const tabs = await this.api.tabs.query({ groupId: session.groupId });
    for (const [tabId, tab] of [...session.tabs]) {
      if (!tabs.some(current => current.id === tabId)) this.dropTab(session, tab, 'TAB_NOT_IN_SESSION');
    }
    let excluded = 0;
    for (const current of tabs) {
      const tracked = session.tabs.get(current.id);
      const currentUrl = current.pendingUrl || current.url || '';
      if (tracked) { await this.updateTab(session, tracked, current, currentUrl); continue; }
      if (!currentUrl) continue;
      let ordinary = false;
      try { navigationUrl(currentUrl, this.protectedOrigins); ordinary = true; }
      catch { if (/^https?:/i.test(currentUrl)) { excluded++; continue; } }
      if (session.tabs.size >= SESSION_TAB_LIMIT) { excluded++; continue; }
      for (const other of this.sessions.values()) {
        const moved = other !== session && other.tabs.get(current.id);
        if (moved) this.dropTab(other, moved, 'TAB_NOT_IN_SESSION');
      }
      await Promise.all([...this.endingTasks]);
      const tab = { tabId: current.id, groupId: session.groupId, windowId: current.windowId,
        id: this.knownTabs.get(current.id) || null, title: (current.title || 'New tab').slice(0, 160),
        url: currentUrl.slice(0, 2048), pageState: ordinary ? (current.status === 'loading' ? 'loading' : 'ready') : 'navigation_only',
        protected_origins: this.protectedOrigins, queue: [], documentGeneration: 0,
        scriptWorldId: `domagent-${session.client_id}` };
      this.knownTabs.delete(current.id);
      await this.adapter.protect(tab.tabId, tab.protected_origins);
      if (ordinary) await this.adapter.attach(tab.tabId).catch(error => this.report(error));
      if (this.sessions.get(session.client_id) !== session || session.state !== 'attached') {
        await this.adapter.release(tab.tabId); return;
      }
      session.tabs.set(tab.tabId, tab);
      if (tab.id) this.tagTab(session, tab);
    }
    session.excluded = excluded;
  }
  async updateTab(session, tab, current, currentUrl) {
    tab.windowId = current.windowId;
    if (!currentUrl) { tab.pageState = 'loading'; return; }
    if (tab.navigation && !/^https?:/.test(currentUrl)) { tab.pageState = 'loading'; return; }
    if (/^https?:/.test(currentUrl) && this.adapter.browserName === 'chrome' && !this.adapter.attached.has(tab.tabId)) {
      try { navigationUrl(currentUrl, this.protectedOrigins); await this.adapter.attach(tab.tabId); }
      catch { /* protected pages keep navigation-only scope; the guard blocks loading them */ }
    }
    tab.title = (current.title || 'Untitled').slice(0, 160);
    const navigatingOld = tab.navigation && currentUrl === tab.navigation.from && currentUrl !== tab.navigation.url;
    if (navigatingOld) return;
    tab.url = currentUrl.slice(0, 2048);
    if (!/^https?:/.test(currentUrl)) tab.pageState = 'navigation_only';
    else if (current.status === 'loading') tab.pageState = tab.pageState === 'unavailable' ? 'unavailable' : 'loading';
    else if (['loading', 'navigation_only'].includes(tab.pageState)) tab.pageState = 'ready';
  }
  tagTab(session, tab) {
    if (!this.api.sessions?.setTabValue) return;
    void this.api.sessions.setTabValue(tab.tabId, TAB_VALUE, { client_id: session.client_id, tab_id: tab.id })
      .catch(() => {});
  }
  dropTab(session, tab, code) {
    session.tabs.delete(tab.tabId);
    for (const task of [...session.tasks]) {
      if (task.message.operation === 'close_tab' && task.message.args.tab_id === tab.id && !task.executing) {
        this.finishTask(session, null, task, { code: 'TAB_NOT_IN_SESSION' });
      }
    }
    for (const task of [...tab.queue]) this.finishTask(session, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : code });
    if (this.api.sessions?.removeTabValue) void this.api.sessions.removeTabValue(tab.tabId, TAB_VALUE).catch(() => {});
    const cleanup = this.adapter.release(tab.tabId).catch(error => this.report(error));
    this.endingTasks.add(cleanup); void cleanup.finally(() => this.endingTasks.delete(cleanup));
  }
  async closeLocal(session, ungroup, closeTabIds = []) {
    if (this.sessions.get(session.client_id) === session) this.sessions.delete(session.client_id);
    for (const tab of [...session.tabs.values()]) this.dropTab(session, tab, 'SESSION_ENDED');
    for (const task of [...session.tasks]) this.finishTask(session, null, task, { code: 'SESSION_ENDED' });
    // Only user-approved tabs; anything else left in the group is just ungrouped. One by one: a batch
    // remove rejects entirely if any tab is already gone.
    await Promise.all(closeTabIds.map(id => this.api.tabs.remove(id).catch(() => {})));
    if (ungroup && session.groupId !== null && session.groupId !== undefined) {
      const tabs = await this.api.tabs.query({ groupId: session.groupId }).catch(() => []);
      if (tabs.length) await this.api.tabs.ungroup(tabs.map(tab => tab.id)).catch(error => this.report(error));
    }
    this.records = this.records.filter(record => record.client_id !== session.client_id);
    this.buildMenus();
    this.persistSoon();
    this.changed();
  }
  inventory() {
    const groups = [];
    for (const session of this.sessions.values()) {
      if (session.state === 'pending') {
        groups.push({ client_id: session.client_id, title: session.title, state: 'attached',
          request_id: session.request_id, tabs: [] });
        continue;
      }
      if (!session.session_id) continue;
      groups.push({ client_id: session.client_id, title: session.title || 'DomAgent', state: session.state,
        tabs: session.state !== 'attached' ? [] : [...session.tabs.values()].sort((a, b) => a.tabId - b.tabId).map(tab => {
          const url = tab.navigation?.url || tab.url;
          const pageState = /^https?:/.test(url) ? tab.pageState : 'navigation_only';
          return { id: tab.id, key: tab.tabId, title: tab.title, url, page_state: pageState,
            capabilities: ['navigation_only', 'unavailable'].includes(pageState) ? ['navigate'] : this.adapter.capabilities() };
        }) });
    }
    return groups;
  }
  async sync(force = false) {
    if (!this.connection || !this.ready) return;
    const groups = this.inventory();
    const serialized = JSON.stringify(groups);
    if (!force && serialized === this.lastInventory) return;
    this.lastInventory = serialized; this.lastSyncAt = this.now();
    this.send({ type: 'sync', groups });
  }
  acknowledged(message) {
    if (!Array.isArray(message.assignments) || !Array.isArray(message.unknown)) fail('INVALID_MESSAGE');
    for (const assignment of message.assignments) {
      const session = this.sessions.get(assignment.client_id);
      const tab = session?.tabs.get(assignment.key);
      if (!tab || typeof assignment.id !== 'string') continue;
      tab.id = assignment.id;
      this.tagTab(session, tab);
    }
    for (const clientId of message.unknown) {
      const session = this.sessions.get(clientId);
      // The server only reports a pending group as unknown once its request is gone.
      if (session?.state === 'pending') void this.discardPending(session);
      else if (session) void this.closeLocal(session, true);
    }
    // Tab IDs are now part of the inventory; record them so the next change carries them.
    this.lastInventory = JSON.stringify(this.inventory());
    this.persistSoon();
    this.changed();
  }

  // ---------- pairing ----------
  startPairing() {
    if (!this.connection) fail('BROWSER_OFFLINE');
    this.pairing = { code: pairingCode(), state: 'requesting', expires_at: null, proposal: null };
    this.send({ type: 'pairing.code', code: this.pairing.code });
    this.changed();
  }
  cancelPairing() {
    if (this.pairing && this.connection) this.send({ type: 'pairing.cancel' });
    this.pairing = null; this.clearNotification('domagent-pairing'); this.changed();
  }
  proposal(message) {
    if (!this.pairing || !UUID.test(message.request_id || '') || !message.agent?.id) return;
    this.pairing.state = 'proposed';
    this.pairing.proposal = { request_id: message.request_id, agent: { id: message.agent.id,
      name: String(message.agent.name).slice(0, 80), url: message.agent.url || null } };
    this.notify('domagent-pairing', 'Approve DomAgent pairing?',
      `${this.pairing.proposal.agent.name} wants to use this browser.`);
    this.changed();
  }
  decidePairing(approved) {
    const proposal = this.pairing?.proposal;
    if (!proposal) fail('ACTION_EXPIRED');
    this.send({ type: 'pairing.decision', request_id: proposal.request_id, approved });
    this.addFeed({ kind: 'pairing', agent_id: proposal.agent.id, status: approved ? 'complete' : 'cancelled',
      description: approved ? `Paired with ${proposal.agent.name}.` : `Declined pairing with ${proposal.agent.name}.` });
    this.pairing = null; this.clearNotification('domagent-pairing');
    this.changed();
  }
  revokeAgent(agentId) {
    this.send({ type: 'pairing.revoke', agent_id: agentId });
    const agent = this.agents.get(agentId);
    this.addFeed({ kind: 'pairing', agent_id: agentId, status: 'cancelled',
      description: `Unpaired ${agent?.name || agentId}. Its sessions ended.` });
  }
  renameBrowser(name) {
    if (!validName(name)) fail('INVALID_ARGUMENT');
    this.send({ type: 'browser.rename', name: name.trim() });
  }
  async forget() {
    if (this.connection) this.send({ type: 'browser.forget' });
    for (const session of [...this.sessions.values()]) await this.closeLocal(session, true);
    await this.revoked();
    this.error = null; this.changed();
  }
  async setOpenAtStartup(value) {
    this.settings.openAtStartup = value === true;
    await this.persist();
    this.changed();
  }

  // ---------- session requests ----------
  sessionRequest(message) {
    if (!UUID.test(message.request_id || '') || !message.agent?.id || typeof message.purpose !== 'string') fail('INVALID_MESSAGE');
    const urls = Array.isArray(message.urls) ? message.urls.slice(0, SESSION_TAB_LIMIT).filter(url => typeof url === 'string') : [];
    const request = { request_id: message.request_id, agent: { id: message.agent.id, name: String(message.agent.name).slice(0, 80),
      url: message.agent.url || null, color: message.agent.color || agentColor(message.agent.id) },
    purpose: message.purpose.slice(0, 500), urls, title: String(message.title || message.agent.name).slice(0, 120),
    expires_at: message.expires_at };
    this.requests.set(request.request_id, request);
    this.notify(`domagent-request-${request.request_id}`, `${request.agent.name} wants to open a browser session`,
      request.purpose.slice(0, 180));
    this.changed();
  }
  async approveSession(requestId) {
    const request = this.requests.get(requestId);
    if (!request || request.expires_at <= this.now()) fail('ACTION_EXPIRED');
    this.requests.delete(requestId);
    this.clearNotification(`domagent-request-${requestId}`);
    const windowId = await this.adapter.lastNormalWindow();
    const count = Math.max(1, request.urls.length);
    const created = [];
    try {
      for (let index = 0; index < count; index++) {
        created.push((await this.api.tabs.create({ windowId, url: 'about:blank', active: false })).id);
      }
      const groupId = await this.api.tabs.group({ tabIds: created, createProperties: { windowId } });
      await this.api.tabGroups.update(groupId, { title: request.title, color: request.agent.color, collapsed: false });
      const session = { client_id: crypto.randomUUID(), session_id: null, request_id: requestId,
        agent_id: request.agent.id, title: request.title, purpose: request.purpose, groupId, windowId, state: 'pending',
        tabs: new Map(), tasks: [], running: 0, creating: 0, excluded: 0, startTabs: created, startUrls: request.urls,
        color: request.agent.color };
      if (!this.agents.has(request.agent.id)) this.agents.set(request.agent.id, request.agent);
      this.send({ type: 'session.decision', request_id: requestId, approved: true, client_id: session.client_id });
      this.sessions.set(session.client_id, session);
    } catch (error) {
      if (created.length) await this.api.tabs.remove(created).catch(() => {});
      throw error;
    }
    this.changed();
  }
  declineSession(requestId) {
    if (!this.requests.delete(requestId)) fail('ACTION_EXPIRED');
    this.clearNotification(`domagent-request-${requestId}`);
    this.send({ type: 'session.decision', request_id: requestId, approved: false });
    this.changed();
  }
  async requestCancelled(requestId) {
    if (this.requests.delete(requestId)) this.clearNotification(`domagent-request-${requestId}`);
    const pending = [...this.sessions.values()].find(session => session.request_id === requestId && session.state === 'pending');
    if (pending) await this.discardPending(pending);
    this.changed();
  }
  async sessionCreated(message) {
    const session = [...this.sessions.values()].find(s => s.request_id === message.request_id && s.state === 'pending');
    if (!session || session.client_id !== message.client_id) return;
    validId(message.session_id);
    await this.commitPending(session, message.session_id);
  }
  async commitPending(session, sessionId) {
    validId(sessionId);
    Object.assign(session, { session_id: sessionId, state: 'attached', request_id: null });
    delete session.startTabs;
    this.addFeed({ session_id: session.session_id, agent_id: session.agent_id, kind: 'session', status: 'approved',
      description: `Session “${session.title}” started: ${session.purpose}` });
    await this.refresh();
    // Protection is installed before any starting URL loads.
    const urls = session.startUrls || [];
    const tabs = [...session.tabs.values()];
    for (let index = 0; index < urls.length && index < tabs.length; index++) {
      try {
        const url = navigationUrl(urls[index], this.protectedOrigins);
        tabs[index].navigation = { from: tabs[index].url, url };
        tabs[index].pageState = 'loading';
        await this.api.tabs.update(tabs[index].tabId, { url });
      } catch (error) { this.report(error); }
    }
    delete session.startUrls;
    this.buildMenus();
    this.persistSoon();
    await this.sync(true);
    this.changed();
  }
  async discardPending(session) {
    this.sessions.delete(session.client_id);
    // Only blank tabs exist before commit; nothing has loaded in them.
    if (session.startTabs?.length) await this.api.tabs.remove(session.startTabs).catch(() => {});
    this.changed();
  }
  async sessionEnded(message) {
    const session = this.sessions.get(message.client_id);
    if (!session) return;
    this.addFeed({ session_id: session.session_id, agent_id: session.agent_id, kind: 'session', status: 'cancelled',
      description: `Session “${session.title}” ended. Its tabs stay open.` });
    await this.closeLocal(session, true);
    await this.sync(true);
  }
  progress(message) {
    const session = [...this.sessions.values()].find(s => s.session_id === message.session_id);
    if (typeof message.message !== 'string') fail('INVALID_MESSAGE');
    this.addFeed({ kind: 'progress', session_id: message.session_id, agent_id: message.agent_id,
      title: session?.title || null, description: message.message.slice(0, 500), status: 'info' });
    this.changed();
  }

  // ---------- commands ----------
  findSession(sessionId) {
    return [...this.sessions.values()].find(session => session.session_id === sessionId) || null;
  }
  check(session, tab, task, after = false) {
    if (!this.connection || task.connection_id !== this.connection.connection_id) fail('BROWSER_OFFLINE');
    if (this.sessions.get(session.client_id) !== session || session.state !== 'attached') fail('SESSION_DETACHED');
    if (task.cancelled || (tab && session.tabs.get(tab.tabId) !== tab)) fail('TAB_NOT_IN_SESSION');
    if (task.deadline <= this.now()) fail(task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_EXPIRED');
    if (tab && task.documentGeneration !== tab.documentGeneration &&
        !['wait_for_page', 'request_handoff'].includes(task.message.operation) &&
        !(after && MUTATIONS.includes(task.message.operation))) fail('TARGET_STALE');
  }
  enqueue(message) {
    let session, tab, task;
    try {
      validId(message.request_id);
      session = this.findSession(message.session_id);
      if (!session || session.state !== 'attached') fail('SESSION_DETACHED');
      const create = message.operation === 'create_tab', confirm = CLOSE_OPERATIONS.includes(message.operation);
      const human = message.operation === 'request_handoff';
      if (!message.args || typeof message.args !== 'object' || Array.isArray(message.args)) fail('INVALID_ARGUMENT');
      if (!human && !validDescription(message.description)) fail('INVALID_ARGUMENT');
      // Tab lifecycle commands queue on the session, not on a tab.
      tab = create || confirm ? null : [...session.tabs.values()].find(t => t.id === message.tab_id);
      if (!create && !confirm && !tab) fail('TAB_NOT_IN_SESSION');
      if (create) {
        if (Object.keys(message.args).some(key => key !== 'url')) fail('INVALID_ARGUMENT');
        if (message.args.url !== undefined) navigationUrl(String(message.args.url), this.protectedOrigins);
      } else if (message.operation === 'close_tab') {
        if (Object.keys(message.args).some(key => key !== 'tab_id')) fail('INVALID_ARGUMENT');
        if (!this.sessionTab(session, message.args.tab_id)) fail('TAB_NOT_IN_SESSION');
      } else if (message.operation === 'close_session') {
        if (Object.keys(message.args).length) fail('INVALID_ARGUMENT');
      } else if (!validOperationArgs(message.operation, message.args)) fail('INVALID_ARGUMENT');
      const duration = message.wait_timeout_ms;
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > HUMAN_WAIT_MS) fail('INVALID_MESSAGE');
      task = { message, human, confirm, approved: false, deadline: this.now() + duration, documentGeneration: tab?.documentGeneration,
        executing: false, cancelled: false, connection_id: this.connection.connection_id };
      this.check(session, tab, task);
      const queue = tab?.queue || session.tasks;
      if (queue.length >= 16) fail('QUEUE_FULL');
      queue.push(task);
      this.addFeed({ id: message.request_id, kind: 'command', session_id: session.session_id, agent_id: session.agent_id,
        operation: message.operation, description: human ? message.args.instructions : message.description,
        title: tab?.title || session.title, status: human ? 'needs_help' : confirm ? 'needs_approval' : 'queued' });
      if (confirm) {
        this.closures.set(message.request_id, { session, task });
        const agent = this.agents.get(session.agent_id)?.name || 'Your agent';
        const what = message.operation === 'close_tab'
          ? `“${this.sessionTab(session, message.args.tab_id).title || 'a tab'}”`
          : `${session.tabs.size} tab${session.tabs.size === 1 ? '' : 's'} of “${session.title}”`;
        this.notify(`domagent-close-${message.request_id}`, `${agent} asks to close ${what}`,
          `${String(message.description).slice(0, 150)} — approve or keep open in the DomAgent window.`);
      }
      if (human) {
        this.handoffs.set(message.request_id, { session, tab, task });
        this.notify(`domagent-help-${message.request_id}`, `${this.agents.get(session.agent_id)?.name || 'Your agent'} needs your help`,
          String(message.args.instructions).slice(0, 180));
      }
      this.drain(session); this.changed();
    } catch (error) { this.result(message, { code: errorCode(error) }); }
  }
  drain(session) {
    if (session.state !== 'attached') return;
    const full = session.running >= SESSION_CONCURRENCY;
    for (const tab of [null, ...session.tabs.values()]) {
      const task = (tab?.queue || session.tasks)[0];
      if (!task || task.preparing || task.ready || task.executing || task.human) continue;
      // Close commands start only after the user approves them, and never wait for a page slot.
      if (task.confirm ? !task.approved : full) continue;
      task.preparing = true;
      void this.prepare(session, tab, task).catch(error => this.report(error));
    }
  }
  async prepare(session, tab, task) {
    try {
      this.check(session, tab, task);
      if (tab) {
        task.preview = await this.adapter.prepareAction(tab, task.message.operation, task.message.args,
          () => this.check(session, tab, task));
        this.check(session, tab, task);
      }
      task.ready = true;
      this.addFeed({ id: task.message.request_id, status: 'ready' });
      this.send({ type: 'command.ready', request_id: task.message.request_id });
    } catch (error) {
      if (tab && error.code === 'PAGE_UNAVAILABLE') { tab.pageState = 'unavailable'; void this.sync(); }
      this.finishTask(session, tab, task, { code: error.code === 'PAGE_UNAVAILABLE' ? 'DOCUMENT_NOT_CONTROLLABLE' : errorCode(error),
        ...inspectionErrorDetails(error), ...errorDetails(error),
        ...diagnosticDetails(error, { layer: 'extension', phase: 'preparation' }) });
    } finally { task.preparing = false; }
  }
  decideHandoff(requestId, action) {
    const entry = this.handoffs.get(requestId);
    if (!entry) fail('ACTION_EXPIRED');
    const { session, tab, task } = entry;
    this.check(session, tab, task);
    if (action === 'cancel') { this.finishTask(session, tab, task, { code: 'ACTION_DECLINED' }); return; }
    if (action !== 'done' || tab.queue[0] !== task) fail('INVALID_ARGUMENT');
    task.ready = true;
    this.send({ type: 'command.ready', request_id: requestId });
  }
  decideClose(requestId, approve) {
    const entry = this.closures.get(requestId);
    if (!entry) fail('ACTION_EXPIRED');
    const { session, task } = entry;
    this.check(session, null, task);
    if (!approve) { this.finishTask(session, null, task, { code: 'ACTION_DECLINED' }); return; }
    this.closures.delete(requestId);
    this.clearNotification(`domagent-close-${requestId}`);
    task.approved = true;
    this.addFeed({ id: requestId, status: 'approved' });
    this.drain(session); this.changed();
  }
  findTask(requestId) {
    for (const session of this.sessions.values()) {
      for (const tab of [null, ...session.tabs.values()]) {
        const task = (tab?.queue || session.tasks).find(task => task.message.request_id === requestId);
        if (task) return { session, tab, task };
      }
    }
    return null;
  }
  cancelCommand(message) {
    const found = this.findTask(message.request_id);
    if (found) this.finishTask(found.session, found.tab, found.task,
      { code: found.task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_CANCELLED' });
  }
  async executeReady(message) {
    const found = this.findTask(message.request_id);
    if (!found) return;
    const { session, tab, task } = found;
    const queue = tab?.queue || session.tasks;
    const unslotted = task.human || task.confirm;
    if (queue[0] !== task || !task.ready || task.executing || (task.confirm && !task.approved) ||
        (!unslotted && session.running >= SESSION_CONCURRENCY)) {
      this.finishTask(session, tab, task, { code: 'QUEUE_FULL' }); return;
    }
    if (!Number.isSafeInteger(message.execution_timeout_ms) || message.execution_timeout_ms <= 0 ||
        message.execution_timeout_ms > (task.human ? HUMAN_WAIT_MS : EXECUTION_MS)) fail('INVALID_MESSAGE');
    task.deadline = this.now() + message.execution_timeout_ms;
    task.executing = true;
    this.addFeed({ id: task.message.request_id, status: 'running' });
    if (!unslotted) session.running++;
    let timer, after = null;
    try {
      this.check(session, tab, task);
      let operation;
      if (task.human) operation = Promise.resolve({ state: 'completed', user_confirmed: true });
      else if (tab) operation = this.adapter.execute(tab, task.message.operation, task.message.args,
        after => this.check(session, tab, task, after), task.preview);
      else if (task.message.operation === 'close_tab') operation = this.closeTab(session, task);
      else if (task.message.operation === 'close_session') operation = this.closeSession(session, task);
      else operation = this.createTab(session, task);
      const timeout = new Promise((_, reject) => {
        task.abort = () => reject(Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN' }));
        timer = setTimeout(task.abort, message.execution_timeout_ms);
      });
      const value = await Promise.race([operation, timeout]);
      this.check(session, tab, task, true);
      if (tab && task.message.operation === 'navigate') await this.sync();
      this.finishTask(session, tab, task, null, boundedResult(value));
      after = task.after;
    } catch (error) {
      if (tab && error.code === 'PAGE_UNAVAILABLE') { tab.pageState = 'unavailable'; void this.sync(); }
      this.finishTask(session, tab, task, { code: error.code === 'PAGE_UNAVAILABLE' ? 'DOCUMENT_NOT_CONTROLLABLE' : errorCode(error),
        ...inspectionErrorDetails(error), ...waitErrorDetails(error), ...errorDetails(error),
        ...(error.dispatch_status === 'not_dispatched' ? { dispatch_status: 'not_dispatched' } : {}),
        ...diagnosticDetails(error, { layer: 'extension', phase: 'execution' }) });
    } finally {
      clearTimeout(timer); task.abort = null;
      if (!unslotted) session.running--;
      this.drain(session); this.changed();
    }
    // Runs after the receipt so the closing command is not itself ended with the session.
    if (after) await after().catch(error => this.report(error));
  }
  sessionTab(session, id) { return [...session.tabs.values()].find(tab => tab.id === id) || null; }
  async closeTab(session, task) {
    const tab = this.sessionTab(session, task.message.args.tab_id);
    if (!tab) fail('TAB_NOT_IN_SESSION');
    // The last tab takes the group with it, so the approved close ends the session.
    if (session.tabs.size === 1 && !session.creating) {
      task.after = () => this.endApprovedClose(session, [tab.tabId]);
      return { tab_id: tab.id, session_ended: true };
    }
    await this.api.tabs.remove(tab.tabId);
    if (session.tabs.get(tab.tabId) === tab) this.dropTab(session, tab, 'TAB_NOT_IN_SESSION');
    await this.sync(true);
    return { tab_id: tab.id, session_ended: false };
  }
  closeSession(session, task) {
    const tabIds = [...session.tabs.keys()];
    task.after = () => this.endApprovedClose(session, tabIds);
    return { tabs_closed: tabIds.length };
  }
  async endApprovedClose(session, tabIds) {
    this.addFeed({ session_id: session.session_id, agent_id: session.agent_id, kind: 'session', status: 'cancelled',
      description: `Session “${session.title}” ended. You approved closing its tabs.` });
    await this.closeLocal(session, true, tabIds);
    await this.sync(true);
  }
  async createTab(session, task) {
    if (session.tabs.size + session.creating >= SESSION_TAB_LIMIT) fail('TAB_LIMIT_REACHED');
    session.creating++;
    let created;
    try { created = await this.api.tabs.create({ windowId: session.windowId, url: 'about:blank', active: false }); }
    catch (error) { session.creating--; throw error; }
    try {
      this.check(session, null, task);
      await this.api.tabs.group({ groupId: session.groupId, tabIds: [created.id] });
      this.check(session, null, task);
      await this.refresh();
      let tab = session.tabs.get(created.id);
      if (!tab) fail('TAB_NOT_IN_SESSION');
      if (task.message.args.url) {
        const url = navigationUrl(task.message.args.url, this.protectedOrigins);
        tab.navigation = { from: tab.url, url }; tab.pageState = 'loading';
        await this.api.tabs.update(created.id, { url });
      }
      await this.sync(true);
      const deadline = this.now() + 5000;
      while (!tab.id) {
        this.check(session, null, task);
        if (this.now() >= deadline) fail('OUTCOME_UNKNOWN');
        await new Promise(resolve => setTimeout(resolve, 25));
        tab = session.tabs.get(created.id);
        if (!tab) fail('TAB_NOT_IN_SESSION');
      }
      return { tab_id: tab.id };
    } catch (error) {
      const tab = session.tabs.get(created.id);
      if (tab) this.dropTab(session, tab, 'TAB_NOT_IN_SESSION');
      await this.api.tabs.remove(created.id).catch(() => {});
      throw error;
    } finally { session.creating--; }
  }
  finishTask(session, tab, task, error, value) {
    if (task.cancelled) return;
    let status = 'complete';
    if (error?.code === 'OUTCOME_UNKNOWN') status = 'uncertain';
    else if (error && ['COMMAND_CANCELLED', 'ACTION_DECLINED', 'SESSION_ENDED', 'BROWSER_OFFLINE'].includes(error.code)) status = 'cancelled';
    else if (error) status = 'failed';
    this.addFeed({ id: task.message.request_id, status, ...(error ? { code: error.code } : {}) });
    task.cancelled = true; task.abort?.();
    const queue = tab?.queue || session.tasks;
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
    this.result(task.message, error, value);
    if (this.handoffs.delete(task.message.request_id)) this.clearNotification(`domagent-help-${task.message.request_id}`);
    if (this.closures.delete(task.message.request_id)) this.clearNotification(`domagent-close-${task.message.request_id}`);
    if (tab && task.preview) void this.adapter.releaseAction(tab, task.preview).catch(() => {});
    this.drain(session); this.changed();
  }
  result(message, error, value) {
    if (!this.connection) return;
    try { this.send({ type: 'result', request_id: message.request_id, ...(error ? { error } : { result: value }) }); }
    catch (failure) { this.report(failure); }
  }
  tabEvent(tabId, event, destination) {
    for (const session of this.sessions.values()) {
      const tab = session.tabs.get(tabId);
      if (!tab) continue;
      if (event === 'closed') { this.scheduleRefresh(); continue; }
      if (event === 'protected_pending') {
        // The guard blocks the request; queued work for the old document can no longer be trusted.
        for (const task of [...tab.queue]) if (!task.executing && !task.human) this.finishTask(session, tab, task, { code: 'HANDOFF_REQUIRED' });
        continue;
      }
      if (event !== 'navigation' && event !== 'navigation_pending') continue;
      if (event === 'navigation_pending') {
        tab.navigation = null;
        if (/^https?:/.test(destination || '')) {
          try { tab.navigation = { from: tab.url, url: navigationUrl(destination, this.protectedOrigins) }; }
          catch { continue; }
        }
      }
      tab.documentGeneration++;
      tab.pageState = 'loading';
      for (const task of [...tab.queue]) {
        if (task.executing || ['wait_for_page', 'request_handoff'].includes(task.message.operation)) continue;
        const freshRead = !task.ready && READ_OPERATIONS.includes(task.message.operation) &&
          !task.message.args.ref && !task.message.args.document;
        if (freshRead) task.documentGeneration = tab.documentGeneration;
        else this.finishTask(session, tab, task, { code: 'TARGET_STALE' });
      }
      this.scheduleRefresh();
    }
  }

  // ---------- native affordances ----------
  notify(id, title, message) {
    void this.api.notifications?.create(id, { type: 'basic', iconUrl: this.api.runtime.getURL('icons/icon128.png'),
      title, message }).catch(() => this.report(Object.assign(new Error('NOTIFICATION_UNAVAILABLE'), { code: 'NOTIFICATION_UNAVAILABLE' })));
  }
  clearNotification(id) { void this.api.notifications?.clear(id).catch(() => {}); }
  async focusApp() {
    if (this.appWindowId !== null) await this.api.windows.update(this.appWindowId, { focused: true });
  }
  async notificationClicked(id) {
    if (!id.startsWith('domagent-')) return;
    const help = id.startsWith('domagent-help-') && this.handoffs.get(id.slice('domagent-help-'.length));
    if (help) await this.adapter.focusTab(help.tab.tabId).catch(() => {});
    await this.focusApp();
  }
  async focusTab(tabId) { await this.adapter.focusTab(tabId); }
  buildMenus() {
    const menus = this.api.menus || this.api.contextMenus;
    if (!menus) return;
    const sessions = [...this.sessions.values()].filter(session => session.state === 'attached' && session.session_id);
    const signature = JSON.stringify(sessions.map(session => [session.client_id, session.title]));
    if (signature === this.menuSignature) return;
    this.menuSignature = signature;
    const create = properties => new Promise(resolve => {
      menus.create(properties, () => { void this.api.runtime.lastError; resolve(); });
    });
    this.menuWork = (this.menuWork || Promise.resolve()).then(async () => {
      await menus.removeAll();
      if (!sessions.length) return;
      const contexts = this.browserName === 'firefox' ? ['tab'] : ['page'];
      await create({ id: 'domagent-add', title: 'Add tab to DomAgent session', contexts });
      for (const session of sessions) {
        await create({ id: `domagent-add:${session.client_id}`, parentId: 'domagent-add',
          title: session.title.slice(0, 60) || 'Session', contexts });
      }
      await create({ id: 'domagent-remove', title: 'Remove tab from DomAgent session', contexts });
    }).catch(error => this.report(error));
  }
  async menuClicked(info, tab) {
    if (!tab || tab.id === undefined) return;
    const id = String(info.menuItemId);
    if (id === 'domagent-remove') {
      if ([...this.sessions.values()].some(session => session.tabs.has(tab.id))) await this.api.tabs.ungroup([tab.id]);
      return;
    }
    if (!id.startsWith('domagent-add:')) return;
    const session = this.sessions.get(id.slice('domagent-add:'.length));
    if (!session || session.state !== 'attached') fail('SESSION_DETACHED');
    await this.api.tabs.group({ groupId: session.groupId, tabIds: [tab.id] });
  }
  async tick() {
    if (this.socket && this.connection && this.now() - this.lastPing >= LIVENESS_MS) this.lost(this.socket, this.generation);
    if (this.pairing?.expires_at && this.pairing.expires_at <= this.now()) { this.pairing = null; this.changed(); }
    for (const [id, request] of this.requests) if (request.expires_at <= this.now()) {
      this.requests.delete(id); this.clearNotification(`domagent-request-${id}`); this.changed();
    }
    for (const session of this.sessions.values()) for (const tab of session.tabs.values()) {
      for (const task of [...tab.queue]) if (task.deadline <= this.now()) {
        this.finishTask(session, tab, task, { code: task.executing ? 'OUTCOME_UNKNOWN' : 'COMMAND_EXPIRED' });
      }
    }
    await this.paintGroups();
  }
  async paintGroups() {
    this.flashOn = !this.flashOn;
    const helping = new Set([...this.handoffs.values()].map(entry => entry.session.client_id));
    for (const session of this.sessions.values()) {
      if (session.state !== 'attached') continue;
      const color = this.agents.get(session.agent_id)?.color || agentColor(session.agent_id);
      const desired = helping.has(session.client_id) && this.flashOn ? 'grey' : color;
      if (session.painted === desired) continue;
      session.painted = desired;
      await this.api.tabGroups.update(session.groupId, { color: desired }).catch(() => {});
    }
  }
  /** Window closing: say goodbye so the server detaches sessions immediately. */
  shutdown() {
    this.closing = true;
    clearInterval(this.timer); clearTimeout(this.reconnectTimer);
    try { if (this.connection) this.send({ type: 'bye' }); } catch { /* best effort */ }
    try { this.socket?.close(1000, 'WINDOW_CLOSED'); } catch { /* best effort */ }
    for (const session of this.sessions.values()) for (const tab of session.tabs.values()) {
      void this.adapter.release(tab.tabId).catch(() => {});
    }
  }
}
