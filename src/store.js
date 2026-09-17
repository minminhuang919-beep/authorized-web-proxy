/**
 * Minimal JSON document persistence.
 *
 * `filePath === null` means "memory only": reads return nothing and writes
 * are no-ops. This is the mode used on hosts with an ephemeral filesystem
 * (Render's free plan), where admin changes intentionally do not survive a
 * restart and the environment variables are the source of truth.
 *
 * With a file path, writes are atomic (temp file + rename) and the file is
 * created with owner-only permissions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  /** @param {string|null} filePath */
  constructor(filePath) {
    this.filePath = filePath;
  }

  get persistent() {
    return this.filePath !== null;
  }

  /** @returns {Promise<object|null>} parsed document, or null when absent / memory mode */
  async read() {
    if (!this.filePath) return null;
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${this.filePath} is not valid JSON`);
    }
  }

  /** @param {object} doc */
  async write(doc) {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }
}
