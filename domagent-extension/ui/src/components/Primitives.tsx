import type { ComponentChildren } from 'preact';
import { failureMessage } from '../presentation';
import './Primitives.css';

const COLORS: Record<string, string> = {
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#e8a600',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#e8710a',
  grey: '#5f6368',
};

export function Dot({ color }: { color?: string }) {
  return <span class="agent-dot" style={{ background: COLORS[color || 'grey'] || COLORS.grey }} aria-hidden="true" />;
}
export function Notice({ code }: { code: string | null }) {
  if (!code) return null;
  return (
    <p class="notice" role="alert">
      {failureMessage(code)}
    </p>
  );
}
export function Actions({ children }: { children: ComponentChildren }) {
  return <div class="actions">{children}</div>;
}
