/**
 * Turns whatever the visitor typed into the search box into an action, in
 * this fixed priority:
 *
 *   A. a configured shortcut (`google`)      → its destination, validated
 *                                              exactly like a typed address
 *   B. an explicit URL (`https://example.com`) → validated
 *   C. something that clearly looks like a domain (`example.com`,
 *      `example.co.uk`, `sub.example.com/page`) → `https://` + address, validated
 *   D. anything else (`geoguessr`, `weather today`) → a web search query
 *
 * A bare word is never turned into a domain: `geoguessr` is a search, not
 * `geoguessr.com`. "Validated" means the full chain: http/https only, named
 * host (no IP literals, ports or credentials), authorized scope, blacklist;
 * SSRF address checks follow at connection time in the upstream client.
 */
import net from 'node:net';
import { InvalidUrlError } from './errors.js';
import { normalizeHostname } from './security/hostname.js';
import { parseUserUrl, validateTarget } from './security/target.js';
import { normalizeShortcut } from './sites.js';

export const MAX_QUERY_LENGTH = 256;

// `scheme://…`, `http:…`/`https:…` in any form, or protocol-relative `//…`.
const EXPLICIT_URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|https?:|\/\/)/i;
// A top-level label of a real domain: letters only, at least two of them.
const TLD_RE = /^[a-z]{2,63}$/i;
// Control characters that are not whitespace (tabs/newlines still separate words).
const CONTROL_RE = /[^\P{Cc}\s]/gu;

const EMPTY_MESSAGE = 'Please enter a website, a shortcut or something to search for.';

/**
 * Does the value clearly look like a domain name? Requires a syntactically
 * valid hostname with at least two labels and an alphabetic top-level label
 * (`example.com`, `example.co.uk`, `sub.example.com`; not `geoguessr`,
 * `v1.2`, `3.14` or `e.g`).
 * @param {string} value
 */
export function isDomainLike(value) {
  const host = normalizeHostname(value);
  if (!host) return false;
  const labels = host.split('.');
  return labels.length >= 2 && TLD_RE.test(labels[labels.length - 1]);
}

/**
 * Classify raw input without touching the network or the policy.
 * @param {string} raw
 * @param {{ isShortcut?: (shortcut: string) => boolean }} [opts]
 * @returns {{ kind: 'empty' } | { kind: 'shortcut', shortcut: string } | { kind: 'url', value: string } | { kind: 'search', query: string }}
 */
export function classifyInput(raw, { isShortcut = () => false } = {}) {
  const text = typeof raw === 'string' ? raw.replace(CONTROL_RE, '').trim() : '';
  if (!text) return { kind: 'empty' };

  // A. an exact (case-insensitive) match of a configured shortcut.
  const shortcut = normalizeShortcut(text);
  if (shortcut !== null && isShortcut(shortcut)) return { kind: 'shortcut', shortcut };

  // Phrases are always searches.
  if (/\s/.test(text)) return { kind: 'search', query: text.replace(/\s+/g, ' ') };

  // B. explicit URLs (non-http(s) schemes are refused later with a clear message).
  if (EXPLICIT_URL_RE.test(text)) return { kind: 'url', value: text };

  // What would be the host if this were an address? (`user@` and `:port` are
  // stripped for the look only — validation rejects them with a clear message.)
  const authority = text.split(/[/?#]/, 1)[0];
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const bare = hostPart.startsWith('[') ? hostPart : hostPart.replace(/:\d*$/, '');

  // IP literals and `localhost` are addresses the proxy refuses; say so
  // instead of searching for them.
  if (bare.startsWith('[') || net.isIP(bare) || bare.toLowerCase() === 'localhost') return { kind: 'url', value: text };

  // C. clearly a domain (optionally with a path/query).
  if (isDomainLike(bare)) return { kind: 'url', value: text };

  // D. everything else is a search — never `word` → `word.com`.
  return { kind: 'search', query: text };
}

/**
 * Resolve the input against the site directory and the access policy.
 * @param {string} input
 * @param {object} opts
 * @param {import('./sites.js').SiteDirectory} [opts.sites]
 * @param {object} opts.policy access policy (or bare allowlist)
 * @param {number} [opts.maxLength]
 * @param {boolean} [opts.forceSearch] treat the input as a search query no matter what
 * @param {boolean} [opts.openOnly] "open this" semantics (/open): a shortcut or an
 *   address, never a search — words are rejected as invalid addresses
 * @returns {{ kind: 'site', entry: object, target: URL } | { kind: 'url', target: URL } | { kind: 'search', query: string }}
 */
export function resolveInput(input, { sites = null, policy, maxLength = 4096, forceSearch = false, openOnly = false }) {
  if (typeof input !== 'string') throw new InvalidUrlError(EMPTY_MESSAGE);
  if (input.length > maxLength) throw new InvalidUrlError('That address is too long.');

  const isShortcut = (s) => Boolean(sites && sites.has(s));
  let classified = forceSearch ? asSearch(input) : classifyInput(input, { isShortcut });
  if (openOnly && classified.kind === 'search') classified = { kind: 'url', value: classified.query };

  switch (classified.kind) {
    case 'empty':
      throw new InvalidUrlError(EMPTY_MESSAGE);
    case 'shortcut': {
      const entry = sites.resolve(classified.shortcut);
      // The configured destination goes through the very same checks as a typed URL.
      const target = validateTarget(new URL(entry.destination), policy);
      return { kind: 'site', entry, target };
    }
    case 'url':
      return { kind: 'url', target: parseUserUrl(classified.value, policy, { maxLength }) };
    default:
      return { kind: 'search', query: clampQuery(classified.query) };
  }
}

function asSearch(raw) {
  const text = raw.replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  return text ? { kind: 'search', query: text } : { kind: 'empty' };
}

export function clampQuery(query) {
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH).trim() : query;
}
