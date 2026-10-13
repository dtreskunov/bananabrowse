import { signal } from '@preact/signals';
import { decodeSnapshot, isRecord } from './types';
import type { Snapshot } from './types';
import { suggestedSelection } from './presentation';
import { serviceOrigin } from '../../../shared/protocol.js';

interface Port {
  postMessage(message: { type: string; windowId: number }): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
interface BrowserApi {
  runtime: {
    sendMessage(message: Record<string, unknown>): Promise<unknown>;
    connect(options: { name: string }): Port;
    openOptionsPage(): Promise<void>;
  };
  windows: { getCurrent(): Promise<{ id?: number }> };
  permissions: { request(options: { origins: string[] }): Promise<boolean> };
  sidePanel?: { open(options: { windowId: number }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
}
declare const browser: BrowserApi | undefined;
declare const chrome: BrowserApi;
export const api = typeof browser === 'undefined' ? chrome : browser;
export const snapshot = signal<Snapshot | null>(null);
export const busy = signal<string | null>(null);
export const localError = signal<string | null>(null);
export const selection = signal<string | null>(null);
export const isPanel = location.pathname === '/panel.html';
let windowId: number;

export function report(error: unknown): void {
  const code = error instanceof Error ? error.message : 'INVALID_MESSAGE';
  localError.value = code;
  console.error('DomAgent UI:', code);
}
export async function request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  const response = await api.runtime.sendMessage({ type: `ui.${type}`, ...fields });
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(isRecord(response) && isRecord(response.error) && typeof response.error.code === 'string'
      ? response.error.code : 'BROWSER_OFFLINE');
  }
  return response.value;
}
function receive(value: unknown): void {
  const next = decodeSnapshot(value);
  snapshot.value = next;
  selection.value = suggestedSelection(next, selection.value);
}
export async function refresh(): Promise<void> {
  receive(await request('state', isPanel ? { windowId } : {}));
}
export async function run(label: string, operation: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = label; localError.value = null;
  try { await operation(); await refresh(); } catch (error) { report(error); }
  finally { busy.value = null; }
}
export function chooseGroup(value: string): void {
  selection.value = value;
  localError.value = null;
}
export function openPanel(): Promise<void> {
  if (api.sidePanel) return api.sidePanel.open({ windowId });
  if (api.sidebarAction) return api.sidebarAction.open();
  return Promise.reject(new Error('PLATFORM_UNSUPPORTED'));
}
async function waitForConnection(): Promise<void> {
  if (snapshot.value?.phase === 'authenticated') return;
  if (!['connecting', 'authenticating', 'proving'].includes(snapshot.value?.phase || '')) await request('connect');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await refresh();
    if (snapshot.value?.phase === 'authenticated') return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('BROWSER_OFFLINE');
}
export async function continueTask(): Promise<void> {
  const selected = selection.value;
  if (!selected) throw new Error('GROUP_UNAVAILABLE');
  // Ask synchronously within the local click gesture, before any connection work.
  if (!await api.permissions.request({ origins: ['http://*/*', 'https://*/*'] })) throw new Error('PERMISSION_REQUIRED');
  await waitForConnection();
  if (selected === 'new') {
    await request('startNew', { windowId });
    selection.value = null;
  } else {
    const groupId = Number(selected);
    if (!Number.isSafeInteger(groupId) || !snapshot.value?.available_groups?.some(group => group.groupId === groupId)) {
      throw new Error('GROUP_UNAVAILABLE');
    }
    await request('start', { windowId, groupId });
  }
}
export async function configure(domain: string): Promise<void> {
  const input = domain.trim();
  const origin = serviceOrigin(input.includes('://') ? input : `https://${input}`);
  if (!await api.permissions.request({ origins: [`${origin}/*`] })) throw new Error('PERMISSION_REQUIRED');
  await request('configure', { service_origin: origin });
}
export async function confirmPairing(): Promise<void> {
  const permission = api.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  const opening = openPanel();
  const [granted] = await Promise.all([permission, opening]);
  if (!granted) throw new Error('PERMISSION_REQUIRED');
  await request('confirmPairing');
  await waitForConnection();
  await request('start', { windowId });
}
export async function copyCode(code: string): Promise<void> {
  try { await navigator.clipboard.writeText(code); }
  catch { throw new Error('CLIPBOARD_UNAVAILABLE'); }
}
export async function initialize(): Promise<void> {
  const current = await api.windows.getCurrent();
  if (!Number.isSafeInteger(current.id)) throw new Error('INVALID_MESSAGE');
  windowId = current.id!;
  if (isPanel) {
    const port = api.runtime.connect({ name: 'domagent-panel' });
    const heartbeat = () => {
      try { port.postMessage({ type: 'heartbeat', windowId }); }
      catch (error) { report(error); }
    };
    const timer = setInterval(heartbeat, 1000);
    port.onMessage.addListener(message => {
      try { if (isRecord(message) && message.type === 'state') receive(message.value); }
      catch (error) { report(error); }
    });
    port.onDisconnect.addListener(() => {
      clearInterval(timer);
      // Do not keep an active-looking screen when its trusted panel port is gone.
      if (snapshot.value) snapshot.value = { ...snapshot.value, phase: 'disconnected',
        workspaces: snapshot.value.workspaces.map(workspace => ({ ...workspace, state: 'inactive', acknowledged: false })) };
      report(new Error('PANEL_OPEN_REQUIRED'));
    });
    window.addEventListener('pagehide', () => { clearInterval(timer); port.disconnect(); }, { once: true });
    heartbeat();
  } else {
    const timer = setInterval(() => { if (!busy.value) void refresh().catch(report); }, 1500);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  }
  await refresh();
}
