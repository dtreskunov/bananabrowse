import type { Snapshot } from './types';
import { api, busy, chooseGroup, continueTask, localError, openPanel, request, run, selection } from './client';
import { deriveView, taskGroups } from './presentation';
import { TaskSelector } from './components/TaskSelector';
import { Notice } from './components/Notice';

export function Popup({ snapshot }: { snapshot: Snapshot }) {
  const count = snapshot.active_workspace_count ?? snapshot.workspaces.filter(workspace => workspace.state === 'active').length;
  const help = snapshot.pending_human_count || 0;
  const view = deriveView(snapshot, selection.value || '');
  let label = view.label;
  if (count) label = `${count} running task group${count === 1 ? '' : 's'}`;
  if (snapshot.starting_workspace_count) label = 'Starting task';
  const blocked = busy.value !== null;
  return <main class="popup-content">
    <header><h1>DomAgent</h1><p class="muted">{snapshot.identity?.client_label || 'Your assistant'}</p></header>
    <div class="task-status" role="status"><div class="status-title">
      <span class={`status-dot ${count ? 'active' : ''}`} aria-hidden="true"/><h2>{label}</h2>
    </div><p>{help ? `${help} task${help === 1 ? '' : 's'} need your help.` :
      count ? 'Tasks continue even when the dashboard is closed.' : view.message}</p></div>
    <Notice code={localError.value || snapshot.current_error}/>
    {!count && snapshot.identity && <TaskSelector groups={taskGroups(snapshot)} value={selection.value || ''}
      onChange={chooseGroup} disabled={blocked || view.mode === 'starting'}/>}
    <button class="primary main-action" type="button" disabled={blocked || (!count && (!view.action || view.mode === 'choose'))}
      onClick={() => {
        if (count) void run('Pausing tasks', () => request('pauseAll'));
        else if (!snapshot.identity) void run('Opening settings', () => api.runtime.openOptionsPage());
        else if (view.mode === 'offline' && !selection.value) void run('Reconnecting', () => request('connect'));
        else void run('Starting task', continueTask);
      }}>{busy.value || (count ? 'Pause all tasks' : view.action || 'Starting...')}</button>
    <button class="dashboard-button" type="button" disabled={blocked} onClick={() => void run('Opening dashboard', openPanel)}>
      Open dashboard
    </button>
    <footer class="access-footer"><p>Pause stops new control, not effects already started. Tabs stay open.</p></footer>
  </main>;
}
