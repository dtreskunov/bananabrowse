// @types/chrome describes the shared WebExtension surface (and types the `browser` global as `typeof chrome`).
// Members that only one browser provides are optional because callers feature-detect them at runtime.
interface FirefoxTabs {
  captureTab(tabId: number, options?: { format?: 'jpeg' | 'png' }): Promise<string>;
}
interface FirefoxRuntime {
  getBrowserInfo(): Promise<{ name: string; vendor: string; version: string; buildID: string }>;
}
interface FirefoxSessions {
  getTabValue<T = unknown>(tabId: number, key: string): Promise<T | undefined>;
  setTabValue(tabId: number, key: string, value: unknown): Promise<void>;
  removeTabValue(tabId: number, key: string): Promise<void>;
}
export interface ThemeApi {
  getCurrent(windowId: number): Promise<unknown>;
  onUpdated: { addListener(listener: (update: unknown) => void): void };
}

export type BrowserApi = Omit<typeof chrome, 'tabs' | 'runtime' | 'sessions' | 'webRequest' | 'userScripts'> & {
  tabs: typeof chrome.tabs & Partial<FirefoxTabs>;
  runtime: typeof chrome.runtime & Partial<FirefoxRuntime>;
  sessions?: typeof chrome.sessions & Partial<FirefoxSessions>;
  webRequest?: typeof chrome.webRequest;
  userScripts?: typeof chrome.userScripts;
  menus?: typeof chrome.contextMenus;
  theme?: ThemeApi;
};

/** Tabs returned by query/create always carry an id; only devtools/foreign tabs omit it. */
export type IdentifiedTab = chrome.tabs.Tab & { id: number };

export function browserApi(): BrowserApi {
  return typeof browser === 'undefined' ? chrome : browser;
}
