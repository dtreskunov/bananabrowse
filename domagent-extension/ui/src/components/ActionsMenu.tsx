import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import './ActionsMenu.css';

export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}
export function ActionsMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  function close(restoreFocus = false) { setOpen(false); if (restoreFocus) trigger.current?.focus(); }
  useLayoutEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div class={`action-menu${open ? ' open' : ''}`} ref={root}>
    <button class="icon-button" type="button" aria-label="Task actions" aria-haspopup="menu" aria-expanded={open}
      ref={trigger} onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg>
    </button>
    {open && <div class="action-panel" role="menu" aria-label="Task actions" ref={menu} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'Tab') close();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.findIndex(button => button === document.activeElement);
        let next = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        buttons[next]?.focus();
      }
    }}>
      {items.map(item => <button type="button" role="menuitem" class={`action-item${item.danger ? ' danger' : ''}`}
        key={item.label} disabled={item.disabled} onClick={() => { close(true); item.action(); }}>{item.label}</button>)}
    </div>}
  </div>;
}
