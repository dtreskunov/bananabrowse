import type { FeedEntry, Snapshot } from '../types';
import { busy, request, run } from '../client';
import { failureMessage, operationLabel } from '../presentation';
import { HandoffText } from './HandoffText';
import './ActivityFeed.css';

const labels: Record<FeedEntry['status'], string> = {
  queued: 'Queued', ready: 'Ready', running: 'Running', complete: 'Complete',
  failed: 'Failed', cancelled: 'Stopped', uncertain: 'Outcome uncertain',
  needs_help: 'Needs your help', approved: 'Approved',
};
function title(operation: string): string {
  if (operation === 'workspace_approval') return 'Browser access allowed';
  if (operation === 'workspace_stopped') return 'Browser control stopped';
  return operationLabel(operation);
}
function StatusSymbol({ status }: { status: FeedEntry['status'] }) {
  let mark;
  if (['queued', 'ready', 'running'].includes(status)) mark = <><circle cx="10" cy="10" r="7"/><path d="M10 5v5l3 2"/></>;
  else if (status === 'complete' || status === 'approved') mark = <path d="m4 10 4 4 8-8"/>;
  else mark = <><circle cx="10" cy="10" r="7"/><path d="M10 5v6M10 14h.01"/></>;
  return <svg viewBox="0 0 20 20">{mark}</svg>;
}
export function ActivityFeed({ snapshot }: { snapshot: Snapshot }) {
  const entries = [...(snapshot.activity_feed || [])];
  const pending = snapshot.workspaces.flatMap(workspace => workspace.tabs.flatMap(tab =>
    tab.commands.map(command => ({ workspace, tab, command }))));
  for (const { workspace, tab, command } of pending) {
    if (entries.some(entry => entry.id === command.request_id)) continue;
    let status: FeedEntry['status'] = command.human ? 'needs_help' : 'queued';
    if (command.executing) status = 'running';
    entries.push({ id: command.request_id, time: Date.now(), updated_at: Date.now(),
      windowId: workspace.windowId, workspace_id: workspace.workspace_id, operation: command.operation,
      description: command.description, title: tab.title, policy: 'allow_all',
      status });
  }
  const visibleEntries = entries.filter((entry, index) =>
    index >= entries.length - 100 || pending.some(task => task.command.request_id === entry.id));
  return <section class="activity-feed" aria-label="Agent activity">
    <header><h2>Activity</h2><span class="section-label">This browser session</span></header>
    {entries.length === 0 && <div class="feed-empty"><h3>Ready for your agent</h3>
      <p>Actions and status updates appear here as the task progresses.</p></div>}
    <ol role="log" aria-live="polite" aria-relevant="additions">
      {visibleEntries.reverse().map(entry => {
        const live = pending.find(task => task.command.request_id === entry.id);
        return <li key={entry.id} class={`feed-card status-${entry.status}`}>
          <div class="feed-symbol" aria-hidden="true">
            <StatusSymbol status={entry.status}/>
          </div>
          <div class="feed-content">
            <div class="feed-meta"><span class="feed-status">{labels[entry.status]}</span>
              <time>{new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
            <h3>{title(entry.operation)}</h3>
            <p class="feed-intent">{entry.description}</p>
            {entry.title && <p class="feed-target">{entry.title}</p>}
            {entry.policy === 'allow_all' && <span class="policy-chip">Allow all · task-group policy</span>}
            {entry.code && entry.status !== 'cancelled' && <p class="feed-failure">{failureMessage(entry.code)}</p>}
            {live?.command.human && !live.command.executing && <>
              {live.command.suggested_text && <HandoffText text={live.command.suggested_text}/>}
              <div class="command-controls">
                <button type="button" class="primary" disabled={busy.value !== null} onClick={() => void run('Confirming help', () =>
                  request('decision', { request_id: entry.id, action: 'done' }))}>Done</button>
                <button type="button" disabled={busy.value !== null} onClick={() => void run('Cancelling help', () =>
                  request('decision', { request_id: entry.id, action: 'cancel' }))}>Cancel</button>
              </div>
            </>}
          </div>
        </li>;
      })}
    </ol>
    <p class="feed-privacy">Intent messages stay in memory for this session. Complete means the tool returned successfully, not proof of every website effect.</p>
  </section>;
}
