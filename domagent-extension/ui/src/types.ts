export interface Command {
  request_id: string;
  operation: string;
  description: string;
  human: boolean;
  executing: boolean;
  suggested_text?: string;
}
export interface TaskTab {
  target_id: string;
  tabId: number;
  title: string;
  url: string;
  page_state: string;
  commands: Command[];
}
export interface Workspace {
  workspace_id: string;
  windowId: number;
  groupId: number;
  state: 'active' | 'paused' | 'inactive';
  end_reason?: string | null;
  ended_at?: number | null;
  acknowledged?: boolean;
  tabs: TaskTab[];
}
export interface TaskGroup {
  groupId: number;
  title: string;
  tab_count?: number;
  tab_titles?: string[];
}
export interface Snapshot {
  phase: string;
  config: { service_origin?: string; enabled?: boolean; tenant_id?: string };
  identity: { client_label?: string; tenant_label?: string } | null;
  browser_info?: { extension_version: string; browser_name: string; browser_version: string | null };
  pairing: {
    code: string; state: string; expires_at: number;
    proposal?: { client_label: string };
  } | null;
  workspaces: Workspace[];
  available_groups?: TaskGroup[];
  failures: string[];
  current_error?: string | null;
  last_session_end?: { reason: string; at: number } | null;
  activity: { id: string; event: string; time: number; operation?: string; code?: string }[];
  history_unavailable?: boolean;
  saved_connections: { origin: string; tenant_id: string; label: string }[];
  connection_info?: { service_epoch: string; connection_id: string; service_started_at: number | null } | null;
  active_workspace_count?: number;
  starting_workspace_count?: number;
  permissions?: { websites: boolean; scripting: boolean };
  pending_human_count?: number;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalString = (value: unknown): boolean => value === undefined || value === null || string(value);
const optionalText = (value: unknown): boolean => value === undefined || string(value);
function command(value: unknown): value is Command {
  return object(value) && string(value.request_id) && string(value.operation) && string(value.description) &&
    typeof value.human === 'boolean' && typeof value.executing === 'boolean' &&
    (value.suggested_text === undefined || string(value.suggested_text) && value.suggested_text.length <= 8000);
}
function tab(value: unknown): value is TaskTab {
  return object(value) && string(value.target_id) && number(value.tabId) && string(value.title) &&
    string(value.url) && string(value.page_state) && Array.isArray(value.commands) && value.commands.every(command);
}
function workspace(value: unknown): value is Workspace {
  return object(value) && string(value.workspace_id) && number(value.windowId) && number(value.groupId) &&
    ['active', 'paused', 'inactive'].includes(String(value.state)) && optionalString(value.end_reason) &&
    (value.acknowledged === undefined || typeof value.acknowledged === 'boolean') &&
    Array.isArray(value.tabs) && value.tabs.every(tab);
}
function isSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || !string(value.phase) || !object(value.config) ||
      !optionalText(value.config.service_origin) || !optionalText(value.config.tenant_id) ||
      (value.config.enabled !== undefined && typeof value.config.enabled !== 'boolean') ||
      !(value.identity === null || object(value.identity) && optionalText(value.identity.client_label) &&
        optionalText(value.identity.tenant_label)) ||
      !Array.isArray(value.workspaces) || !value.workspaces.every(workspace) ||
      !Array.isArray(value.failures) || !value.failures.every(string) ||
      !optionalString(value.current_error) || !Array.isArray(value.activity) ||
      !value.activity.every(row => object(row) && string(row.id) && string(row.event) && number(row.time) &&
        optionalText(row.operation) && optionalText(row.code)) ||
      !Array.isArray(value.saved_connections) ||
      !value.saved_connections.every(row => object(row) && string(row.origin) && string(row.tenant_id) && string(row.label))) return false;
  if (value.available_groups !== undefined && (!Array.isArray(value.available_groups) ||
      !value.available_groups.every(row => object(row) && number(row.groupId) && string(row.title) &&
        (row.tab_count === undefined || number(row.tab_count)) &&
        (row.tab_titles === undefined || Array.isArray(row.tab_titles) && row.tab_titles.every(string))))) return false;
  if (value.pairing !== null && !(object(value.pairing) && string(value.pairing.code) &&
      string(value.pairing.state) && number(value.pairing.expires_at) &&
      (value.pairing.proposal === undefined || object(value.pairing.proposal) && string(value.pairing.proposal.client_label)))) return false;
  if (value.browser_info !== undefined && !(object(value.browser_info) &&
      string(value.browser_info.extension_version) && string(value.browser_info.browser_name) &&
      optionalString(value.browser_info.browser_version))) return false;
  if (value.last_session_end != null && !(object(value.last_session_end) &&
      string(value.last_session_end.reason) && number(value.last_session_end.at))) return false;
  if (value.history_unavailable !== undefined && typeof value.history_unavailable !== 'boolean') return false;
  if (value.active_workspace_count !== undefined && !number(value.active_workspace_count)) return false;
  if (value.starting_workspace_count !== undefined && !number(value.starting_workspace_count)) return false;
  if (value.permissions !== undefined && !(object(value.permissions) &&
      typeof value.permissions.websites === 'boolean' && typeof value.permissions.scripting === 'boolean')) return false;
  if (value.pending_human_count !== undefined && !number(value.pending_human_count)) return false;
  if (value.connection_info != null && !(object(value.connection_info) &&
      string(value.connection_info.service_epoch) && string(value.connection_info.connection_id) &&
      (value.connection_info.service_started_at === null || number(value.connection_info.service_started_at)))) return false;
  return true;
}
export function decodeSnapshot(value: unknown): Snapshot {
  if (!isSnapshot(value)) throw new Error('INVALID_MESSAGE');
  return value;
}
export function isRecord(value: unknown): value is Record<string, unknown> { return object(value); }
