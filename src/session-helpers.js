/**
 * Glue between signed cookies and the in-memory session store.
 */
import { ADMIN_COOKIE, SESSION_COOKIE } from './sessions.js';

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('./sessions.js').SessionStore} store
 * @param {string} [cookieName]
 */
export function readSession(request, store, cookieName = SESSION_COOKIE) {
  const raw = request.cookies?.[cookieName];
  if (!raw) return null;
  const { valid, value } = request.unsignCookie(raw);
  if (!valid || !value) return null;
  return store.get(value);
}

/** The admin session for this request, or null when not signed in. */
export function readAdminSession(request, store) {
  const session = readSession(request, store, ADMIN_COOKIE);
  return session?.admin ? session : null;
}

/** Session cookie attributes. `Secure` follows the (proxy-aware) request protocol. */
export function sessionCookieOptions(request, config, { strict = false } = {}) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: strict ? 'strict' : 'lax',
    secure: request.protocol === 'https',
    signed: true,
    maxAge: Math.floor(config.sessionTtlMs / 1000)
  };
}

export function setSessionCookie(reply, request, config, session, cookieName = SESSION_COOKIE) {
  reply.setCookie(cookieName, session.id, sessionCookieOptions(request, config, { strict: cookieName === ADMIN_COOKIE }));
}

export function clearSessionCookie(reply, request, config, cookieName) {
  const opts = sessionCookieOptions(request, config, { strict: cookieName === ADMIN_COOKIE });
  delete opts.maxAge;
  delete opts.signed;
  reply.clearCookie(cookieName, opts);
}
