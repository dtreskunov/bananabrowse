import { requireValue } from './errors.js';

export class RateLimiter {
  now: () => number;
  maxKeys: number;
  entries: Map<string, { count: number; expires: number }>;
  constructor(now: () => number = Date.now, maxKeys = 4096) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }
  take(key: string, limit: number, windowMs = 60_000): void {
    const now = this.now();
    for (const [id, row] of this.entries) if (row.expires <= now) this.entries.delete(id);
    let row = this.entries.get(key);
    if (!row) {
      requireValue(this.entries.size < this.maxKeys, 'RATE_LIMITED', 429);
      row = { count: 0, expires: now + windowMs };
      this.entries.set(key, row);
    }
    requireValue(++row.count <= limit, 'RATE_LIMITED', 429);
  }
}
