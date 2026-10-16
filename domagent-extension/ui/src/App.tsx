import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { act, busy, controller, copy, duplicate, focusExisting, localError, now, requestSitePermission, state,
  suggestedName, api, browserName } from './runtime';
import { agentRows, connectionNotice, countdown, failureMessage, feedStatus, hostOf, operationLabel, sessionSummary,
  splitUrl, tabStatus, timeOf, windowTitle } from './presentation';
import type { AgentRow, Agent, ClosureView, HandoffView, RequestView, SessionView, Snapshot } from './presentation';

const COLORS: Record<string, string> = { blue: '#1a73e8', red: '#d93025', yellow: '#e8a600', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#e8710a', grey: '#5f6368' };

function Dot({ color }: { color?: string }) {
  return <span class="agent-dot" style={{ background: COLORS[color || 'grey'] || COLORS.grey }} aria-hidden="true"/>;
}
function Notice({ code }: { code: string | null }) {
  if (!code) return null;
  return <p class="notice" role="alert">{failureMessage(code)}</p>;
}
function Actions({ children }: { children: ComponentChildren }) { return <div class="actions">{children}</div>; }

export function App() {
  if (duplicate.value) return <main class="center">
    <h1>DomAgent is already open</h1>
    <p class="muted">Only one DomAgent window can run at a time.</p>
    <button class="primary" onClick={focusExisting}>Switch to it</button>
  </main>;
  const snapshot = state.value;
  if (!snapshot) return <main class="center"><p class="muted" role="status">Starting…</p><Notice code={localError.value}/></main>;
  if (!snapshot.identity) return <Setup snapshot={snapshot}/>;
  return <Main snapshot={snapshot}/>;
}

function Setup({ snapshot }: { snapshot: Snapshot }) {
  const [domain, setDomain] = useState(hostOf(snapshot.last_setup?.origin) || '');
  const [name, setName] = useState(snapshot.last_setup?.name || suggestedName());
  const submit = (event: Event) => {
    event.preventDefault();
    void act('Connecting', async () => {
      const input = domain.trim();
      const origin = new URL(input.includes('://') ? input : `https://${input}`).origin;
      // Ask before any other await so the browser still sees this click.
      if (!await api.permissions.request({ origins: [`${origin}/*`] })) {
        throw Object.assign(new Error('PERMISSION_REQUIRED'), { code: 'PERMISSION_REQUIRED' });
      }
      await controller.setup({ domain: origin, name });
    });
  };
  return <main class="setup">
    <h1>Set up DomAgent</h1>
    <p class="muted">Connect this browser to your DomAgent server. Your agent can then ask to work in tab groups you approve.</p>
    <form onSubmit={submit}>
      <label for="domain">Server</label>
      <input id="domain" required placeholder="domagent.example.com" value={domain} autoComplete="url"
        onInput={event => setDomain(event.currentTarget.value)}/>
      <label for="name">Name for this browser</label>
      <input id="name" required maxLength={80} value={name} onInput={event => setName(event.currentTarget.value)}/>
      <small class="muted">Shown to your agents, for example “Bob's Firefox on Mac”.</small>
      <button class="primary wide" type="submit" disabled={busy.value !== null}>{busy.value || 'Connect'}</button>
    </form>
    <Notice code={localError.value || (snapshot.error === 'BROWSER_REVOKED' ? snapshot.error : null)}/>
  </main>;
}

const GEAR = 'M12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Zm7.4-2.5a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9c-.6.2-1.2.6-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.6Z';

function Main({ snapshot }: { snapshot: Snapshot }) {
  const [settings, setSettings] = useState(false);
  const title = windowTitle(snapshot);
  // The OS title bar carries connection and pending state, so the page needs no header.
  useEffect(() => { document.title = title; }, [title]);
  const pair = () => void act('Pairing', () => { setSettings(false); controller.startPairing(); });
  return <div class="app" data-phase={snapshot.phase}>
    <Connection snapshot={snapshot}/>
    <main>
      <Notice code={localError.value}/>
      {settings ? <Settings snapshot={snapshot} close={() => setSettings(false)} pair={pair}/> : <>
        <Requests snapshot={snapshot}/>
        <Agents snapshot={snapshot} pair={pair} openSettings={() => setSettings(true)}/>
        <Activity snapshot={snapshot}/>
      </>}
    </main>
  </div>;
}

function Connection({ snapshot }: { snapshot: Snapshot }) {
  const notice = connectionNotice(snapshot);
  if (!notice) return null;
  if (notice.kind === 'connecting') return <p class="connecting muted small" role="status">Connecting…</p>;
  return <div class="strip" role="status">
    <div>
      <strong>{notice.code ? failureMessage(notice.code) : `Offline: can't reach ${hostOf(snapshot.identity!.origin)}`}</strong>
      <span>Agents can't reach this browser.</span>
    </div>
    <button disabled={snapshot.phase === 'connecting'} onClick={() => controller.retry()}>
      {snapshot.phase === 'connecting' ? 'Retrying…' : 'Retry'}</button>
  </div>;
}

function Requests({ snapshot }: { snapshot: Snapshot }) {
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

function PairingCode({ snapshot }: { snapshot: Snapshot }) {
  const pairing = snapshot.pairing;
  const [copied, setCopied] = useState(false);
  if (!pairing || pairing.proposal) return null;
  return <div class="pairing card">
    <p>Tell your agent this code:</p>
    <output class="code" aria-live="polite">{pairing.code}</output>
    <p class="muted small">{pairing.state === 'waiting' ? `Expires in ${countdown(pairing.expires_at, now.value)}` : 'Reserving code…'}</p>
    <Actions>
      <button onClick={() => void act('Copying', async () => { await copy(pairing.code); setCopied(true); })}>{copied ? 'Copied' : 'Copy'}</button>
      <button onClick={() => void act('Cancelling', () => controller.cancelPairing())}>Cancel</button>
    </Actions>
  </div>;
}

function AgentItem({ row }: { row: AgentRow }) {
  return <li class="agent">
    <div class="agent-row">
      <Dot color={row.agent.color}/>
      <strong>{row.agent.name}</strong>
      <span class={`agent-status ${row.tone}`}>{row.status}</span>
    </div>
    {row.sessions.length > 0 && <ul class="sessions">
      {row.sessions.map(session => <li key={session.client_id} class="session">
        <div class="session-row"><span>{session.title}</span><small class="muted">{sessionSummary(session)}</small></div>
        <ul class="tabs">
          {session.tabs.map(tab => <li key={tab.tabId}>
            <button class="link tab-link" title={tab.url} onClick={() => void act('Opening tab', () => controller.focusTab(tab.tabId))}>
              {tab.title || tab.url}
            </button>
            {tabStatus(tab) && <span class={`chip ${tab.help ? 'warn' : ''}`}>{tabStatus(tab)}</span>}
          </li>)}
        </ul>
      </li>)}
    </ul>}
  </li>;
}

function Agents({ snapshot, pair, openSettings }: { snapshot: Snapshot; pair: () => void; openSettings: () => void }) {
  const rows = agentRows(snapshot.agents, snapshot.sessions);
  const canPair = snapshot.phase === 'online' && !snapshot.pairing && busy.value === null;
  return <section class="agents" aria-label="Agents">
    <div class="section-head">
      <h2>Agents</h2>
      <span class="head-actions">
        {rows.length > 0 && <button class="link" disabled={!canPair} onClick={pair}>+ Pair</button>}
        <button class="icon" aria-label="Settings" onClick={openSettings}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={GEAR}/></svg>
        </button>
      </span>
    </div>
    {rows.length > 0 && <ul class="agent-list">{rows.map(row => <AgentItem key={row.agent.id} row={row}/>)}</ul>}
    {!rows.length && !snapshot.pairing && <div class="card empty">
      <h2>Pair your first agent</h2>
      <p class="muted">Your agent will ask you for a code. Then it can ask to open browser sessions here.</p>
      <button class="primary" disabled={!canPair} onClick={pair}>Pair an agent</button>
    </div>}
    <PairingCode snapshot={snapshot}/>
  </section>;
}

function Activity({ snapshot }: { snapshot: Snapshot }) {
  // With a single agent its name on every row is noise.
  const names = new Map(snapshot.agents.length > 1 ? snapshot.agents.map(agent => [agent.id, agent.name]) : []);
  const entries = [...snapshot.feed].reverse().slice(0, 50);
  if (!entries.length) return null;
  return <section class="activity" aria-label="Activity">
    <div class="section-head"><h2>Activity</h2></div>
    <ol>
      {entries.map(entry => <li key={entry.id} class={`feed ${entry.status}`}>
        <time>{timeOf(entry.time)}</time>
        <div>
          <small class="muted">{[entry.agent_id && names.get(entry.agent_id), operationLabel(entry.operation)].filter(Boolean).join(' · ')}</small>
          <p>{entry.description}</p>
        </div>
        {feedStatus(entry.status) && <span class={`chip ${entry.status === 'failed' || entry.status === 'uncertain' ? 'bad' : ['needs_help', 'needs_approval'].includes(entry.status) ? 'warn' : ''}`}>{feedStatus(entry.status)}</span>}
      </li>)}
    </ol>
  </section>;
}

function Settings({ snapshot, close, pair }: { snapshot: Snapshot; close: () => void; pair: () => void }) {
  const [name, setName] = useState(snapshot.identity!.name);
  const [scripts, setScripts] = useState<boolean | null>(null);
  useEffect(() => {
    if (browserName === 'firefox') void api.permissions.contains({ permissions: ['userScripts'] }).then(setScripts);
  }, []);
  return <section class="settings" aria-label="Settings">
    <div class="section-head"><h2>Settings</h2><button class="link" onClick={close}>Close</button></div>
    <form class="field" onSubmit={event => { event.preventDefault(); void act('Renaming', () => controller.renameBrowser(name)); }}>
      <label for="browser-name">This browser</label>
      <div class="inline"><input id="browser-name" maxLength={80} value={name} onInput={event => setName(event.currentTarget.value)}/>
        <button type="submit" disabled={busy.value !== null || snapshot.phase !== 'online' || name === snapshot.identity!.name}>Save</button></div>
    </form>
    <div class="field"><span class="label">Server</span><span>{hostOf(snapshot.identity!.origin)}</span></div>
    <div class="field"><span class="label">Agents</span>
      {snapshot.agents.length > 0 && <ul class="plain">{snapshot.agents.map((agent: Agent) => <li key={agent.id} class="inline">
        <span><Dot color={agent.color}/>{agent.name}</span>
        <button disabled={busy.value !== null || snapshot.phase !== 'online'} onClick={() => {
          if (confirm(`Unpair ${agent.name}? Its sessions end and their tabs are ungrouped.`)) void act('Unpairing', () => controller.revokeAgent(agent.id));
        }}>Unpair</button></li>)}</ul>}
      <button class="link" disabled={busy.value !== null || snapshot.phase !== 'online' || Boolean(snapshot.pairing)}
        onClick={pair}>+ Pair an agent</button>
    </div>
    <label class="check">
      <input type="checkbox" checked={snapshot.settings.openAtStartup}
        onChange={event => void act('Saving', () => controller.setOpenAtStartup(event.currentTarget.checked))}/>
      Open DomAgent when the browser starts
    </label>
    {browserName === 'firefox' && <div class="field"><span class="label">Page scripts</span>
      {scripts ? <span>Enabled</span> : <button onClick={() => void act('Enabling', async () => {
        setScripts(await api.permissions.request({ permissions: ['userScripts'] }));
      })}>Enable</button>}</div>}
    <div class="field danger-zone">
      <button class="danger" disabled={busy.value !== null} onClick={() => {
        if (confirm('Forget this browser? All pairings and sessions end. You will need to set DomAgent up again.')) {
          void act('Forgetting', () => controller.forget());
        }
      }}>Forget this browser</button>
    </div>
    <p class="muted small">DomAgent {api.runtime.getManifest().version} · browser ID {snapshot.identity!.browser_id}</p>
  </section>;
}
