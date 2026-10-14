import type { Snapshot } from '../types';
import { busy, request, run } from '../client';

export function AccessRequest({ snapshot }: { snapshot: Snapshot }) {
  const pending = snapshot.access_requests?.[0];
  if (!pending) return null;
  return <section class="access-request" aria-label="Browser access request">
    <h2>Browser access requested</h2>
    <p>{snapshot.identity?.client_label || 'Your assistant'} is waiting.</p>
    <p class="request-intent">{pending.description}</p>
    <small>Review Task tabs, then Continue to allow control. Opening this prompt alone grants nothing.</small>
    <button type="button" class="text-button" disabled={busy.value !== null}
      onClick={() => void run('Declining request', () => request('declineAccess', { request_id: pending.request_id }))}>
      Decline request
    </button>
  </section>;
}
