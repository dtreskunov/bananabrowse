import { isRecord } from './types';

export interface ThemeApi {
  getCurrent(windowId: number): Promise<unknown>;
  onUpdated: { addListener(listener: (update: unknown) => void): void };
}
const colors: Record<string, string[]> = {
  '--surface': ['sidebar', 'popup', 'toolbar'],
  '--surface-fg': ['sidebar_text', 'popup_text', 'toolbar_text', 'tab_text'],
  '--border': ['sidebar_border', 'popup_border', 'toolbar_field_border'],
  '--primary': ['sidebar_highlight', 'popup_highlight'],
  '--primary-fg': ['sidebar_highlight_text', 'popup_highlight_text'],
};
function cssColor(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length >= 3 && value.length <= 4 &&
      value.every(part => typeof part === 'number')) {
    return `rgba(${value.slice(0, 3).join(',')},${value[3] ?? 1})`;
  }
  return '';
}
export function applyBrowserTheme(theme: unknown): void {
  const root = document.documentElement;
  const values = isRecord(theme) && isRecord(theme.colors) ? theme.colors : {};
  for (const [token, keys] of Object.entries(colors)) {
    root.style.removeProperty(token);
    for (const key of keys) {
      const value = values[key];
      if (value === undefined) continue;
      const color = cssColor(value);
      if (!color || !CSS.supports('color', color)) {
        console.warn('DomAgent theme color is invalid:', key); continue;
      }
      root.style.setProperty(token, color); break;
    }
  }
  const properties = isRecord(theme) && isRecord(theme.properties) ? theme.properties : {};
  const scheme = properties.color_scheme;
  root.style.colorScheme = scheme === 'light' || scheme === 'dark' ? scheme : '';
}
export async function initializeTheme(api: ThemeApi | undefined, windowId: number): Promise<void> {
  if (!api) return;
  applyBrowserTheme(await api.getCurrent(windowId));
  api.onUpdated.addListener(update => {
    if (!isRecord(update) || (update.windowId !== undefined && update.windowId !== windowId)) return;
    applyBrowserTheme(update.theme);
  });
}
