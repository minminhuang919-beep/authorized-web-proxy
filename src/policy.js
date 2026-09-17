/**
 * Access policy: the single place that decides whether a hostname may be
 * proxied, in this fixed order:
 *
 *   1. AUTHORIZED SCOPE  — the hostname must be on the authorized allowlist
 *                          (and must not be a special-use / internal name);
 *   2. BLACKLIST         — the administrator has not blocked it;
 *   3. SSRF/SECURITY     — performed later, on the resolved addresses, by the
 *                          upstream client (see security/safe-lookup.js).
 *
 * The blacklist can only narrow the authorized scope, never widen it.
 */
import { DomainBlockedError, DomainNotAllowedError } from './errors.js';
import { isSpecialUseHostname } from './security/hostname.js';

/**
 * @param {object} deps
 * @param {{ isAllowed(host: string): boolean }} deps.allowlist
 * @param {{ match(host: string): object|null }} [deps.blacklist]
 */
export function createAccessPolicy({ allowlist, blacklist = null }) {
  return {
    /** Is the hostname inside the authorized scope (ignoring the blacklist)? */
    isAuthorized(host) {
      return typeof host === 'string' && !isSpecialUseHostname(host) && allowlist.isAllowed(host);
    },
    /** Is the hostname blacklisted by an administrator? */
    isBlacklisted(host) {
      return blacklist ? blacklist.match(host) !== null : false;
    },
    /**
     * Throw the appropriate error when `host` may not be proxied.
     * @param {string} host normalised hostname
     */
    assertPermitted(host) {
      if (!this.isAuthorized(host)) throw new DomainNotAllowedError(host);
      if (this.isBlacklisted(host)) throw new DomainBlockedError(host);
    }
  };
}

/**
 * Accept either an access policy or a bare allowlist (convenience for tests
 * and for callers that only have the scope at hand).
 */
export function asPolicy(policyOrAllowlist) {
  if (policyOrAllowlist && typeof policyOrAllowlist.assertPermitted === 'function') return policyOrAllowlist;
  return createAccessPolicy({ allowlist: policyOrAllowlist });
}
