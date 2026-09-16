/**
 * Header hygiene for both directions of a proxied exchange.
 *
 * Client → upstream: strip hop-by-hop headers, anything that identifies the
 * client or the proxy's own infrastructure, and the proxy's own cookies /
 * credentials. Upstream → client: strip hop-by-hop headers, cookies (kept in
 * the server-side jar), and every policy header that would otherwise be
 * applied by the browser to the *proxy's* origin (HSTS, CSP, COOP, …).
 */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/** Client request headers that are never forwarded upstream. */
const REQUEST_DROP = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'cookie2',
  'authorization',
  'expect',
  'forwarded',
  'via',
  'origin',
  'referer',
  'accept-encoding',
  'content-length',
  'x-real-ip',
  'true-client-ip',
  'x-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-original-url',
  'x-rewrite-url',
  'x-csrf-token',
  'x-requested-with'
]);

/** Prefixes of client request headers that are never forwarded upstream. */
const REQUEST_DROP_PREFIXES = ['sec-fetch-', 'cf-', 'x-forwarded-', 'x-amzn-', 'x-azure-', 'x-goog-'];

/** Upstream response headers that are never relayed to the client. */
const RESPONSE_DROP = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'set-cookie2',
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'expect-ct',
  'alt-svc',
  'report-to',
  'reporting-endpoints',
  'nel',
  'link',
  'clear-site-data',
  'www-authenticate',
  'cross-origin-opener-policy',
  'cross-origin-opener-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-embedder-policy-report-only',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'service-worker-allowed',
  'server',
  'x-powered-by',
  'p3p',
  'x-frame-options',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age'
]);

/**
 * Headers carrying byte-level metadata that are only valid when the body is
 * relayed untouched.
 */
const BODY_METADATA = new Set(['content-length', 'content-encoding', 'accept-ranges', 'content-range', 'content-md5', 'digest', 'etag']);

/**
 * @param {Record<string, string|string[]|undefined>} clientHeaders lower-cased headers from the client
 * @param {object} opts
 * @param {URL} opts.target          upstream URL
 * @param {string|null} opts.cookie  Cookie header value from the session jar
 * @param {string} opts.acceptEncoding encodings the proxy can decode
 * @param {string|null} opts.referer  rewritten Referer (upstream form) or null
 * @param {string|null} opts.origin   rewritten Origin (upstream form) or null
 * @param {string} opts.via          value for the Via header
 * @param {string|number|undefined} opts.contentLength content-length of the forwarded body, if known
 */
export function buildUpstreamRequestHeaders(clientHeaders, { target, cookie, acceptEncoding, referer, origin, via, contentLength }) {
  const out = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (REQUEST_DROP.has(lower)) continue;
    if (REQUEST_DROP_PREFIXES.some((p) => lower.startsWith(p))) continue;
    out[lower] = value;
  }
  out.host = target.host;
  out['accept-encoding'] = acceptEncoding;
  out.via = via;
  if (cookie) out.cookie = cookie;
  if (referer) out.referer = referer;
  if (origin) out.origin = origin;
  if (contentLength !== undefined) out['content-length'] = String(contentLength);
  return out;
}

/**
 * @param {import('node:http').IncomingHttpHeaders} upstreamHeaders
 * @param {object} opts
 * @param {boolean} opts.bodyModified true when the body is decoded/rewritten (byte metadata is dropped)
 * @returns {Record<string, string|string[]>}
 */
export function filterUpstreamResponseHeaders(upstreamHeaders, { bodyModified }) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (RESPONSE_DROP.has(lower)) continue;
    if (bodyModified && BODY_METADATA.has(lower)) continue;
    // Location / Content-Location / Refresh are rewritten by the caller.
    if (lower === 'location' || lower === 'content-location' || lower === 'refresh') continue;
    out[lower] = value;
  }
  return out;
}

export const RESPONSE_HEADER_DROP_LIST = [...RESPONSE_DROP];
export const REQUEST_HEADER_DROP_LIST = [...REQUEST_DROP];
