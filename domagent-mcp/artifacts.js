import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_ID_PATTERN, ARTIFACT_QUOTA_BYTES, ARTIFACT_QUOTA_COUNT, ARTIFACT_TTL_MS, MAX_ARTIFACT_BYTES,
} from '../shared/protocol.js';
import { Fault, requireValue, audit } from './errors.js';

const META = '.json', DATA = '.bin';

/**
 * Short-lived, agent-scoped blobs produced by page tools. Bytes never pass through the model:
 * agents receive a handle and download with their own MCP bearer key.
 * With a directory, artifacts survive restarts; without one (tests) they live in memory.
 */
export class ArtifactStore {
  constructor({ directory = null, now = Date.now, ttlMs = ARTIFACT_TTL_MS, quotaBytes = ARTIFACT_QUOTA_BYTES,
    quotaCount = ARTIFACT_QUOTA_COUNT, maxBytes = MAX_ARTIFACT_BYTES } = {}) {
    Object.assign(this, { directory, now, ttlMs, quotaBytes, quotaCount, maxBytes });
    this.index = new Map();
    this.memory = new Map();
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      this.load();
    }
  }

  load() {
    for (const entry of readdirSync(this.directory)) {
      const id = entry.slice(0, -META.length);
      if (!entry.endsWith(META) || !ARTIFACT_ID_PATTERN.test(id)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.directory, entry), 'utf8'));
        if (meta.id !== id || typeof meta.agent_id !== 'string') throw new Error('INVALID_ARTIFACT');
        this.index.set(id, meta);
      } catch { this.removeFiles(id); }
    }
    // Orphaned data files from an interrupted write are not addressable; drop them.
    for (const entry of readdirSync(this.directory)) {
      const id = entry.replace(/\.(bin|json)(\.tmp)?$/, '');
      if (!this.index.has(id)) rmSync(join(this.directory, entry), { force: true });
    }
    this.sweep();
  }

  removeFiles(id) {
    if (!this.directory) { this.memory.delete(id); return; }
    rmSync(join(this.directory, `${id}${DATA}`), { force: true });
    rmSync(join(this.directory, `${id}${META}`), { force: true });
  }

  sweep() {
    const now = this.now();
    for (const [id, meta] of this.index) {
      if (meta.expires_at <= now) { this.index.delete(id); this.removeFiles(id); }
    }
  }

  usage(agentId) {
    let bytes = 0, count = 0;
    for (const meta of this.index.values()) if (meta.agent_id === agentId) { bytes += meta.bytes; count++; }
    return { bytes, count };
  }

  put(agentId, data, { mime, name = null, source = null } = {}) {
    requireValue(Buffer.isBuffer(data), 'INVALID_RESULT');
    if (data.length > this.maxBytes) {
      throw Object.assign(new Fault('RESULT_TOO_LARGE'), { actual_bytes: data.length, limit_bytes: this.maxBytes });
    }
    this.sweep();
    // Evict the agent's oldest artifacts rather than refusing new work.
    const own = [...this.index.values()].filter(meta => meta.agent_id === agentId)
      .sort((a, b) => a.created_at - b.created_at);
    let { bytes, count } = this.usage(agentId);
    while (own.length && (bytes + data.length > this.quotaBytes || count + 1 > this.quotaCount)) {
      const oldest = own.shift();
      this.index.delete(oldest.id); this.removeFiles(oldest.id);
      bytes -= oldest.bytes; count--;
    }
    const id = `a${randomBytes(16).toString('base64url').slice(0, 22)}`;
    const created_at = this.now();
    const meta = { id, agent_id: agentId, name, mime, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'), created_at, expires_at: created_at + this.ttlMs,
      ...(source ? { source } : {}) };
    if (this.directory) {
      const write = (suffix, value) => {
        const path = join(this.directory, `${id}${suffix}`);
        writeFileSync(`${path}.tmp`, value, { mode: 0o600 });
        renameSync(`${path}.tmp`, path);
      };
      write(DATA, data);
      write(META, JSON.stringify(meta));
    } else this.memory.set(id, data);
    this.index.set(id, meta);
    audit('artifact_created', { agent_id: agentId });
    return meta;
  }

  meta(agentId, id) {
    if (typeof id !== 'string' || !ARTIFACT_ID_PATTERN.test(id)) throw new Fault('NOT_FOUND', 404);
    const meta = this.index.get(id);
    // Another agent's artifact is indistinguishable from a missing one.
    if (!meta || meta.agent_id !== agentId) throw new Fault('NOT_FOUND', 404);
    if (meta.expires_at <= this.now()) {
      this.index.delete(id); this.removeFiles(id);
      throw new Fault('NOT_FOUND', 404);
    }
    return meta;
  }

  read(agentId, id) {
    const meta = this.meta(agentId, id);
    let data;
    try { data = this.directory ? readFileSync(join(this.directory, `${id}${DATA}`)) : this.memory.get(id); }
    catch { data = undefined; }
    if (!data) { this.index.delete(id); this.removeFiles(id); throw new Fault('NOT_FOUND', 404); }
    return { meta, data };
  }

  remove(agentId, id) {
    this.meta(agentId, id);
    this.index.delete(id); this.removeFiles(id);
  }

  list(agentId) {
    this.sweep();
    return [...this.index.values()].filter(meta => meta.agent_id === agentId)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** Drop artifacts of agents no longer configured. */
  prune(agentIds) {
    const keep = new Set(agentIds);
    for (const [id, meta] of this.index) {
      if (!keep.has(meta.agent_id)) { this.index.delete(id); this.removeFiles(id); }
    }
  }
}
