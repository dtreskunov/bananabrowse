export interface Agent { id: string; name: string; url: string | null; color?: string }
export interface TabView { tabId: number; id: string | null; title: string; url: string; page_state: string; working: boolean; help: boolean }
export interface Candidate { groupId: number; title: string; tab_count: number; matching: number }
export interface SessionView {
  client_id: string; session_id: string | null; agent: Agent; title: string; purpose: string;
  state: 'attached' | 'unconfirmed' | 'pending'; candidates: Candidate[]; tabs: TabView[]; excluded: number;
}
export interface RequestView { request_id: string; agent: Agent; purpose: string; urls: string[]; title: string; expires_at: number }
export interface HandoffView {
  request_id: string; agent: Agent; session_title: string; tab_title: string; tabId: number;
  instructions: string;
}
export interface FeedEntry {
  id: string; time: number; kind?: string; agent_id?: string; session_id?: string; title?: string | null;
  operation?: string; description: string; status: string; code?: string;
}
export interface Snapshot {
  phase: 'loading' | 'setup' | 'connecting' | 'online' | 'offline';
  error: string | null; browser: 'chrome' | 'firefox';
  identity: { origin: string; name: string; browser_id: string } | null;
  last_setup: { origin: string; name: string } | null;
  agents: Agent[]; sessions: SessionView[]; requests: RequestView[];
  pairing: { code: string; state: string; expires_at: number | null; proposal: { request_id: string; agent: Agent } | null } | null;
  handoffs: HandoffView[]; feed: FeedEntry[]; settings: { openAtStartup: boolean }; pending_count: number;
}

const CONNECTION_ERRORS = ['UPGRADE_REQUIRED', 'NOT_AUTHORIZED', 'INVALID_SERVICE'];
/** Connection is silent when healthy; only abnormal states are surfaced. */
export function connectionNotice(snapshot: Pick<Snapshot, 'phase' | 'error'>):
  { kind: 'connecting' } | { kind: 'offline'; code: string | null } | null {
  if (snapshot.phase === 'online') return null;
  if ((snapshot.phase === 'connecting' || snapshot.phase === 'loading') && !snapshot.error) return { kind: 'connecting' };
  // Only connection-specific causes replace the default text; unrelated errors never masquerade as connectivity.
  return { kind: 'offline', code: snapshot.error && CONNECTION_ERRORS.includes(snapshot.error) ? snapshot.error : null };
}

export function windowTitle(snapshot: Pick<Snapshot, 'phase' | 'error' | 'pending_count'>): string {
  if (connectionNotice(snapshot)?.kind === 'offline') return 'DomAgent: offline';
  return snapshot.pending_count ? `DomAgent (${snapshot.pending_count})` : 'DomAgent';
}

export interface AgentRow { agent: Agent; sessions: SessionView[]; status: string; tone: 'help' | 'busy' | 'quiet' }
/** One row per agent (paired agents first, in order), with its attached sessions and a one-word status. */
export function agentRows(agents: Agent[], sessions: SessionView[]): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const agent of agents) rows.set(agent.id, { agent, sessions: [], status: '', tone: 'quiet' });
  for (const session of sessions) {
    if (session.state !== 'attached') continue;
    const row = rows.get(session.agent.id) || { agent: session.agent, sessions: [], status: '', tone: 'quiet' as const };
    row.sessions.push(session);
    rows.set(session.agent.id, row);
  }
  for (const row of rows.values()) {
    const tabs = row.sessions.flatMap(session => session.tabs);
    if (tabs.some(tab => tab.help)) Object.assign(row, { status: 'Needs you', tone: 'help' });
    else if (tabs.some(tab => tab.working)) Object.assign(row, { status: 'Working', tone: 'busy' });
    else if (row.sessions.length) row.status = `${row.sessions.length} session${row.sessions.length === 1 ? '' : 's'}`;
    else row.status = 'Idle';
  }
  return [...rows.values()];
}

export function splitUrl(value: string): { origin: string; rest: string } {
  try {
    const url = new URL(value);
    return { origin: url.host, rest: `${url.pathname === '/' ? '' : url.pathname}${url.search}` };
  } catch { return { origin: value, rest: '' }; }
}

export function hostOf(value: string | null | undefined): string {
  if (!value) return '';
  try { return new URL(value).host; } catch { return value; }
}

export function countdown(expiresAt: number | null, now: number): string {
  if (!expiresAt) return '';
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function timeOf(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function tabStatus(tab: TabView): string {
  if (tab.help) return 'Needs you';
  if (tab.working) return 'Working';
  if (tab.page_state === 'loading') return 'Loading';
  if (tab.page_state === 'unavailable') return 'Unavailable';
  return '';
}

export function sessionSummary(session: SessionView): string {
  if (session.state === 'unconfirmed') return 'Waiting for you to reconnect it';
  const tabs = `${session.tabs.length} tab${session.tabs.length === 1 ? '' : 's'}`;
  return session.excluded ? `${tabs} · ${session.excluded} not shared` : tabs;
}

const STATUS_TEXT: Record<string, string> = {
  queued: 'Queued', ready: 'Starting', running: 'Running', complete: 'Done', failed: 'Failed',
  cancelled: 'Stopped', uncertain: 'Unconfirmed', needs_help: 'Needs you', approved: 'Started', info: '',
};
export function feedStatus(status: string): string { return STATUS_TEXT[status] ?? status; }

export function failureMessage(code: string): string {
  const messages: Record<string, string> = {
    BROWSER_OFFLINE: 'Not connected to the DomAgent server. Your tabs are unchanged.',
    BROWSER_REVOKED: 'This browser is no longer registered with the server. Set it up again to continue.',
    NOT_AUTHORIZED: 'The server did not accept this browser. Check the server address.',
    INVALID_SERVICE: 'That address is not a DomAgent server.',
    INVALID_SERVICE_ORIGIN: 'Enter a server domain such as domagent.example.com (HTTPS only).',
    SERVICE_UNREACHABLE: 'The DomAgent server could not be reached. DomAgent will keep trying.',
    UPGRADE_REQUIRED: 'This server runs a different DomAgent version. Update the extension or the server.',
    PERMISSION_REQUIRED: 'The browser permission was declined, so nothing was started.',
    ACTION_EXPIRED: 'That request is no longer waiting.',
    PAIRING_UNAVAILABLE: 'The pairing code expired. Start pairing again.',
    PAIRING_CODE_COLLISION: 'That code was taken. Try again for a new one.',
    NOTIFICATION_UNAVAILABLE: 'A system notification could not be shown. Check notification settings.',
    CLIPBOARD_UNAVAILABLE: 'Copy failed. Select the text and copy it manually.',
    PROTECTION_UNAVAILABLE: 'A tab could not be protected, so it was not shared.',
    TAB_LIMIT_REACHED: 'A session can share at most 8 tabs.',
    INVALID_ARGUMENT: 'Check the value you entered.',
    RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
    KEY_ALREADY_REGISTERED: 'This browser is already registered. Reload the window.',
    SCRIPT_EXECUTION_UNAVAILABLE: 'Page scripts are unavailable. Enable them in Settings (Firefox) or allow user scripts (Chrome).',
  };
  return messages[code] || `Something went wrong (${code}).`;
}

export function operationLabel(operation: string | undefined): string {
  const names: Record<string, string> = {
    get_text: 'Reading text', get_page_snapshot: 'Reading the page', inspect_element: 'Checking an element',
    navigate: 'Opening a page', wait_for_page: 'Waiting for the page', type_text: 'Typing',
    click: 'Clicking', select_option: 'Choosing an option', set_checked: 'Toggling a checkbox',
    evaluate_script: 'Running a script', create_tab: 'Opening a tab', request_handoff: 'Asked for your help',
    get_screenshot: 'Taking a screenshot', get_interactive_elements: 'Listing controls', press_key: 'Pressing a key',
    scroll: 'Scrolling', clear_overlays: 'Clearing overlays',
  };
  return operation ? names[operation] || operation.replaceAll('_', ' ') : '';
}
