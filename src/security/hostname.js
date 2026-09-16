/**
 * Hostname validation. The proxy only ever talks to *named* hosts that are on
 * the allowlist; IP literals and special-use names are rejected before any
 * DNS resolution takes place.
 */
import net from 'node:net';

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Special-use / internal top-level names that must never be proxied. */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'home',
  'lan',
  'corp',
  'private',
  'onion',
  'arpa',
  'invalid'
];

/**
 * Normalise a hostname (lower-case, strip trailing dot). Returns null when the
 * value is not a syntactically valid DNS hostname.
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  if (host.startsWith('[') || net.isIP(host)) return null; // never IP literals
  const labels = host.split('.');
  if (labels.length < 2) return null; // require at least one dot
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // numeric TLD = disguised IPv4
  return host;
}

/**
 * True when the hostname is a special-use / internal name that must be
 * rejected regardless of the allowlist (defence in depth — the address check
 * happens as well).
 * @param {string} host normalised hostname
 */
export function isSpecialUseHostname(host) {
  const labels = host.split('.');
  return BLOCKED_SUFFIXES.includes(labels[labels.length - 1]);
}

/**
 * Validate an allowlist pattern such as `example.com` or `*.example.com`.
 * @returns {{ pattern: string, wildcard: boolean, host: string }|null}
 */
export function parseAllowlistPattern(value) {
  if (typeof value !== 'string') return null;
  let pattern = value.trim().toLowerCase();
  if (pattern.startsWith('https://') || pattern.startsWith('http://')) {
    pattern = pattern.replace(/^https?:\/\//, '').split('/')[0];
  }
  const wildcard = pattern.startsWith('*.');
  const host = normalizeHostname(wildcard ? pattern.slice(2) : pattern);
  if (!host || host.includes('*')) return null;
  return { pattern: wildcard ? `*.${host}` : host, wildcard, host };
}
