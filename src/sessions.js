/**
 * In-memory sessions.
 *
 * A session holds (a) the per-visitor cookie jar for proxied sites, so that
 * upstream cookies never reach the visitor's browser, and (b) the admin login
 * state + CSRF token. Sessions are ephemeral: they expire after
 * `SESSION_TTL` seconds of inactivity and are lost on restart, which is the
 * desired "anonymous view" behaviour.
 */
import { randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';

export const SESSION_COOKIE = 'pxy_sid';
export const ADMIN_COOKIE = 'pxy_admin';

export class SessionStore {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs idle lifetime
   * @param {number} opts.max  maximum sessions kept (oldest evicted first)
   */
  constructor({ ttlMs, max }) {
    this.ttlMs = ttlMs;
    this.max = max;
    /** @type {Map<string, Session>} insertion order == least-recently-seen first (we re-insert on touch) */
    this.sessions = new Map();
    this.timer = null;
    this.evictions = 0;
  }

  start(intervalMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns {Session} */
  create() {
    if (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
      this.evictions++;
    }
    const id = randomBytes(24).toString('base64url');
    const now = Date.now();
    const session = {
      id,
      createdAt: now,
      lastSeen: now,
      jar: new CookieJar(undefined, { rejectPublicSuffixes: true, looseMode: false }),
      admin: null,
      csrfToken: randomBytes(24).toString('base64url')
    };
    this.sessions.set(id, session);
    return session;
  }

  /** @returns {Session|null} */
  get(id) {
    if (typeof id !== 'string' || !id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    const now = Date.now();
    if (now - session.lastSeen > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    session.lastSeen = now;
    // Re-insert so Map order reflects recency (cheap LRU).
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeen > this.ttlMs) this.sessions.delete(id);
    }
  }

  stats() {
    let admins = 0;
    for (const s of this.sessions.values()) if (s.admin) admins++;
    return { active: this.sessions.size, adminSessions: admins, evictions: this.evictions, max: this.max, ttlSeconds: this.ttlMs / 1000 };
  }
}

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {number} createdAt
 * @property {number} lastSeen
 * @property {CookieJar} jar
 * @property {{ username: string, loginAt: number }|null} admin
 * @property {string} csrfToken
 */
