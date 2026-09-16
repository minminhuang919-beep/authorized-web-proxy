/**
 * The domain allowlist.
 *
 * Two sources are merged:
 *  - `PROXY_ALLOWED_DOMAINS` from the environment (locked: cannot be removed
 *    through the admin UI, only by changing the environment), and
 *  - entries added through the admin UI, persisted to `<DATA_DIR>/allowlist.json`.
 *
 * Matching is strict: `example.com` matches only `example.com`;
 * `*.example.com` matches any subdomain but not the bare domain.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAllowlistPattern } from './security/hostname.js';

export class Allowlist {
  /**
   * @param {object} opts
   * @param {string[]} opts.envDomains patterns from the environment
   * @param {string} [opts.filePath] JSON file for admin-added patterns (optional)
   * @param {import('pino').Logger} [opts.logger]
   */
  constructor({ envDomains = [], filePath = null, logger = null } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    /** @type {Map<string, { pattern: string, wildcard: boolean, host: string, source: 'env'|'admin', addedAt: string|null }>} */
    this.entries = new Map();
    for (const raw of envDomains) {
      const parsed = parseAllowlistPattern(raw);
      if (!parsed) {
        throw new Error(`PROXY_ALLOWED_DOMAINS contains an invalid entry: "${raw}"`);
      }
      this.entries.set(parsed.pattern, { ...parsed, source: 'env', addedAt: null });
    }
    this.envPatterns = new Set([...this.entries.keys()]);
  }

  /** Load admin-added entries from disk (no-op when no file is configured). */
  async load() {
    if (!this.filePath) return this;
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return this;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Allowlist file ${this.filePath} is not valid JSON`);
    }
    for (const item of Array.isArray(data?.domains) ? data.domains : []) {
      const raw = typeof item === 'string' ? item : item?.pattern;
      const parsed = parseAllowlistPattern(raw);
      if (!parsed) {
        this.logger?.warn({ entry: raw }, 'ignoring invalid allowlist entry from file');
        continue;
      }
      if (this.entries.has(parsed.pattern)) continue; // env wins
      this.entries.set(parsed.pattern, {
        ...parsed,
        source: 'admin',
        addedAt: typeof item?.addedAt === 'string' ? item.addedAt : null
      });
    }
    return this;
  }

  async persist() {
    if (!this.filePath) return;
    const domains = [...this.entries.values()]
      .filter((e) => e.source === 'admin')
      .map((e) => ({ pattern: e.pattern, addedAt: e.addedAt }));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, domains }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /**
   * @param {string} hostname normalised hostname
   * @returns {boolean}
   */
  isAllowed(hostname) {
    if (typeof hostname !== 'string' || !hostname) return false;
    const host = hostname.toLowerCase();
    if (this.entries.has(host) && !this.entries.get(host).wildcard) return true;
    let idx = host.indexOf('.');
    while (idx !== -1) {
      const suffix = host.slice(idx + 1);
      const entry = this.entries.get(`*.${suffix}`);
      if (entry) return true;
      idx = host.indexOf('.', idx + 1);
    }
    return false;
  }

  /** All patterns (for display / the client-side shim). */
  patterns() {
    return [...this.entries.keys()];
  }

  list() {
    return [...this.entries.values()].map((e) => ({ pattern: e.pattern, source: e.source, addedAt: e.addedAt }));
  }

  get size() {
    return this.entries.size;
  }

  /**
   * Add a pattern (admin action).
   * @returns {{ ok: true, pattern: string } | { ok: false, error: string }}
   */
  async add(raw) {
    const parsed = parseAllowlistPattern(raw);
    if (!parsed) return { ok: false, error: 'Enter a valid hostname such as example.com or *.example.com (no IP addresses, ports or paths).' };
    if (this.entries.has(parsed.pattern)) return { ok: false, error: `"${parsed.pattern}" is already on the allowlist.` };
    this.entries.set(parsed.pattern, { ...parsed, source: 'admin', addedAt: new Date().toISOString() });
    await this.persist();
    return { ok: true, pattern: parsed.pattern };
  }

  /**
   * Remove an admin-added pattern.
   * @returns {{ ok: true, pattern: string } | { ok: false, error: string }}
   */
  async remove(raw) {
    const parsed = parseAllowlistPattern(raw);
    if (!parsed || !this.entries.has(parsed.pattern)) return { ok: false, error: 'That domain is not on the allowlist.' };
    if (this.entries.get(parsed.pattern).source === 'env') {
      return { ok: false, error: `"${parsed.pattern}" comes from PROXY_ALLOWED_DOMAINS and can only be removed by changing the environment.` };
    }
    this.entries.delete(parsed.pattern);
    await this.persist();
    return { ok: true, pattern: parsed.pattern };
  }
}
