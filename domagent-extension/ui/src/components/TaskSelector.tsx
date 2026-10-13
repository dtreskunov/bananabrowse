import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { TaskGroup } from '../types';
import { groupDetail } from '../presentation';
import './TaskSelector.css';

export function TaskSelector({ groups, value, onChange, disabled }: {
  groups: TaskGroup[]; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const options = [{ value: 'new', title: 'New task group', detail: 'Start with a fresh background tab' },
    ...groups.map((group, index) => ({ value: String(group.groupId), title: group.title, detail: groupDetail(group, index) }))];
  const selected = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function select(index: number) { const option = options[index]; if (option) onChange(option.value); setOpen(false); }
  return <div class="task-selector" ref={root}>
    <span class="section-label" id={`${id}-label`}>Task tabs</span>
    <button type="button" class="task-select-trigger" role="combobox" aria-labelledby={`${id}-label`}
      aria-haspopup="listbox" aria-controls={`${id}-options`} aria-expanded={open}
      aria-activedescendant={open ? `${id}-option-${highlighted}` : undefined} disabled={disabled}
      onClick={() => { setHighlighted(Math.max(0, options.findIndex(option => option.value === value))); setOpen(!open); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
        else if (event.key === 'Tab') setOpen(false);
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (open) select(highlighted); else setOpen(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) { setOpen(true); setHighlighted(Math.max(0, options.findIndex(option => option.value === value))); }
          else {
            let next = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = options.length - 1;
            setHighlighted(next);
          }
        }
      }}>
      <span class="select-copy"><span>{selected?.title || 'Choose a task group'}</span>
        <small>{selected?.detail || 'Your existing groups remain open and inactive'}</small></span>
      <svg class="line-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
    </button>
    {open && <div class="task-options" role="listbox" aria-labelledby={`${id}-label`} id={`${id}-options`}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} class={`task-option${index === highlighted ? ' highlighted' : ''}`}
        onPointerMove={() => setHighlighted(index)} onMouseDown={event => event.preventDefault()} onClick={() => select(index)}>
        <span>{option.title}</span><small>{option.detail}</small>
      </div>)}
    </div>}
  </div>;
}
