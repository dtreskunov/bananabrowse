import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store, hash } from '../store.js';
import { createApp } from '../app.js';
import {
  keyId,
  sign,
  registerPayload,
  tokenPayload,
  connectPayload,
  VERSION,
  OPERATIONS,
} from '../../shared/protocol.js';

export const ORIGIN = 'https://service.test';
export const EXTENSION = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const DESCRIPTION = 'Read the requested page details in this approved browser session.';
export const AGENT_KEY = 'bb_atlas-test-key-0123456789abcdef';
export const OTHER_KEY = 'bb_orion-test-key-0123456789abcdef';
export const THIRD_KEY = 'bb_vega-test-key-0123456789abcdef0';
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function start(options = {}) {
  const store = new Store(':memory:', { now: options.now });
  const agents = new Map([
    ['atlas', { id: 'atlas', name: 'Atlas', url: 'https://atlas.example/', key_hash: hash(AGENT_KEY) }],
    ['orion', { id: 'orion', name: 'Orion', url: null, key_hash: hash(OTHER_KEY) }],
    ['vega', { id: 'vega', name: 'Vega', url: null, key_hash: hash(THIRD_KEY) }],
  ]);
  const config = {
    origin: ORIGIN,
    bind: '127.0.0.1',
    port: 0,
    protectedOrigins: [ORIGIN, 'https://control.test'],
    agents,
    ...options,
  };
  const app = createApp(store, config);
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [];
  return {
    app,
    store,
    base,
    hub: app.hub,
    async mcp(agent = 'atlas', key = AGENT_KEY) {
      const client = new Client({ name: 'fixture', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp/${agent}`), {
          requestInit: { headers: { Authorization: `Bearer ${key}` } },
        }),
      );
      clients.push(client);
      return {
        client,
        async call(name, args = {}) {
          const result = await client.callTool({ name, arguments: args });
          const text = result.content?.[0]?.text;
          const value = text ? JSON.parse(text) : result.content?.[0];
          if (result.isError) throw Object.assign(new Error(value.error), { code: value.error, details: value });
          return value;
        },
      };
    },
    async close() {
      for (const client of clients) await client.close().catch(() => {});
      await app.close();
      store.close();
    },
  };
}

/** A scripted extension: registers, authenticates and speaks the v6 wire protocol. */
export class FakeExtension {
  constructor(base, { origin = EXTENSION, name = "Bob's Chrome", extensionVersion = '0.9.0' } = {}) {
    Object.assign(this, {
      base,
      origin,
      name,
      extensionVersion,
      messages: [],
      waiters: [],
      groups: new Map(),
      autoReady: true,
      handlers: {},
    });
  }
  async http(path, body) {
    const response = await fetch(`${this.base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Origin: this.origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error, status: response.status });
    return value;
  }
  async register() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    this.key = pair.privateKey;
    this.public_key = await crypto.subtle.exportKey('jwk', pair.publicKey);
    this.key_id = await keyId(this.public_key);
    const { nonce } = await this.http('/api/challenge');
    const data = { name: this.name, key_id: this.key_id, public_key: this.public_key, nonce };
    data.signature = await sign(this.key, registerPayload({ ...data, origin: ORIGIN, extension_origin: this.origin }));
    const result = await this.http('/api/browsers', data);
    Object.assign(this, {
      browser_id: result.browser_id,
      refresh_token: result.refresh_token,
      access_token: result.access_token,
    });
    return result;
  }
  async refresh() {
    const { nonce } = await this.http('/api/challenge');
    const data = { browser_id: this.browser_id, refresh_token: this.refresh_token, nonce };
    data.signature = await sign(this.key, tokenPayload({ ...data, origin: ORIGIN, key_id: this.key_id }));
    const result = await this.http('/api/token', data);
    this.previous_refresh = this.refresh_token;
    Object.assign(this, { refresh_token: result.refresh_token, access_token: result.access_token });
    return result;
  }
  async connect() {
    this.ws = new WebSocket(`${this.base.replace('http', 'ws')}/extension`, { headers: { Origin: this.origin } });
    this.ws.on('message', (raw) => this.receive(JSON.parse(raw.toString())));
    this.closed = new Promise((resolve) =>
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.send({
      type: 'hello',
      version: VERSION,
      access_token: this.access_token,
      browser_info: { extension_version: this.extensionVersion, browser_name: 'chrome', browser_version: '150.0' },
    });
    const challenge = await this.next('challenge');
    this.send({
      type: 'proof',
      signature: await sign(
        this.key,
        connectPayload({
          origin: ORIGIN,
          nonce: challenge.nonce,
          browser_id: this.browser_id,
          connection_id: challenge.connection_id,
        }),
      ),
    });
    this.welcome = await this.next('welcome');
    return this.welcome;
  }
  send(message) {
    this.ws.send(JSON.stringify(message));
  }
  receive(message) {
    this.messages.push(message);
    for (const waiter of [...this.waiters])
      if (waiter.match(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
        break;
      }
    if (message.type === 'ping') this.send({ type: 'pong' });
    const handler = this.handlers[message.type];
    if (handler) void Promise.resolve(handler(message)).catch((error) => console.error('fake handler', error));
  }
  next(type, predicate = () => true, timeout = 3000) {
    const index = this.messages.findIndex(
      (message) => message.type === type && predicate(message) && !message.consumed,
    );
    if (index >= 0) {
      this.messages[index].consumed = true;
      return Promise.resolve(this.messages[index]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (m) => m.type === type && predicate(m),
        resolve: (m) => {
          m.consumed = true;
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
  async pairingCode(code = 'K7MP-4QTX') {
    this.send({ type: 'pairing.code', code });
    await this.next('pairing.code.ok');
    return code;
  }
  inventory() {
    return [...this.groups.values()].map((group) => ({
      client_id: group.client_id,
      title: group.title,
      state: group.state || 'attached',
      ...(group.request_id ? { request_id: group.request_id } : {}),
      tabs: group.tabs.map((tab) => ({
        id: tab.id ?? null,
        key: tab.key,
        title: tab.title,
        url: tab.url,
        page_state: tab.page_state || 'ready',
        capabilities: tab.capabilities || [...OPERATIONS],
      })),
    }));
  }
  async sync() {
    this.send({ type: 'sync', groups: this.inventory() });
    const ack = await this.next('sync.ack');
    for (const assignment of ack.assignments) {
      const tab = this.groups.get(assignment.client_id)?.tabs.find((tab) => tab.key === assignment.key);
      if (tab) tab.id = assignment.id;
    }
    for (const id of ack.unknown) this.groups.delete(id);
    return ack;
  }
  /** Approve the next session request with the given tabs, as the real window would. */
  async approveNext(
    tabs = [
      { key: 101, title: 'Blank', url: 'about:blank', page_state: 'navigation_only', capabilities: ['navigate'] },
    ],
  ) {
    const request = await this.next('session.request');
    const client_id = crypto.randomUUID();
    this.groups.set(client_id, { client_id, title: request.title, request_id: request.request_id, tabs });
    this.send({ type: 'session.decision', request_id: request.request_id, approved: true, client_id });
    const created = await this.next('session.created', (m) => m.request_id === request.request_id);
    const group = this.groups.get(client_id);
    delete group.request_id;
    group.session_id = created.session_id;
    await this.sync();
    return { request, created, group };
  }
  /** Execute commands immediately with a canned result. */
  serve(result = (command) => ({ ok: true, operation: command.operation })) {
    this.handlers.command = (command) => {
      if (this.autoReady) this.send({ type: 'command.ready', request_id: command.request_id });
      this.pending = this.pending || new Map();
      this.pending.set(command.request_id, command);
    };
    this.handlers['command.execute'] = async (message) => {
      const command = this.pending.get(message.request_id);
      const value = await result(command);
      if (value && value.error) this.send({ type: 'result', request_id: message.request_id, error: value.error });
      else this.send({ type: 'result', request_id: message.request_id, result: value });
    };
  }
  close() {
    this.ws?.close();
  }
}

export async function paired(fixture, options = {}) {
  const extension = new FakeExtension(fixture.base, options);
  await extension.register();
  await extension.connect();
  await extension.sync();
  const agent = await fixture.mcp();
  const code = await extension.pairingCode();
  const pairing = agent.call('pair_browser', { code });
  const proposal = await extension.next('pairing.proposal');
  extension.send({ type: 'pairing.decision', request_id: proposal.request_id, approved: true });
  await pairing;
  return { extension, agent };
}
