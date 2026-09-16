/**
 * A DNS `lookup` function for `net.connect` / `http.request` that validates
 * *every* resolved address right before the socket connects.
 *
 * Doing the check inside the lookup hook (instead of resolving first and
 * connecting later) closes the DNS-rebinding window: the addresses that are
 * validated are exactly the ones the socket will use, and a new resolution
 * happens for every new connection.
 */
import dns from 'node:dns';
import { LookupBlockedError } from '../errors.js';
import { isAddressAllowed as defaultIsAddressAllowed } from './address.js';

/**
 * @param {object} [opts]
 * @param {typeof dns.lookup} [opts.lookup] underlying resolver (tests inject a fake)
 * @param {(address: string) => boolean} [opts.isAddressAllowed]
 * @param {(hostname: string, address: string) => void} [opts.onBlocked] observer for logging/metrics
 */
export function createSafeLookup({ lookup = dns.lookup, isAddressAllowed = defaultIsAddressAllowed, onBlocked } = {}) {
  return function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    const wantAll = Boolean(options.all);

    lookup(hostname, { ...options, all: true }, (err, result) => {
      if (err) return callback(err);
      const addresses = normalizeAddresses(result);
      if (addresses.length === 0) {
        const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        e.code = 'ENOTFOUND';
        return callback(e);
      }
      // If *any* returned address is disallowed the whole host is refused —
      // mixing a public and a private record is a classic rebinding trick.
      for (const entry of addresses) {
        if (!isAddressAllowed(entry.address)) {
          if (onBlocked) onBlocked(hostname, entry.address);
          return callback(new LookupBlockedError(hostname, entry.address));
        }
      }
      if (wantAll) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function normalizeAddresses(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list
    .map((e) => (typeof e === 'string' ? { address: e, family: e.includes(':') ? 6 : 4 } : e))
    .filter((e) => e && typeof e.address === 'string')
    .map((e) => ({ address: e.address, family: e.family || (e.address.includes(':') ? 6 : 4) }));
}
