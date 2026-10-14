import { useState } from 'preact/hooks';
import type { Snapshot, Workspace } from './types';
import { api, busy, chooseGroup, continueTask, localError, request, run, selection } from './client';
import { deriveView, failureMessage, operationLabel, taskGroups } from './presentation';
import { ActionsMenu } from './components/ActionsMenu';
import type { MenuItem } from './components/ActionsMenu';
import { TaskSelector } from './components/TaskSelector';
import { Notice } from './components/Notice';
import { HandoffText } from './components/HandoffText';
import { AccessRequest } from './components/AccessRequest';

function focusTask(workspace: Workspace): Promise<unknown> {
  const tab = workspace.tabs.find(tab => tab.commands.some(command => command.human)) || workspace.tabs[0];
  if (!tab) return Promise.reject(new Error('TAB_NOT_IN_WORKSPACE'));
  return request('focus', { workspace_id: workspace.workspace_id, tabId: tab.tabId });
}
function hostname(url: string): string {
  try { return new URL(url).hostname || url; }
  catch { return 'Page address unavailable'; }
}
export function Panel({ snapshot }: { snapshot: Snapshot }) {
  const [page, setPage] = useState<'task' | 'settings' | 'diagnostics'>('task');
  const view = deriveView(snapshot, selection.value || '');
  const workspace = view.workspace;
  const active = view.mode === 'active' || view.mode === 'help';
  const blocked = busy.value !== null;
  const groups = taskGroups(snapshot);
  const client = snapshot.identity?.client_label || snapshot.identity?.tenant_label || 'Your assistant';
  function back() {
    setPage('task');
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Task actions"]')?.focus());
  }
  const items: MenuItem[] = [
    ...(workspace && active ? [
      { label: 'Add current tab', disabled: blocked, action: () => void run('Adding tab', () => request('add', { workspace_id: workspace.workspace_id })) },
      { label: 'Choose another task', disabled: blocked, action: () => void run('Pausing', async () => {
        await request('pause', { workspace_id: workspace.workspace_id }); chooseGroup('');
      }) },
      { label: 'Move task to its own window', disabled: blocked, action: () => void run('Moving task', () => request('move', { workspace_id: workspace.workspace_id })) },
      ...(view.mode === 'help' ? [{ label: 'Pause task', disabled: blocked,
        action: () => void run('Pausing', () => request('pause', { workspace_id: workspace.workspace_id })) }] : []),
    ] : []),
    ...(snapshot.identity ? [{ label: 'Start a new task', disabled: blocked || view.mode === 'connecting',
      action: () => { chooseGroup('new'); void run('Starting task', continueTask); } }] : []),
    ...(workspace ? [{ label: 'End session', disabled: blocked, danger: true,
      action: () => void run('Ending session', () => request('end', { workspace_id: workspace.workspace_id })) }] : []),
    { label: 'Connection settings', action: () => setPage('settings') },
    { label: 'Diagnostics', action: () => setPage('diagnostics') },
  ];
  if (page !== 'task') return <>
    <header class="subview-header"><button type="button" class="icon-button" aria-label="Back to task" onClick={back}>
      <svg class="line-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5"/></svg>
    </button><h2>{page === 'settings' ? 'Connection settings' : 'Diagnostics'}</h2></header>
    <div class="subview-content">
      <Notice code={localError.value || snapshot.current_error}/>
      {page === 'settings' ? <>
        <p class="section-label">Connected assistant</p><p><strong>{client}</strong></p>
        <p class="muted">{snapshot.config.service_origin || 'No service configured'}</p>
        <p>{snapshot.phase === 'authenticated' ? 'Connection healthy. Browser control still requires an active task.' : 'Connection offline. Tasks remain stopped.'}</p>
        <button class="full" disabled={blocked} onClick={() => void run('Connecting', () => request('connect'))}>Reconnect</button>
        <button class="full" disabled={blocked} onClick={() => void run('Disconnecting', () => request('disconnect'))}>Disconnect</button>
        {snapshot.saved_connections.filter(connection => connection.origin !== snapshot.config.service_origin ||
          connection.tenant_id !== snapshot.config.tenant_id).map(connection =>
          <button key={`${connection.origin}/${connection.tenant_id}`} class="full" disabled={blocked}
            onClick={() => void run('Switching connection', () => request('switch', { origin: connection.origin, tenant_id: connection.tenant_id }))}>
            Select {connection.label}
          </button>)}
        <h3>Pairing</h3><p class="muted">Temporary connection failures do not require pairing again.</p>
        <button class="full" onClick={() => void run('Opening settings', () => api.runtime.openOptionsPage())}>Pairing settings</button>
      </> : <>
        <dl class="diagnostics">
          <dt>Extension</dt><dd>{snapshot.browser_info?.extension_version || 'Unavailable'}</dd>
          <dt>Browser</dt><dd>{snapshot.browser_info ? `${snapshot.browser_info.browser_name} ${snapshot.browser_info.browser_version || ''}` : 'Unavailable'}</dd>
          <dt>Connection</dt><dd>{snapshot.phase}</dd>
          <dt>Service</dt><dd>{snapshot.config.service_origin || 'Not configured'}</dd>
          <dt>Native group</dt><dd>{workspace?.groupId ?? 'None tracked'}</dd>
          <dt>Service epoch</dt><dd>{snapshot.connection_info?.service_epoch || 'Unavailable'}</dd>
          <dt>Connection ID</dt><dd>{snapshot.connection_info?.connection_id || 'Unavailable'}</dd>
          <dt>Previous session</dt><dd>{snapshot.last_session_end?.reason || 'None recorded'}</dd>
        </dl>
        <h3>Recent failures</h3><div id="historical-errors">{snapshot.failures.length ? snapshot.failures.map((code, index) =>
          <p key={`${code}-${index}`}><code>{code}</code><br/>{failureMessage(code)}</p>) : <p class="muted">No failures recorded.</p>}</div>
        <p class="muted">These are historical events, not the current connection status.</p>
      </>}
    </div>
  </>;
  return <>
    <header class="app-header"><div class="brand"><h1>DomAgent</h1><small title={client}>{client}</small></div><ActionsMenu items={items}/></header>
    <main class="panel-content">
      <div class="task-status" id="status" role="status">
        <div class="status-title"><span class={`status-dot ${active ? view.mode : ''}`} aria-hidden="true"/><h2>{view.label}</h2></div>
        <p>{view.message}</p>
      </div>
      {snapshot.identity && <TaskSelector groups={groups} value={selection.value || ''} onChange={chooseGroup}
        disabled={blocked || active || view.mode === 'starting'}/>}
      <AccessRequest snapshot={snapshot}/>
      <Notice code={localError.value || snapshot.current_error}/>
      {view.action && <button type="button" class="primary main-action" disabled={blocked || view.mode === 'choose'}
        onClick={() => {
          if (view.mode === 'setup') void run('Opening settings', () => api.runtime.openOptionsPage());
          else if (view.mode === 'help' && workspace) void run('Opening task', () => focusTask(workspace));
          else if (view.mode === 'active' && workspace) void run('Pausing', () => request('pause', { workspace_id: workspace.workspace_id }));
          else if (view.mode === 'offline' && !selection.value) void run('Reconnecting', () => request('connect'));
          else void run('Starting task', continueTask);
        }}>{busy.value || view.action}</button>}
      {!view.action && <p class="muted" role="status">{busy.value || (view.mode === 'starting' ? 'Confirming session...' : 'Reconnecting...')}</p>}
      {active && workspace && <section class="tab-list" id="targets" aria-label="Task tabs">
        <span class="section-label">In this task <span>{workspace.tabs.length} / 8</span></span>
        {workspace.tabs.length === 0 && <p class="muted">No ordinary website tabs are available in this group.</p>}
        {workspace.tabs.map(tab => <article class="tab-row" key={tab.target_id}>
          <button type="button" class="tab-link" disabled={blocked}
            onClick={() => void run('Opening tab', () => request('focus', { workspace_id: workspace.workspace_id, tabId: tab.tabId }))}>
            <span class="tab-title">{tab.title || 'New tab'}</span><span class="tab-meta">{hostname(tab.url)}</span>
          </button>
          {tab.page_state === 'unavailable' && <p class="tab-error">Page inspection unavailable. Your assistant may still navigate away.</p>}
          {tab.page_state === 'navigation_only' && <p class="tab-meta">Navigation only until a supported page opens.</p>}
          {tab.commands.map(command => <div class="command" key={command.request_id}>
            <h3>{operationLabel(command.operation)}</h3><p>{command.description}</p>
            {command.human && command.suggested_text && <HandoffText text={command.suggested_text}/>}
            {command.human && !command.executing && <div class="command-controls">
              <button type="button" class="primary" disabled={blocked} onClick={() => void run('Confirming help', () =>
                request('decision', { request_id: command.request_id, action: 'done' }))}>Done</button>
              <button type="button" disabled={blocked} onClick={() => void run('Cancelling help', () =>
                request('decision', { request_id: command.request_id, action: 'cancel' }))}>Cancel</button>
            </div>}
          </div>)}
        </article>)}
      </section>}
      <details class="activity"><summary>Recent activity</summary>
        {snapshot.activity.length ? <ul>{snapshot.activity.slice(-20).reverse().map(event => <li key={event.id}>
          <time>{new Date(event.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          {event.event.replaceAll('_', ' ')}{event.operation ? ` · ${operationLabel(event.operation)}` : ''}{event.code ? ` · ${event.code}` : ''}
        </li>)}</ul> : <p class="muted">No activity yet.</p>}
        {snapshot.history_unavailable && <p class="tab-error">Activity could not be saved.</p>}
      </details>
      <footer class="access-footer">
        <p>{active ? 'Only this task group is accessible.' : 'No task tabs are being controlled.'} Other tabs stay private.</p>
        <details><summary>About browser access</summary><p>Grouped tabs can be controlled in the background, including page scripts.
          Your normal website logins are used; this is not a sandbox. Closing this dashboard does not stop a running task.
          Pause or End stops new control and leaves tabs open. Requests and account changes already started cannot be undone.</p></details>
      </footer>
    </main>
  </>;
}
