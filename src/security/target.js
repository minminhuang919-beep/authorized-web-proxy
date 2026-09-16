/**
 * Parsing and validation of proxy targets.
 *
 * Proxied URLs live under `/p/<scheme>/<host><path>?<query>` on the proxy's
 * own origin, e.g. `https://example.com/a/b?x=1` → `/p/https/example.com/a/b?x=1`.
 * Embedding the scheme and host in the path means the browser resolves
 * page-relative links correctly on its own.
 */
import { DomainNotAllowedError, InvalidUrlError, UnsupportedProtocolError } from '../errors.js';
import { isSpecialUseHostname, normalizeHostname } from './hostname.js';

export const PROXY_PREFIX = '/p/';
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Validate an absolute URL against the proxy's rules and the allowlist.
 * Returns a normalised copy (lower-case host, no credentials, default port).
 * @param {URL} url
 * @param {import('../allowlist.js').Allowlist} allowlist
 * @returns {URL}
 */
export function validateTarget(url, allowlist) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsupportedProtocolError(url.protocol.replace(/:$/, ''));
  }
  if (url.username || url.password) {
    throw new InvalidUrlError('Addresses that embed a username or password are not supported.');
  }
  if (url.port !== '') {
    throw new InvalidUrlError('Addresses with a custom port are not supported by this proxy.');
  }
  const host = normalizeHostname(url.hostname);
  if (!host) {
    throw new InvalidUrlError('The address must contain a valid domain name (IP addresses are not supported).');
  }
  if (isSpecialUseHostname(host) || !allowlist.isAllowed(host)) {
    throw new DomainNotAllowedError(host);
  }
  const clean = new URL(url.href);
  clean.hostname = host;
  clean.username = '';
  clean.password = '';
  clean.hash = '';
  return clean;
}

/**
 * Turn whatever the user typed into the homepage box into a validated URL.
 * @param {string} input
 * @param {import('../allowlist.js').Allowlist} allowlist
 * @param {{ maxLength?: number }} [opts]
 */
export function parseUserUrl(input, allowlist, { maxLength = 4096 } = {}) {
  if (typeof input !== 'string') throw new InvalidUrlError();
  let text = input.trim();
  if (!text) throw new InvalidUrlError('Please enter a web address.');
  if (text.length > maxLength) throw new InvalidUrlError('That address is too long.');
  if (/[\s\p{Cc}]/u.test(text)) throw new InvalidUrlError('The address contains invalid characters.');
  if (text.startsWith('//')) text = `https:${text}`;
  else if (!SCHEME_RE.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidUrlError();
  }
  return validateTarget(url, allowlist);
}

/**
 * Build the proxied path for an absolute http(s) URL.
 * @param {URL} url
 */
export function toProxyPath(url) {
  return `${PROXY_PREFIX}${url.protocol.replace(':', '')}/${url.hostname}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Split a raw request URL of the form `/p/<scheme>/<host>[/path][?query]`.
 * Returns null if it is not a proxy path at all.
 * @param {string} rawUrl `request.raw.url`
 * @returns {{ scheme: string, host: string, rest: string }|null}
 */
export function splitProxyPath(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith(PROXY_PREFIX)) return null;
  const afterPrefix = rawUrl.slice(PROXY_PREFIX.length);
  const slash = afterPrefix.indexOf('/');
  if (slash === -1) return null;
  const scheme = afterPrefix.slice(0, slash);
  if (scheme !== 'http' && scheme !== 'https') return null;
  const remainder = afterPrefix.slice(slash + 1);
  const end = remainder.search(/[/?#]/);
  const host = end === -1 ? remainder : remainder.slice(0, end);
  if (!host) return null;
  let rest = end === -1 ? '' : remainder.slice(end);
  if (rest === '' || rest.startsWith('?')) rest = `/${rest}`;
  const hash = rest.indexOf('#');
  if (hash !== -1) rest = rest.slice(0, hash);
  return { scheme, host, rest };
}

/**
 * Resolve a raw proxy request URL into a validated upstream target.
 * @param {string} rawUrl
 * @param {import('../allowlist.js').Allowlist} allowlist
 * @returns {{ target: URL, scheme: string, host: string, rest: string }}
 */
export function targetFromProxyPath(rawUrl, allowlist, { maxLength = 4096 } = {}) {
  const parts = splitProxyPath(rawUrl);
  if (!parts) throw new InvalidUrlError();
  if (rawUrl.length > maxLength) throw new InvalidUrlError('That address is too long.');
  const host = normalizeHostname(parts.host);
  if (!host) throw new InvalidUrlError('The address must contain a valid domain name (IP addresses are not supported).');
  let url;
  try {
    url = new URL(`${parts.scheme}://${host}${parts.rest}`);
  } catch {
    throw new InvalidUrlError();
  }
  const target = validateTarget(url, allowlist);
  return { target, scheme: parts.scheme, host, rest: parts.rest };
}
