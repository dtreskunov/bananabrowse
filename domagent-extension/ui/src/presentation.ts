import type { Snapshot, TaskGroup, Workspace } from './types';

export interface PanelView {
  mode: 'setup' | 'connecting' | 'offline' | 'starting' | 'active' | 'help' | 'paused' | 'continue' | 'choose';
  label: string;
  message: string;
  action: string | null;
  workspace?: Workspace;
}
export function deriveView(snapshot: Snapshot, selection: string): PanelView {
  const workspace = snapshot.workspaces[0];
  if (!snapshot.identity) return { mode: 'setup', label: 'Not connected', message: 'Connect your assistant to get started.', action: 'Connect assistant' };
  if (['connecting', 'authenticating', 'proving'].includes(snapshot.phase)) {
    return { mode: 'connecting', label: 'Reconnecting', message: 'Control is stopped while the connection is restored.', action: null, workspace };
  }
  if (snapshot.phase !== 'authenticated') {
    return { mode: 'offline', label: 'Connection offline', message: selection
      ? 'Continue will reconnect and start this task. Your tabs are unchanged.'
      : 'Reconnect, then choose a task to continue.', action: selection ? 'Continue' : 'Reconnect', workspace };
  }
  if (workspace?.state === 'active') {
    if (workspace.acknowledged !== true) return {
      mode: 'starting', label: 'Starting task', message: 'Waiting for the browser session to be confirmed.', action: null, workspace,
    };
    const help = workspace.tabs.some(tab => tab.commands.some(command => command.human));
    const working = workspace.tabs.some(tab => tab.commands.some(command => command.executing));
    let label = 'Ready';
    if (help) label = 'Needs your help';
    else if (working) label = 'Working';
    return { mode: help ? 'help' : 'active', label,
      message: `${workspace.tabs.length} task tab${workspace.tabs.length === 1 ? '' : 's'} available to your assistant.`,
      action: help ? 'Go to task' : 'Pause', workspace };
  }
  if (!selection) return { mode: 'choose', label: 'Choose a task', message: 'Choose the tabs your assistant can use.', action: 'Continue', workspace };
  if (workspace?.state === 'paused' && selection === String(workspace.groupId)) {
    return { mode: 'paused', label: 'Paused by you', message: 'No new actions will start until you continue.', action: 'Continue', workspace };
  }
  let message = 'Your task tabs are ready. Continue when you want the assistant to work.';
  const reason = workspace?.end_reason || snapshot.last_session_end?.reason;
  if (workspace?.end_reason === 'WORKSPACE_CHANGED' || snapshot.current_error === 'GROUP_UNAVAILABLE') {
    message = 'The previous task group is unavailable. Choose another group or a new tab.';
  } else if (reason === 'CONNECTION_LOST' || reason === 'SERVICE_RESTARTED') {
    message = 'Your connection was restored. Your tabs are unchanged.';
  }
  return { mode: 'continue', label: selection === 'new' ? 'Ready to start' : 'Ready to continue',
    message, action: selection === 'new' ? 'Start' : 'Continue', workspace };
}
export function taskGroups(snapshot: Snapshot): TaskGroup[] {
  const workspace = snapshot.workspaces[0];
  return (snapshot.available_groups || []).filter(group =>
    group.title.startsWith('DomAgent - ') || group.groupId === workspace?.groupId);
}
export function suggestedSelection(snapshot: Snapshot, previous: string | null): string {
  const groups = taskGroups(snapshot);
  if (previous === '') return '';
  if (previous === 'new' || groups.some(group => String(group.groupId) === previous)) return previous || '';
  if (previous !== null) return groups.length ? '' : 'new';
  const workspace = snapshot.workspaces[0];
  if (groups.some(group => group.groupId === workspace?.groupId)) return String(workspace!.groupId);
  if (groups.length === 1) return String(groups[0]!.groupId);
  return groups.length ? '' : 'new';
}
export function groupDetail(group: TaskGroup, index: number): string {
  if (group.tab_count !== undefined) return `${group.tab_count} tab${group.tab_count === 1 ? '' : 's'}` +
    (group.tab_titles?.length ? ` · ${group.tab_titles.slice(0, 2).join(', ')}` : '');
  return `Saved task ${index + 1}`;
}
export function failureMessage(code: string): string {
  const messages: Record<string, string> = {
    NOT_AUTHORIZED: 'This connection could not be authorized. Check connection details before pairing again.',
    BROWSER_OFFLINE: 'The connection is offline. Your tabs are unchanged.',
    PANEL_OPEN_REQUIRED: 'Open this window’s DomAgent sidebar, then continue.',
    WORKSPACE_INACTIVE: 'The session has stopped. Continue locally when ready.',
    WORKSPACE_PAUSED: 'The task is paused. Continue when ready.',
    GROUP_UNAVAILABLE: 'That task group is no longer available. Choose another group or a new tab.',
    WORKSPACE_CHANGED: 'The group or window changed. Choose a valid task group to continue.',
    PERMISSION_REQUIRED: 'The requested permission was declined. No browser control was enabled.',
    PERMISSION_STEP_REQUIRED: 'Firefox requires these permissions separately. Click the primary button again to grant the remaining access; nothing has started yet.',
    OUTCOME_UNKNOWN: 'A previous action could not be confirmed. Check its outcome before repeating it.',
    HISTORY_UNAVAILABLE: 'Activity history could not be saved. Current controls are still available.',
    NOTIFICATION_UNAVAILABLE: 'The help notification could not be delivered. Check notification settings.',
    PAIRING_UNAVAILABLE: 'This pairing request expired. Start again for a fresh code.',
    PAIRING_CODE_COLLISION: 'The code could not be reserved. Start again for another code.',
    PLATFORM_UNSUPPORTED: 'Update the browser to use native tab groups and sidebar controls.',
    SCRIPT_EXECUTION_UNAVAILABLE: 'Advanced scripting is unavailable. Grant scripting permission in Firefox, or enable Allow user scripts in Chrome for USER_SCRIPT mode.',
    INPUT_REJECTED: 'The editor rejected this input. No automatic fallback or repeated edit was attempted.',
    INPUT_NOT_APPLIED: 'The requested text did not survive the editor’s update. Check the page before trying another approach.',
    TAB_LIMIT_REACHED: 'This task has reached its eight-tab limit.',
    INVALID_MESSAGE: 'Browser state could not be read safely. Reopen the sidebar or check diagnostics.',
    CLIPBOARD_UNAVAILABLE: 'The code could not be copied. Select and copy it manually.',
  };
  return messages[code] || 'That action failed. Check diagnostics for the failure code.';
}
export function operationLabel(operation: string): string {
  const names: Record<string, string> = {
    get_text: 'Reading page text', get_page_snapshot: 'Inspecting the page', inspect_element: 'Checking a control',
    navigate: 'Opening a page', wait_for_page: 'Waiting for the page', type_text: 'Entering text',
    click: 'Using a page control', select_option: 'Selecting an option', set_checked: 'Changing a checkbox',
    evaluate_script: 'Running page JavaScript', create_workspace_tab: 'Opening a task tab', request_handoff: 'Your next step',
  };
  return names[operation] || operation.replaceAll('_', ' ');
}
