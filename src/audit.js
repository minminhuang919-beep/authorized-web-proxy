/**
 * A small in-memory log of administrative configuration changes, shown on
 * the admin dashboard as "recent changes". Ephemeral by design (it is
 * operational context, not an audit trail of record); the server log
 * receives the same events for durable keeping.
 */
export class AuditLog {
  /** @param {{ max?: number }} [opts] */
  constructor({ max = 50 } = {}) {
    this.max = max;
    /** @type {AuditEntry[]} newest first */
    this.entries = [];
    this.counter = 0;
  }

  /**
   * @param {object} event
   * @param {string} event.action e.g. blacklist.add
   * @param {string} event.target the domain / pattern affected
   * @param {string} [event.detail]
   * @param {string} [event.actor] admin username
   */
  record({ action, target, detail = '', actor = '' }) {
    const entry = { id: ++this.counter, at: new Date().toISOString(), action, target, detail, actor };
    this.entries.unshift(entry);
    if (this.entries.length > this.max) this.entries.length = this.max;
    return entry;
  }

  /** @returns {AuditEntry[]} */
  recent(limit = 10) {
    return this.entries.slice(0, limit).map((e) => ({ ...e }));
  }

  get size() {
    return this.entries.length;
  }
}

/**
 * @typedef {object} AuditEntry
 * @property {number} id
 * @property {string} at ISO timestamp
 * @property {string} action
 * @property {string} target
 * @property {string} detail
 * @property {string} actor
 */
