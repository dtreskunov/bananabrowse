import { useState } from 'preact/hooks';
import type { Snapshot } from './types';
import { busy, configure, confirmPairing, copyCode, localError, openPanel, request, run } from './client';
import { Notice } from './components/Notice';

export function Setup({ snapshot }: { snapshot: Snapshot }) {
  const [domain, setDomain] = useState(snapshot.config.service_origin || '');
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const pairing = snapshot.pairing;
  const connected = snapshot.identity !== null && !editing && !pairing;
  const client = snapshot.identity?.client_label || snapshot.identity?.tenant_label || 'Your assistant';
  return <main class="setup">
    <h1>{connected ? 'Assistant connected' : 'Connect DomAgent'}</h1>
    <p class="intro" id="status" role="status">{connected ? `${client} is paired with this browser.` :
      'Connect once. Then choose a task group in your browser sidebar.'}</p>
    <Notice code={localError.value || snapshot.current_error}/>
    {connected ? <>
      <button type="button" id="open-panel" class="primary main-action"
        disabled={busy.value !== null} onClick={() => void run('Opening dashboard', openPanel)}>Open dashboard</button>
      <p class="intro">Opening the dashboard alone does not authorize an old task. Use Continue in the toolbar popup or dashboard when ready.</p>
      <button type="button" class="text-button" onClick={() => setEditing(true)}>Change service or pair again</button>
    </> : pairing && !editing ? <section id="pairing" aria-label="Pairing">
      <p>Tell your assistant this code:</p>
      <output class="pairing-code" aria-label="Pairing code">{pairing.code}</output>
      <div class="pairing-copy"><small>Expires {new Date(pairing.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
        <button type="button" class="text-button" disabled={busy.value !== null} onClick={() => void run('Copying code', async () => {
          await copyCode(pairing.code); setCopied(true);
        })}>{copied ? 'Copied' : 'Copy code'}</button></div>
      {pairing.state === 'proposed' ? <>
        <p class="pairing-label">{pairing.proposal?.client_label || 'An assistant'} wants to connect.</p>
        <p class="muted">The application name is not a verified human identity. Confirm only the assistant you asked to adopt this code.</p>
        <p class="intro">Start opens a task group using your normal logins. Its tabs can be controlled in the background,
          including page JavaScript. Tasks keep running with the dashboard closed. Pause or End stops new control,
          but cannot undo actions already started.</p>
        <button type="button" class="primary main-action" disabled={busy.value !== null}
          onClick={() => void run('Connecting assistant', confirmPairing)}>{busy.value || 'Connect and start workspace'}</button>
        <button type="button" class="text-button" disabled={busy.value !== null}
          onClick={() => void run('Declining pairing', () => request('cancelPairing'))}>Decline</button>
      </> : <p class="muted">Waiting for your assistant. It needs its own authenticated MCP connection; this code is not a credential.</p>}
      <div class="secondary"><button type="button" class="text-button" disabled={busy.value !== null}
        onClick={() => void run('Getting a new code', async () => { await request('pairAgain'); setCopied(false); })}>Start again</button>
        <button type="button" class="text-button" disabled={busy.value !== null} onClick={() => {
          setEditing(true); setCopied(false);
        }}>Change service</button></div>
    </section> : <form id="config" onSubmit={event => {
      event.preventDefault();
      void run('Connecting', async () => { await configure(domain); setEditing(false); });
    }}>
      <label for="domain">Service domain</label>
      <input id="domain" required placeholder="domagent.example.org" value={domain} autoComplete="url" spellcheck={false}
        onInput={event => setDomain(event.currentTarget.value)}/>
      <button type="submit" class="primary main-action" disabled={busy.value !== null}>{busy.value || 'Continue'}</button>
      <p class="intro">No DomAgent account login is needed. The service must use HTTPS.</p>
      {snapshot.identity && <button type="button" class="text-button" onClick={() => setEditing(false)}>Back to connection</button>}
    </form>}
    <footer class="access-footer"><p>Browser-local confirmation is required. Nothing is authorized by a code alone.</p></footer>
  </main>;
}
