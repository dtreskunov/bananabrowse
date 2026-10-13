import { useState } from 'preact/hooks';
import { busy, copyText, run } from '../client';

export function HandoffText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div class="handoff-text">
    <label>Suggested text<textarea readOnly value={text} aria-label="Suggested text"/></label>
    <button type="button" disabled={busy.value !== null} onClick={() => void run('Copying text', async () => {
      await copyText(text); setCopied(true);
    })}>{copied ? 'Copied' : 'Copy text'}</button>
    <small>Copy does not send anything or mark the task Done.</small>
  </div>;
}
