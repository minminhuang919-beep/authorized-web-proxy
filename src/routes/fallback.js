/**
 * Referer-based fallback.
 *
 * Root-relative URLs that page scripts build at runtime (`fetch('/api/x')`,
 * `img.src = '/img/a.png'`) may escape the client-side shim and hit the proxy
 * origin directly. When such a request carries a Referer that points at a
 * proxied page, it is redirected back into that page's proxy namespace.
 */
import { splitProxyPath } from '../security/target.js';

/** Paths that belong to the proxy application itself. */
const RESERVED = ['/p/', '/_/', '/admin', '/health', '/open', '/favicon.ico'];

export function isReservedPath(path) {
  if (path === '/') return true;
  return RESERVED.some((p) => path === p || path === p.replace(/\/$/, '') || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * Parse the Referer header and return it only when it points at this proxy's
 * own host (default ports normalised away on both sides).
 * @param {import('fastify').FastifyRequest} request
 * @returns {URL|null}
 */
export function ownReferer(request) {
  const referer = request.headers.referer;
  if (!referer || typeof referer !== 'string') return null;
  let url;
  let self;
  try {
    url = new URL(referer);
    self = new URL(`${request.protocol}://${request.headers.host || ''}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== self.hostname.toLowerCase()) return null;
  if (url.port !== self.port) return null;
  return url;
}

/**
 * Derive the proxied site the Referer points at, if any.
 * @param {import('fastify').FastifyRequest} request
 * @returns {{ scheme: string, host: string }|null}
 */
export function refererProxyContext(request) {
  const url = ownReferer(request);
  if (!url) return null;
  const parts = splitProxyPath(url.pathname);
  if (!parts) return null;
  return { scheme: parts.scheme, host: parts.host.toLowerCase() };
}

/**
 * Try the fallback redirect. Returns true when a redirect was sent.
 */
export function tryRefererFallback(request, reply) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const rawUrl = request.raw.url || '';
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) return false;
  const ctx = refererProxyContext(request);
  if (!ctx) return false;
  const path = rawUrl.split('?')[0];
  if (isReservedPath(path) && !path.startsWith('/p/')) return false;
  reply.header('cache-control', 'no-store');
  reply.redirect(`/p/${ctx.scheme}/${ctx.host}${rawUrl}`, 302);
  return true;
}
