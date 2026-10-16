import { signal } from '@preact/signals';
import { Controller, defaultBrowserName } from '../../src/controller.js';
import { BrowserAdapter } from '../../src/adapter.js';
import { Identity } from '../../src/keys.js';
import { browserApi } from '../../src/browser-api.js';
import { initializeTheme } from './theme';
import type { Snapshot } from './presentation';

export const api = browserApi();
export const browserName: 'chrome' | 'firefox' = api.runtime.getBrowserInfo ? 'firefox' : 'chrome';
export const state = signal<Snapshot | null>(null);
export const busy = signal<string | null>(null);
export const localError = signal<string | null>(null);
export const duplicate = signal(false);
export const now = signal(Date.now());
export let controller: Controller;

export function suggestedName(): string {
  return defaultBrowserName(browserName);
}

function code(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : 'INVALID_MESSAGE';
}

/** Runs a user action. Permission prompts must be the first await inside `operation` to keep the click gesture. */
export async function act(label: string, operation: () => Promise<unknown> | unknown): Promise<void> {
  if (busy.value) return;
  busy.value = label;
  localError.value = null;
  try {
    await operation();
    // eslint-disable-next-line no-catch-all/no-catch-all -- UI action boundary: every failure is shown to the user
  } catch (error) {
    localError.value = code(error);
    console.error('DomAgent:', code(error));
  } finally {
    busy.value = null;
  }
}

export async function requestSitePermission(): Promise<void> {
  if (!(await api.permissions.request({ origins: ['http://*/*', 'https://*/*'] }))) {
    throw Object.assign(new Error('PERMISSION_REQUIRED'), { code: 'PERMISSION_REQUIRED' });
  }
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw Object.assign(new Error('CLIPBOARD_UNAVAILABLE'), { code: 'CLIPBOARD_UNAVAILABLE' });
  }
}

function saveBounds(): void {
  void api.storage.local
    .set({
      bounds: { width: window.outerWidth, height: window.outerHeight, left: window.screenX, top: window.screenY },
    })
    .catch(() => {});
}

export async function boot(): Promise<void> {
  const own = await api.windows.getCurrent();
  const { appWindowId } = await api.storage.session.get<{ appWindowId?: unknown }>('appWindowId');
  if (typeof appWindowId === 'number' && Number.isInteger(appWindowId) && appWindowId !== own.id) {
    try {
      await api.windows.get(appWindowId);
      duplicate.value = true;
      return;
      // eslint-disable-next-line no-catch-all/no-catch-all -- windows.get rejects untyped when the window is gone; the record is stale
    } catch {
      /* stale record */
    }
  }
  await api.storage.session.set({ appWindowId: own.id });
  controller = new Controller({
    api,
    adapter: new BrowserAdapter(api, browserName),
    identity: new Identity(),
    storage: api.storage.local,
    sessionStorage: api.storage.session,
    browserName,
    extensionUrl: api.runtime.getURL(''),
    appWindowId: own.id,
  });
  controller.subscribe(() => {
    state.value = controller.snapshot() as Snapshot;
  });
  // Diagnostics handle for this privileged extension page only (web pages cannot reach it).
  (globalThis as any).domagent = { controller };
  window.addEventListener('beforeunload', (event) => {
    // Closing the window ends browser control; ask first while connected.
    if (controller.phase === 'online') {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    saveBounds();
    controller.shutdown();
  });
  let resize: ReturnType<typeof setTimeout>;
  window.addEventListener('resize', () => {
    clearTimeout(resize);
    resize = setTimeout(saveBounds, 500);
  });
  setInterval(() => {
    now.value = Date.now();
  }, 1000);
  void initializeTheme(api.theme, own.id!).catch(() => {});
  await controller.initialize();
  state.value = controller.snapshot() as Snapshot;
}

export function focusExisting(): void {
  void api.runtime
    .sendMessage({ type: 'open-app' })
    .then(() => window.close())
    .catch(() => {});
}
