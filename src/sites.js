/**
 * The site directory: administrator-configured shortcuts ("aliases") such as
 * `google` → `https://google.com`, so visitors can type a name instead of a
 * full address.
 *
 * A shortcut is a convenience, never an authorization. Every destination is
 * validated with exactly the rules a typed address gets (`validateTarget`:
 * http/https only, a named host — no IP literals, ports or credentials —,
 * inside the authorized scope and not blacklisted) when an administrator
 * saves it, and again every time it is resolved; SSRF address checks still
 * run at connection time. Sources:
 *  - `PROXY_SITES` from the environment (locked; removable only there),
 *  - entries added through the admin UI / API, persisted through a JsonStore
 *    (file mode) or kept in memory (ephemeral hosts).
 *
 * Environment format (comma separated):
 *   shortcut=destination[|Name[|Description]]
 *   google=https://google.com|Google|Google Search, yt=youtube.com|YouTube
 * A `!` before the shortcut marks the entry as disabled.
 */
import { createHash } from 'node:crypto';
import { ConfigError } from './config.js';
import { ProxyError } from './errors.js';
import { asPolicy } from './policy.js';
import { isSpecialUseHostname } from './security/hostname.js';
import { validateTarget } from './security/target.js';
import { JsonStore } from './store.js';

export const SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_NAME = 60;
export const MAX_DESCRIPTION = 120;
const MAX_DESTINATION = 2048;
const MAX_ENTRIES = 500;

/** Policy stand-in for syntax-only validation (env/file loading). */
const SYNTAX_ONLY = { assertPermitted() {} };

/** Used when no policy is given (unit tests): everything is in scope. */
const PERMISSIVE = { assertPermitted() {}, isAuthorized: () => true, isBlacklisted: () => false };

/** Stable identifier for a shortcut (deterministic so env entries keep their id). */
export function entryId(shortcut) {
  return createHash('sha256').update(`site:${shortcut}`).digest('hex').slice(0, 16);
}

/** Lower-case a shortcut typed by anyone; null when it is not a valid shortcut. */
export function normalizeShortcut(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return SHORTCUT_RE.test(s) ? s : null;
}

/** @returns {{ ok: true, shortcut: string } | { ok: false, error: string }} */
export function parseShortcut(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Enter a shortcut.' };
  const shortcut = normalizeShortcut(raw);
  if (!shortcut) {
    return { ok: false, error: 'A shortcut is 1–32 characters: letters, digits, hyphens or underscores (no spaces or dots), for example "google".' };
  }
  return { ok: true, shortcut };
}

/** Clean free text (name / description): no control characters, single spaces, capped length. */
export function sanitizeText(raw, max) {
  if (raw === undefined || raw === null) return '';
  // eslint-disable-next-line no-control-regex
  const text = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function defaultName(shortcut) {
  return shortcut.charAt(0).toUpperCase() + shortcut.slice(1);
}

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(s)) return false;
  return fallback;
}

/**
 * Validate a destination exactly the way a typed address is validated
 * (scheme, named host, no port/credentials, authorized scope, blacklist).
 * @param {string} raw
 * @param {object} policy access policy (or a bare allowlist)
 * @returns {{ ok: true, url: URL, host: string } | { ok: false, code: string, error: string }}
 */
export function parseDestination(raw, policy) {
  const invalid = (error) => ({ ok: false, code: 'INVALID_DESTINATION', error });
  if (typeof raw !== 'string') return invalid('Enter a destination address.');
  let text = raw.trim();
  if (!text) return invalid('Enter a destination address.');
  if (text.length > MAX_DESTINATION) return invalid('That destination is too long.');
  if (/[\s\p{Cc}]/u.test(text)) return invalid('The destination contains invalid characters.');
  if (text.startsWith('//')) text = `https:${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return invalid('Enter a valid destination such as https://example.com/.');
  }
  try {
    const clean = validateTarget(url, policy);
    return { ok: true, url: clean, host: clean.hostname };
  } catch (err) {
    if (!(err instanceof ProxyError)) throw err;
    const host = url.hostname.toLowerCase();
    if (err.code === 'DOMAIN_NOT_ALLOWED') {
      if (isSpecialUseHostname(host)) return invalid(`"${host}" is an internal or special-use name and can never be proxied.`);
      return { ok: false, code: 'DESTINATION_NOT_AUTHORIZED', error: `"${host}" is outside the authorized scope. Authorize it on the Settings page before creating a shortcut for it.` };
    }
    if (err.code === 'DOMAIN_BLACKLISTED') {
      return { ok: false, code: 'DESTINATION_BLACKLISTED', error: `"${host}" is blacklisted. Remove it from the blacklist before creating a shortcut for it.` };
    }
    return invalid(err.message);
  }
}

/**
 * Parse the PROXY_SITES environment value.
 * @returns {{ entries: Array<{ shortcut: string, destination: string, name: string, description: string, enabled: boolean }>, errors: string[] }}
 */
export function parseSitesEnv(value) {
  const entries = [];
  const errors = [];
  for (const piece of String(value || '').split(/[,\n]+/)) {
    const item = piece.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq === -1) {
      errors.push(`"${item}": expected shortcut=destination`);
      continue;
    }
    let shortcutRaw = item.slice(0, eq).trim();
    let enabled = true;
    if (shortcutRaw.startsWith('!')) {
      enabled = false;
      shortcutRaw = shortcutRaw.slice(1).trim();
    }
    const parsed = parseShortcut(shortcutRaw);
    if (!parsed.ok) {
      errors.push(`"${shortcutRaw}": ${parsed.error}`);
      continue;
    }
    const [destination = '', name = '', ...descriptionParts] = item.slice(eq + 1).split('|');
    entries.push({
      shortcut: parsed.shortcut,
      destination: destination.trim(),
      name: name.trim(),
      description: descriptionParts.join('|').trim(),
      enabled
    });
  }
  return { entries, errors };
}

export class SiteDirectory {
  /**
   * @param {object} opts
   * @param {string} [opts.envValue] PROXY_SITES
   * @param {string|null} [opts.filePath] JSON file, or null for memory-only
   * @param {object} [opts.policy] access policy (authorized scope + blacklist)
   * @param {import('pino').Logger} [opts.logger]
   */
  constructor({ envValue = '', filePath = null, policy = null, logger = null } = {}) {
    this.store = new JsonStore(filePath);
    this.policy = policy ? asPolicy(policy) : PERMISSIVE;
    this.logger = logger;
    /** @type {Map<string, SiteEntry>} keyed by shortcut, insertion order = env order then admin order */
    this.entries = new Map();
    const { entries, errors } = parseSitesEnv(envValue);
    if (errors.length) {
      throw new ConfigError(`PROXY_SITES contains invalid entries: ${errors.join('; ')}`);
    }
    for (const e of entries) {
      const dest = parseDestination(e.destination, SYNTAX_ONLY);
      if (!dest.ok) throw new ConfigError(`PROXY_SITES: "${e.shortcut}": ${dest.error}`);
      if (this.entries.has(e.shortcut)) throw new ConfigError(`PROXY_SITES: duplicate shortcut "${e.shortcut}"`);
      this.entries.set(e.shortcut, this.#make({ ...e, destination: dest.url.href, host: dest.host, source: 'env', addedAt: null, updatedAt: null }));
    }
  }

  #make({ shortcut, name, destination, host, description, enabled, source, addedAt, updatedAt }) {
    return {
      id: entryId(shortcut),
      shortcut,
      name: sanitizeText(name, MAX_NAME) || defaultName(shortcut),
      destination,
      host,
      description: sanitizeText(description, MAX_DESCRIPTION),
      enabled: enabled !== false,
      source,
      addedAt,
      updatedAt
    };
  }

  #view(entry) {
    return { ...entry, status: this.statusOf(entry) };
  }

  get persistent() {
    return this.store.persistent;
  }

  async load() {
    const doc = await this.store.read();
    for (const item of Array.isArray(doc?.entries) ? doc.entries : []) {
      const parsed = parseShortcut(item?.shortcut);
      const dest = parsed.ok ? parseDestination(item?.destination, SYNTAX_ONLY) : { ok: false };
      if (!parsed.ok || !dest.ok) {
        this.logger?.warn({ entry: item?.shortcut }, 'ignoring invalid site directory entry from file');
        continue;
      }
      if (this.entries.has(parsed.shortcut)) continue; // env wins
      this.entries.set(
        parsed.shortcut,
        this.#make({
          shortcut: parsed.shortcut,
          name: item.name,
          destination: dest.url.href,
          host: dest.host,
          description: item.description,
          enabled: toBool(item.enabled, true),
          source: 'admin',
          addedAt: typeof item.addedAt === 'string' ? item.addedAt : null,
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null
        })
      );
    }
    return this;
  }

  async persist() {
    const entries = [...this.entries.values()]
      .filter((e) => e.source === 'admin')
      .map((e) => ({ shortcut: e.shortcut, name: e.name, destination: e.destination, description: e.description, enabled: e.enabled, addedAt: e.addedAt, updatedAt: e.updatedAt }));
    await this.store.write({ version: 1, entries });
  }

  /**
   * Whether the destination is currently usable under the access policy.
   * Evaluated live because the scope and the blacklist can change at runtime.
   * @returns {'ok'|'blacklisted'|'unauthorized'}
   */
  statusOf(entry) {
    if (!this.policy.isAuthorized(entry.host)) return 'unauthorized';
    if (this.policy.isBlacklisted(entry.host)) return 'blacklisted';
    return 'ok';
  }

  get size() {
    return this.entries.size;
  }

  get enabledCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.enabled) n++;
    return n;
  }

  /** Does an *enabled* shortcut with this name exist? (case-insensitive) */
  has(raw) {
    const shortcut = normalizeShortcut(raw);
    return shortcut !== null && this.entries.get(shortcut)?.enabled === true;
  }

  /**
   * The enabled entry for a shortcut, or null. The destination still has to
   * pass the access policy — callers validate it with `validateTarget`.
   * @returns {SiteEntry|null}
   */
  resolve(raw) {
    const shortcut = normalizeShortcut(raw);
    if (shortcut === null) return null;
    const entry = this.entries.get(shortcut);
    return entry && entry.enabled ? this.#view(entry) : null;
  }

  getById(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
    for (const e of this.entries.values()) if (e.id === id) return this.#view(e);
    return null;
  }

  /**
   * @param {{ q?: string }} [opts] optional case-insensitive filter on name/shortcut/host/description
   * @returns {SiteEntry[]} alphabetical by shortcut
   */
  list({ q = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return [...this.entries.values()]
      .filter((e) => !needle || e.shortcut.includes(needle) || e.name.toLowerCase().includes(needle) || e.host.includes(needle) || e.description.toLowerCase().includes(needle))
      .map((e) => this.#view(e))
      .sort((a, b) => a.shortcut.localeCompare(b.shortcut));
  }

  /** Enabled, currently usable entries for the homepage quick links (configuration order). */
  featured(limit = 8) {
    const out = [];
    for (const e of this.entries.values()) {
      if (!e.enabled || this.statusOf(e) !== 'ok') continue;
      out.push({ name: e.name, shortcut: e.shortcut, host: e.host, description: e.description });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Autocomplete: enabled, usable entries matching what was typed — shortcut
   * prefix first, then name prefix, then a word of the name, then a label of
   * the host (`youtube` for youtube.com); substrings only from 3 characters.
   */
  suggest(q, limit = 8) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return [];
    const scored = [];
    for (const e of this.entries.values()) {
      if (!e.enabled || this.statusOf(e) !== 'ok') continue;
      const name = e.name.toLowerCase();
      let rank;
      if (e.shortcut.startsWith(needle)) rank = 0;
      else if (name.startsWith(needle)) rank = 1;
      else if (name.split(' ').some((w) => w.startsWith(needle))) rank = 2;
      else if (e.host.split('.').some((label) => label.startsWith(needle))) rank = 3;
      else if (needle.length >= 3 && (e.shortcut.includes(needle) || name.includes(needle) || e.host.includes(needle))) rank = 4;
      else continue;
      scored.push({ rank, e });
    }
    scored.sort((a, b) => a.rank - b.rank || a.e.shortcut.localeCompare(b.e.shortcut));
    return scored.slice(0, limit).map(({ e }) => ({ name: e.name, shortcut: e.shortcut, host: e.host, description: e.description }));
  }

  /**
   * Create a shortcut (admin action). The destination must pass the access policy.
   * @returns {Promise<{ ok: true, entry: SiteEntry } | { ok: false, status: number, code: string, error: string }>}
   */
  async add({ name, shortcut, destination, description, enabled } = {}) {
    const sc = parseShortcut(shortcut);
    if (!sc.ok) return { ok: false, status: 400, code: 'INVALID_SHORTCUT', error: sc.error };
    const existing = this.entries.get(sc.shortcut);
    if (existing) return { ok: false, status: 409, code: 'DUPLICATE', error: `The shortcut "${sc.shortcut}" is already used by ${existing.name}.` };
    const dest = parseDestination(destination, this.policy);
    if (!dest.ok) return { ok: false, status: 400, code: dest.code, error: dest.error };
    if (this.entries.size >= MAX_ENTRIES) return { ok: false, status: 400, code: 'FULL', error: 'The site directory is full.' };
    const now = new Date().toISOString();
    const entry = this.#make({
      shortcut: sc.shortcut,
      name,
      destination: dest.url.href,
      host: dest.host,
      description,
      enabled: toBool(enabled, true),
      source: 'admin',
      addedAt: now,
      updatedAt: now
    });
    this.entries.set(entry.shortcut, entry);
    await this.persist();
    return { ok: true, entry: this.#view(entry) };
  }

  /**
   * Update an admin-created shortcut. Only the given fields change; the
   * destination (new or unchanged) is always re-validated against the policy.
   * @returns {Promise<{ ok: true, entry: SiteEntry } | { ok: false, status: number, code: string, error: string }>}
   */
  async update(id, fields = {}) {
    const current = this.getById(id);
    if (!current) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'That shortcut does not exist.' };
    if (current.source === 'env') {
      return { ok: false, status: 403, code: 'LOCKED', error: `"${current.shortcut}" comes from PROXY_SITES and can only be changed by editing the environment.` };
    }
    let shortcut = current.shortcut;
    if (fields.shortcut !== undefined) {
      const sc = parseShortcut(fields.shortcut);
      if (!sc.ok) return { ok: false, status: 400, code: 'INVALID_SHORTCUT', error: sc.error };
      shortcut = sc.shortcut;
      const clash = shortcut !== current.shortcut ? this.entries.get(shortcut) : null;
      if (clash) return { ok: false, status: 409, code: 'DUPLICATE', error: `The shortcut "${shortcut}" is already used by ${clash.name}.` };
    }
    const dest = parseDestination(fields.destination !== undefined ? fields.destination : current.destination, this.policy);
    if (!dest.ok) return { ok: false, status: 400, code: dest.code, error: dest.error };
    const entry = this.#make({
      shortcut,
      name: fields.name !== undefined ? fields.name : current.name,
      destination: dest.url.href,
      host: dest.host,
      description: fields.description !== undefined ? fields.description : current.description,
      enabled: fields.enabled !== undefined ? toBool(fields.enabled, current.enabled) : current.enabled,
      source: 'admin',
      addedAt: current.addedAt,
      updatedAt: new Date().toISOString()
    });
    this.entries.delete(current.shortcut);
    this.entries.set(entry.shortcut, entry);
    await this.persist();
    return { ok: true, entry: this.#view(entry) };
  }

  /** Enable or disable an admin-created shortcut. */
  async setEnabled(id, enabled) {
    return this.update(id, { enabled: Boolean(enabled) });
  }

  /**
   * @returns {Promise<{ ok: true, entry: SiteEntry } | { ok: false, status: number, code: string, error: string }>}
   */
  async remove(id) {
    const entry = this.getById(id);
    if (!entry) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'That shortcut does not exist.' };
    if (entry.source === 'env') {
      return { ok: false, status: 403, code: 'LOCKED', error: `"${entry.shortcut}" comes from PROXY_SITES and can only be removed by editing the environment.` };
    }
    this.entries.delete(entry.shortcut);
    await this.persist();
    return { ok: true, entry };
  }

  /** Value for PROXY_SITES that reproduces the current directory (all sources). */
  exportEnvValue() {
    return [...this.entries.values()]
      .map((e) => {
        const destination = e.destination.replace(/,/g, '%2C').replace(/\|/g, '%7C');
        const name = e.name.replace(/[,|]/g, ';');
        const description = e.description.replace(/[,|]/g, ';');
        const parts = [`${e.enabled ? '' : '!'}${e.shortcut}=${destination}`];
        if (description || name !== defaultName(e.shortcut)) parts.push(name);
        if (description) parts.push(description);
        return parts.join('|');
      })
      .join(',');
  }
}

/**
 * @typedef {object} SiteEntry
 * @property {string} id
 * @property {string} shortcut lower-case, unique
 * @property {string} name display name
 * @property {string} destination normalised absolute URL
 * @property {string} host destination hostname
 * @property {string} description
 * @property {boolean} enabled
 * @property {'env'|'admin'} source
 * @property {string|null} addedAt ISO timestamp (null for env entries)
 * @property {string|null} updatedAt
 * @property {'ok'|'blacklisted'|'unauthorized'} [status] live policy status (on returned copies)
 */
