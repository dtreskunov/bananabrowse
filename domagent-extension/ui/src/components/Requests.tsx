import { useState } from 'preact/hooks';
import { act, busy, controller, requestSitePermission } from '../runtime';
import { hostOf, splitUrl } from '../presentation';
import type { ClosureView, HandoffView, RequestView, SessionView, Snapshot } from '../presentation';
import { Dot, Actions } from './Primitives';
import './Requests.css';

export function Requests({ snapshot }: { snapshot: Snapshot }) {
  const proposal = snapshot.pairing?.proposal;
  const reattach = snapshot.sessions.filter(session => session.state === 'unconfirmed');
  if (!proposal && !snapshot.requests.length && !snapshot.handoffs.length && !snapshot.closures.length && !reattach.length) return null;
  return <section class="requests" aria-label="Waiting for you">
    {proposal && <article class="card">
      <h2><Dot color="grey"/>Pair with {proposal.agent.name}?</h2>
      {proposal.agent.url && <p class="muted">{hostOf(proposal.agent.url)}</p>}
      <p>{proposal.agent.name} will be able to ask to open browser sessions here. You approve each one.</p>
      <Actions>
        <button class="primary" disabled={busy.value !== null} onClick={() => void act('Pairing', () => controller.decidePairing(true))}>Approve</button>
        <button disabled={busy.value !== null} onClick={() => void act('Declining', () => controller.decidePairing(false))}>Decline</button>
      </Actions>
    </article>}
    {snapshot.requests.map(request => <SessionRequest key={request.request_id} request={request}/>)}
    {snapshot.handoffs.map(handoff => <Handoff key={handoff.request_id} handoff={handoff}/>)}
    {snapshot.closures.map(closure => <Closure key={closure.request_id} closure={closure}/>)}
    {reattach.map(session => <Reattach key={session.client_id} session={session}/>)}
  </section>;
}

function SessionRequest({ request }: { request: RequestView }) {
  return <article class="card">
    <h2><Dot color={request.agent.color}/>{request.agent.name} wants to open a session</h2>
    <blockquote>{request.purpose}</blockquote>
    <p class="muted">Opens in a new tab group named “{request.title}”:</p>
    <ul class="urls">
      {request.urls.length ? request.urls.map(url => {
        const parts = splitUrl(url);
        return <li key={url}><strong>{parts.origin}</strong><span class="muted">{parts.rest}</span></li>;
      }) : <li class="muted">A blank tab</li>}
    </ul>
    <p class="muted small">The agent can use your existing logins in tabs of this group until you close or ungroup it.</p>
    <Actions>
      <button class="primary" disabled={busy.value !== null} onClick={() => void act('Opening session', async () => {
        await requestSitePermission();
        await controller.approveSession(request.request_id);
      })}>Approve</button>
      <button disabled={busy.value !== null} onClick={() => void act('Declining', () => controller.declineSession(request.request_id))}>Decline</button>
    </Actions>
  </article>;
}

function Handoff({ handoff }: { handoff: HandoffView }) {
  return <article class="card attention">
    <h2><Dot color={handoff.agent.color}/>{handoff.agent.name} needs your help</h2>
    <button class="link tab-link" onClick={() => void act('Opening tab', () => controller.focusTab(handoff.tabId))}>
      {handoff.tab_title || 'Open the tab'}
    </button>
    <p class="instructions">{handoff.instructions}</p>
    <Actions>
      <button class="primary" disabled={busy.value !== null} onClick={() => void act('Finishing', () => controller.decideHandoff(handoff.request_id, 'done'))}>Done</button>
      <button disabled={busy.value !== null} onClick={() => void act('Cancelling', () => controller.decideHandoff(handoff.request_id, 'cancel'))}>Cancel</button>
    </Actions>
  </article>;
}

function Closure({ closure }: { closure: ClosureView }) {
  const count = `${closure.tabs.length} tab${closure.tabs.length === 1 ? '' : 's'}`;
  return <article class="card attention">
    <h2><Dot color={closure.agent.color}/>{closure.agent.name} asks to close {closure.kind === 'tab' ? 'a tab' : count}</h2>
    <blockquote>{closure.description}</blockquote>
    <ul class="urls">
      {closure.tabs.map(tab => <li key={tab.tabId}>
        <button class="link tab-link" title={tab.url} onClick={() => void act('Opening tab', () => controller.focusTab(tab.tabId))}>
          {tab.title || hostOf(tab.url)}
        </button>
      </li>)}
    </ul>
    <p class="muted small">
      {closure.kind === 'session' ? `Session “${closure.session_title}” ends. ` : `From “${closure.session_title}”. `}
      Closed tabs and anything unsaved in them are gone{closure.excluded ? `; ${closure.excluded} not shared tab(s) stay open` : ''}.
    </p>
    <Actions>
      <button class="primary" disabled={busy.value !== null} onClick={() => void act('Closing', () => controller.decideClose(closure.request_id, true))}>Close {closure.kind === 'tab' ? 'tab' : count}</button>
      <button disabled={busy.value !== null} onClick={() => void act('Keeping', () => controller.decideClose(closure.request_id, false))}>Keep open</button>
    </Actions>
  </article>;
}

function Reattach({ session }: { session: SessionView }) {
  const [choice, setChoice] = useState(session.candidates[0]?.groupId);
  return <article class="card">
    <h2><Dot color={session.agent.color}/>Reconnect “{session.title}”?</h2>
    <p class="muted">After a browser restart, choose the tab group that belongs to this {session.agent.name} session.</p>
    {session.candidates.map(candidate => <label class="choice" key={candidate.groupId}>
      <input type="radio" name={`reattach-${session.client_id}`} checked={choice === candidate.groupId}
        onChange={() => setChoice(candidate.groupId)}/>
      {candidate.title} · {candidate.tab_count} tab{candidate.tab_count === 1 ? '' : 's'}
    </label>)}
    <Actions>
      <button class="primary" disabled={busy.value !== null || choice === undefined} onClick={() => void act('Reconnecting', async () => {
        await requestSitePermission();
        await controller.confirmReattach(session.client_id, choice!);
      })}>Reconnect</button>
      <button disabled={busy.value !== null} onClick={() => void act('Ending', () => controller.discardReattach(session.client_id))}>End session</button>
    </Actions>
  </article>;
}
