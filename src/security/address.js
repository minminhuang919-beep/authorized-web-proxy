/**
 * IP address classification used to stop the proxy from ever connecting to
 * loopback, private, link-local, multicast, reserved or otherwise internal
 * addresses (SSRF protection). Anything that cannot be parsed is treated as
 * blocked — the check fails closed.
 */
import net from 'node:net';

/** @typedef {{ base: number, bits: number }} V4Range */

/** IPv4 ranges that must never be contacted. */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + limited broadcast
].map(([ip, bits]) => ({ base: ipv4ToInt(ip), bits }));

/** IPv6 ranges that must never be contacted (besides embedded-IPv4 forms). */
const BLOCKED_V6 = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (embeds obfuscated IPv4)
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID (deprecated)
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // SRv6 SIDs (RFC 9602)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8] // multicast
].map(([ip, bits]) => ({ base: ipv6ToBigInt(ip), bits }));

const V6_MAX = (1n << 128n) - 1n;
/** Upper 96 bits of the NAT64 well-known prefix 64:ff9b::/96. */
const NAT64_PREFIX = ipv6ToBigInt('64:ff9b::') >> 32n;
/** Upper 96 bits of the IPv4-mapped prefix ::ffff:0:0/96. */
const V4_MAPPED_PREFIX = 0xffffn;

export function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`bad ipv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new Error(`bad ipv4: ${ip}`);
    const v = Number(p);
    if (v > 255) throw new Error(`bad ipv4: ${ip}`);
    n = n * 256 + v;
  }
  return n;
}

/** Parse a textual IPv6 address into a 128-bit BigInt. */
export function ipv6ToBigInt(ip) {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded dotted-quad at the end (e.g. ::ffff:1.2.3.4)
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    s = `${s.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) throw new Error(`bad ipv6: ${ip}`);
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) throw new Error(`bad ipv6: ${ip}`);
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`bad ipv6: ${ip}`);
    n = (n << 16n) | BigInt(Number.parseInt(g, 16));
  }
  return n;
}

function inV4Range(n, { base, bits }) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

function inV6Range(n, { base, bits }) {
  const mask = bits === 0 ? 0n : (V6_MAX << BigInt(128 - bits)) & V6_MAX;
  return (n & mask) === (base & mask);
}

/** True when the IPv4 address (string) is a public, routable unicast address. */
export function isPublicIPv4(ip) {
  if (net.isIPv4(ip) !== true) return false;
  const n = ipv4ToInt(ip);
  return !BLOCKED_V4.some((r) => inV4Range(n, r));
}

/** True when the IPv6 address (string) is a public, routable unicast address. */
export function isPublicIPv6(ip) {
  if (!net.isIPv6(ip)) return false;
  let n;
  try {
    n = ipv6ToBigInt(ip);
  } catch {
    return false;
  }
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses are
  // judged by the IPv4 address they embed.
  const upper96 = n >> 32n;
  if (upper96 === V4_MAPPED_PREFIX || upper96 === NAT64_PREFIX) {
    return isPublicIPv4(intToIPv4(Number(n & 0xffffffffn)));
  }
  return !BLOCKED_V6.some((r) => inV6Range(n, r));
}

function intToIPv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Decide whether the proxy may open a connection to `address`.
 * @param {string} address IP address as returned by DNS resolution
 */
export function isAddressAllowed(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const kind = net.isIP(address);
  if (kind === 4) return isPublicIPv4(address);
  if (kind === 6) return isPublicIPv6(address);
  return false;
}
