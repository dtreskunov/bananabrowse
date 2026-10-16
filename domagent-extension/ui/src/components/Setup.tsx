import { useState } from 'preact/hooks';
import { act, busy, controller, localError, suggestedName, api } from '../runtime';
import { hostOf } from '../presentation';
import type { Snapshot } from '../presentation';
import { Notice } from './Primitives';
import './Setup.css';

export function Setup({ snapshot }: { snapshot: Snapshot }) {
  const [domain, setDomain] = useState(hostOf(snapshot.last_setup?.origin) || '');
  const [name, setName] = useState(snapshot.last_setup?.name || suggestedName());
  const submit = (event: Event) => {
    event.preventDefault();
    void act('Connecting', async () => {
      const input = domain.trim();
      const origin = new URL(input.includes('://') ? input : `https://${input}`).origin;
      // Ask before any other await so the browser still sees this click.
      if (!(await api.permissions.request({ origins: [`${origin}/*`] }))) {
        throw Object.assign(new Error('PERMISSION_REQUIRED'), { code: 'PERMISSION_REQUIRED' });
      }
      await controller.setup({ domain: origin, name });
    });
  };
  return (
    <main class="setup">
      <h1>Set up DomAgent</h1>
      <p class="muted">
        Connect this browser to your DomAgent server. Your agent can then ask to work in tab groups you approve.
      </p>
      <form onSubmit={submit}>
        <label for="domain">Server</label>
        <input
          id="domain"
          required
          placeholder="domagent.example.com"
          value={domain}
          autoComplete="url"
          onInput={(event) => setDomain(event.currentTarget.value)}
        />
        <label for="name">Name for this browser</label>
        <input id="name" required maxLength={80} value={name} onInput={(event) => setName(event.currentTarget.value)} />
        <small class="muted">Shown to your agents, for example “Bob's Firefox on Mac”.</small>
        <button class="primary wide" type="submit" disabled={busy.value !== null}>
          {busy.value || 'Connect'}
        </button>
      </form>
      <Notice code={localError.value || (snapshot.error === 'BROWSER_REVOKED' ? snapshot.error : null)} />
    </main>
  );
}
