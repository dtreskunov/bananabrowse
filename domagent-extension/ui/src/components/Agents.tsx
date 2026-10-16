import { useState } from 'preact/hooks';
import { act, busy, controller, copy, now } from '../runtime';
import { agentRows, countdown, sessionSummary, tabStatus } from '../presentation';
import type { AgentRow, Snapshot } from '../presentation';
import { Dot, Actions } from './Primitives';
import './Agents.css';

const GEAR =
  'M12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Zm7.4-2.5a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9c-.6.2-1.2.6-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.8 1.7 1L11 21h4l.4-2.9c.6-.2 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.6Z';

function PairingCode({ snapshot }: { snapshot: Snapshot }) {
  const pairing = snapshot.pairing;
  const [copied, setCopied] = useState(false);
  if (!pairing || pairing.proposal) return null;
  return (
    <div class="pairing card">
      <p>Tell your agent this code:</p>
      <output class="code" aria-live="polite">
        {pairing.code}
      </output>
      <p class="muted small">
        {pairing.state === 'waiting' ? `Expires in ${countdown(pairing.expires_at, now.value)}` : 'Reserving code…'}
      </p>
      <Actions>
        <button
          onClick={() =>
            void act('Copying', async () => {
              await copy(pairing.code);
              setCopied(true);
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={() => void act('Cancelling', () => controller.cancelPairing())}>Cancel</button>
      </Actions>
    </div>
  );
}

function AgentItem({ row }: { row: AgentRow }) {
  return (
    <li class="agent">
      <div class="agent-row">
        <Dot color={row.agent.color} />
        <strong>{row.agent.name}</strong>
        <span class={`agent-status ${row.tone}`}>{row.status}</span>
      </div>
      {row.sessions.length > 0 && (
        <ul class="sessions">
          {row.sessions.map((session) => (
            <li key={session.client_id} class="session">
              <div class="session-row">
                <span>{session.title}</span>
                <small class="muted">{sessionSummary(session)}</small>
              </div>
              <ul class="tabs">
                {session.tabs.map((tab) => (
                  <li key={tab.tabId}>
                    <button
                      class="link tab-link"
                      title={tab.url}
                      onClick={() => void act('Opening tab', () => controller.focusTab(tab.tabId))}
                    >
                      {tab.title || tab.url}
                    </button>
                    {tabStatus(tab) && <span class={`chip ${tab.help ? 'warn' : ''}`}>{tabStatus(tab)}</span>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function Agents({
  snapshot,
  pair,
  openSettings,
}: {
  snapshot: Snapshot;
  pair: () => void;
  openSettings: () => void;
}) {
  const rows = agentRows(snapshot.agents, snapshot.sessions);
  const canPair = snapshot.phase === 'online' && !snapshot.pairing && busy.value === null;
  return (
    <section class="agents" aria-label="Agents">
      <div class="section-head">
        <h2>Agents</h2>
        <span class="head-actions">
          {rows.length > 0 && (
            <button class="link" disabled={!canPair} onClick={pair}>
              + Pair
            </button>
          )}
          <button class="icon" aria-label="Settings" onClick={openSettings}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={GEAR} />
            </svg>
          </button>
        </span>
      </div>
      {rows.length > 0 && (
        <ul class="agent-list">
          {rows.map((row) => (
            <AgentItem key={row.agent.id} row={row} />
          ))}
        </ul>
      )}
      {!rows.length && !snapshot.pairing && (
        <div class="card empty">
          <h2>Pair your first agent</h2>
          <p class="muted">Your agent will ask you for a code. Then it can ask to open browser sessions here.</p>
          <button class="primary" disabled={!canPair} onClick={pair}>
            Pair an agent
          </button>
        </div>
      )}
      <PairingCode snapshot={snapshot} />
    </section>
  );
}
