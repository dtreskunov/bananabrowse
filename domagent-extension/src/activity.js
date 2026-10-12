const MAX_EVENTS = 200;
const EVENTS = new Set([
  'connected', 'disconnected', 'sharing_requested', 'sharing_started', 'sharing_ended',
  'command_requested', 'approved', 'auto_approved', 'declined', 'execution_started',
  'completed', 'failed', 'cancelled', 'navigation', 'workspace_changed',
]);
const FIELDS = ['target_id', 'request_id', 'client_id', 'operation', 'code'];

export class ActivityHistory {
  constructor(storage, warning = () => {}) {
    this.storage = storage;
    this.warning = warning;
    this.entries = [];
    this.dirty = false;
    this.writing = false;
    this.unavailable = false;
  }
  async load() {
    try {
      const saved = await this.storage.get(['activityHistory']);
      this.entries = (Array.isArray(saved.activityHistory) ? saved.activityHistory : [])
        .filter(row => row && EVENTS.has(row.event) && Number.isFinite(row.time))
        .slice(-MAX_EVENTS).map(row => this.sanitize(row));
    } catch (error) {
      this.unavailable = true;
      this.warning(error);
    }
  }
  sanitize(row) {
    const result = { id: typeof row.id === 'string' ? row.id.slice(0, 64) : crypto.randomUUID(),
      time: row.time, event: row.event };
    for (const field of FIELDS) {
      if (typeof row[field] === 'string') result[field] = row[field].slice(0, 128);
    }
    return result;
  }
  record(event, fields = {}) {
    if (!EVENTS.has(event)) throw new Error('INVALID_ACTIVITY_EVENT');
    this.entries.push(this.sanitize({ ...fields, id: crypto.randomUUID(), time: Date.now(), event }));
    this.entries = this.entries.slice(-MAX_EVENTS);
    this.dirty = true;
    if (!this.writing) void this.persist();
  }
  async persist() {
    this.writing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.storage.set({ activityHistory: this.entries });
      }
      this.unavailable = false;
    } catch (error) {
      this.unavailable = true;
      this.warning(error);
    } finally {
      this.writing = false;
    }
  }
}
