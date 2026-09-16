/**
 * Protected administration area: manage the allowlist and view status.
 * Everything under /admin except the login page requires an admin session.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyFormbody from '@fastify/formbody';
import { ADMIN_COOKIE } from '../sessions.js';
import { clearSessionCookie, readSession, setSessionCookie } from '../session-helpers.js';
import { loginPage } from '../views/admin/login.js';
import { dashboardPage } from '../views/admin/dashboard.js';
import { ProxyError } from '../errors.js';

/** Constant-time comparison of two strings of arbitrary length. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

export default async function adminRoutes(app) {
  const { config, sessions, allowlist } = app;

  if (!config.admin.enabled) {
    // Admin disabled: behave as if the area does not exist.
    app.all('/*', async (_request, reply) => reply.code(404).send());
    app.all('/', async (_request, reply) => reply.code(404).send());
    return;
  }

  await app.register(fastifyFormbody, { bodyLimit: 16 * 1024 });
  app.decorateRequest('adminSession', null);

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const adminSession = (request) => {
    const session = readSession(request, sessions, ADMIN_COOKIE);
    return session?.admin ? session : null;
  };

  const requireAdmin = async (request, reply) => {
    const session = adminSession(request);
    if (!session) return reply.redirect('/admin/login', 302);
    request.adminSession = session;
  };

  const requireCsrf = async (request) => {
    const token = request.body?._csrf;
    if (typeof token !== 'string' || !safeEqual(token, request.adminSession.csrfToken)) {
      throw new ProxyError('CSRF', 403, 'The form token was missing or invalid. Please reload the page and try again.');
    }
  };

  const loginRateLimit = { max: config.adminRateLimit, timeWindow: config.rateLimitWindowMs };

  app.get('/login', { config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    if (adminSession(request)) return reply.redirect('/admin', 302);
    return reply.type('text/html; charset=utf-8').send(loginPage());
  });

  app.post(
    '/login',
    {
      config: { rateLimit: loginRateLimit },
      schema: {
        body: {
          type: 'object',
          properties: { username: { type: 'string', maxLength: 256 }, password: { type: 'string', maxLength: 1024 } }
        }
      }
    },
    async (request, reply) => {
      const { username = '', password = '' } = request.body || {};
      const userOk = safeEqual(username, config.admin.username);
      const passOk = safeEqual(password, config.admin.password);
      if (!(userOk && passOk)) {
        request.log.warn({ ip: request.ip }, 'admin login failed');
        return reply.code(401).type('text/html; charset=utf-8').send(loginPage({ error: 'Invalid username or password.' }));
      }
      const session = sessions.create();
      session.admin = { username: config.admin.username, loginAt: Date.now() };
      setSessionCookie(reply, request, config, session, ADMIN_COOKIE);
      request.log.info({ ip: request.ip }, 'admin login succeeded');
      return reply.redirect('/admin', 303);
    }
  );

  app.post('/logout', { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    sessions.destroy(request.adminSession.id);
    clearSessionCookie(reply, request, config, ADMIN_COOKIE);
    return reply.redirect('/admin/login', 303);
  });

  const renderDashboard = (request, reply, { notice = '', error = '' } = {}) => {
    const session = request.adminSession;
    const flash = session.flash || {};
    session.flash = null;
    return reply.type('text/html; charset=utf-8').send(
      dashboardPage({
        domains: allowlist.list(),
        health: app.healthSnapshot(),
        csrfToken: session.csrfToken,
        ephemeral: !allowlist.filePath,
        notice: notice || flash.notice || '',
        error: error || flash.error || ''
      })
    );
  };

  app.get('/', { preHandler: requireAdmin }, async (request, reply) => renderDashboard(request, reply));

  app.post(
    '/domains',
    {
      preHandler: [requireAdmin, requireCsrf],
      schema: { body: { type: 'object', properties: { domain: { type: 'string', maxLength: 260 } } } }
    },
    async (request, reply) => {
      const result = await allowlist.add(request.body?.domain || '');
      if (result.ok) {
        request.log.info({ pattern: result.pattern }, 'allowlist entry added');
        request.adminSession.flash = { notice: `Added ${result.pattern} to the allowlist.` };
      } else {
        request.adminSession.flash = { error: result.error };
      }
      return reply.redirect('/admin', 303);
    }
  );

  app.post(
    '/domains/remove',
    {
      preHandler: [requireAdmin, requireCsrf],
      schema: { body: { type: 'object', properties: { domain: { type: 'string', maxLength: 260 } } } }
    },
    async (request, reply) => {
      const result = await allowlist.remove(request.body?.domain || '');
      if (result.ok) {
        request.log.info({ pattern: result.pattern }, 'allowlist entry removed');
        request.adminSession.flash = { notice: `Removed ${result.pattern} from the allowlist.` };
      } else {
        request.adminSession.flash = { error: result.error };
      }
      return reply.redirect('/admin', 303);
    }
  );
}
