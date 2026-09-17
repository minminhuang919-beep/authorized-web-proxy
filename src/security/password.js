/**
 * Password hashing for the admin account (scrypt, Node built-in).
 *
 * Hash format: `scrypt$N$r$p$<salt base64>$<key base64>`.
 * Generate one with `npm run hash-password` and set ADMIN_PASSWORD_HASH so
 * the plaintext password never has to be stored anywhere.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULTS = { N: 16384, r: 8, p: 1, keyLength: 64 };
const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/** @param {string} password */
export function hashPassword(password, { N = DEFAULTS.N, r = DEFAULTS.r, p = DEFAULTS.p } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('password must be a non-empty string');
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, DEFAULTS.keyLength, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Is the string a well-formed hash produced by hashPassword()? */
export function isPasswordHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

/**
 * Constant-time verification.
 * @param {string} password candidate
 * @param {string} hash stored hash
 */
export function verifyPassword(password, hash) {
  const m = HASH_RE.exec(String(hash || ''));
  if (!m || typeof password !== 'string') return false;
  const [, N, r, p, saltB64, keyB64] = m;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
