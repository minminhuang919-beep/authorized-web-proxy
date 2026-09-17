/**
 * Protected administration area.
 *
 *   GET  /admin                      dashboard
 *   GET  /admin/blacklist            blacklist page (HTML) or JSON with Accept: application/json
 *   POST /admin/blacklist            add an entry (form or JSON)
 *   DELETE /admin/blacklist/:id      remove an entry (JSON API, x-csrf-token header)
 *   POST /admin/blacklist/:id/delete remove an entry (HTML form fallback)
 *   GET  /admin/sites                site directory (HTML) or JSON with Accept: application/json
 *   POST /admin/sites                add a shortcut (form or JSON)
 *   GET  /admin/sites/:id/edit       edit page
 *   POST /admin/sites/:id            update (HTML form); PUT/PATCH = JSON API
 *   POST /admin/sites/:id/toggle     enable/disable (HTML form)
 *   DELETE /admin/sites/:id          remove (JSON API); POST /admin/sites/:id/delete = HTML form
 *   GET  /admin/settings             authorized scope + configuration
 *   POST /admin/domains, /admin/domains/remove   authorized scope changes
 *   GET/POST /admin/login, POST /admin/logout
 *
 * Every state change requires an admin session (signed, HttpOnly,
 * SameSite=Strict cookie) *and* a CSRF token bound to that session.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyFormbody from '@fastify/formbody';
import { ADMIN_COOKIE } from '../sessions.js';
import { clearSessionCookie, readAdminSession, setSessionCookie } from '../session-helpers.js';
import { verifyPassword } from '../security/password.js';
import { loginPage } from '../views/admin/login.js';
import { dashboardPage } from '../views/admin/dashboard.js';
import { blacklistPage } from '../views/admin/blacklist.js';
import { settingsPage } from '../views/admin/settings.js';
import { siteEditPage, sitesPage } from '../views/admin/sites.js';
import { ProxyError } from '../errors.js';

/** Constant-time comparison of two strings of arbitrary length. */
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

function wantsJson(request) {
  const accept = String(request.headers.accept || '');
  const ct = String(request.headers['content-type'] || '');
  return request.query?.format === 'json' || (accept.includes('application/json') && !accept.includes('text/html')) || ct.includes('application/json');
}

/** Human-readable search configuration for the Settings page — never the API key. */
function searchSummary(search) {
  if (search.provider === 'none') return 'not configured';
  const parts = [search.provider];
  if (search.url) parts.push(search.provider === 'proxy' ? search.url : new URL(search.url).host);
  if (search.apiKey) parts.push('API key set');
  if (search.engineId) parts.push(`engine ${search.engineId}`);
  return parts.join(' · ');
}

export default async function adminRoutes(app) {
  const { config, sessions, allowlist, blacklist, sites, audit } = app;

  if (!config.admin.enabled) {
    // Admin disabled: behave as if the area does not exist.
    app.all('/*', async (_request, reply) => reply.code(404).send());
    app.all('/', async (_request, reply) => reply.code(404).send());
    return;
  }

  await app.register(fastifyFormbody, { bodyLimit: 16 * 1024 });
  app.decorateRequest('adminSession', null);

  // JSON bodies (API clients). An empty body with a JSON content type — e.g.
  // a DELETE sent by a generic HTTP client — is treated as `{}`.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 16 * 1024 }, (request, body, done) => {
    if (body === undefined || body === '') return done(null, {});
    parseJson(request, body, done);
  });

  const generalRateLimit = { max: config.rateLimit, timeWindow: config.rateLimitWindowMs };
  const loginRateLimit = { max: config.adminRateLimit, timeWindow: config.rateLimitWindowMs };

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // ---- authentication / authorization ---------------------------------------
  const requireAdmin = async (request, reply) => {
    const session = readAdminSession(request, sessions);
    if (!session) {
      if (wantsJson(request)) {
        return reply.code(401).send({ error: { status: 401, code: 'UNAUTHENTICATED', message: 'Administrator sign-in required.' } });
      }
      return reply.redirect('/admin/login', 302);
    }
    request.adminSession = session;
  };

  const csrfError = () => new ProxyError('CSRF', 403, 'The form token was missing or invalid. Please reload the page and try again.');

  /** Form posts carry `_csrf`; JSON API calls carry an `x-csrf-token` header. */
  const requireCsrf = async (request, reply) => {
    const token = request.body && typeof request.body === 'object' ? request.body._csrf : undefined;
    const header = request.headers['x-csrf-token'];
    const candidate = typeof token === 'string' ? token : typeof header === 'string' ? header : '';
    if (!candidate || !safeEqual(candidate, request.adminSession.csrfToken)) {
      if (wantsJson(request)) {
        return reply.code(403).send({ error: { status: 403, code: 'CSRF', message: 'Missing or invalid CSRF token.' } });
      }
      throw csrfError();
    }
  };

  const flash = (session, values) => {
    session.flash = values;
  };
  const takeFlash = (session) => {
    const f = session.flash || {};
    session.flash = null;
    return f;
  };

  // ---- login / logout ----------------------------------------------------------
  app.get('/login', { config: { rateLimit: loginRateLimit } }, async (request, reply) => {
    if (readAdminSession(request, sessions)) return reply.redirect('/admin', 302);
    return reply.type('text/html; charset=utf-8').send(loginPage());
  });

  app.post(
    '/login',
    {
      config: { rateLimit: loginRateLimit },
      schema: {
        body: { type: 'object', properties: { username: { type: 'string', maxLength: 256 }, password: { type: 'string', maxLength: 1024 } } }
      }
    },
    async (request, reply) => {
      const { username = '', password = '' } = request.body || {};
      const userOk = safeEqual(username, config.admin.username);
      const passOk = verifyPassword(password, config.admin.passwordHash);
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

  // ---- dashboard ---------------------------------------------------------------
  app.get('/', { preHandler: requireAdmin, config: { rateLimit: generalRateLimit } }, async (request, reply) => {
    const session = request.adminSession;
    const { notice = '', error = '' } = takeFlash(session);
    return reply.type('text/html; charset=utf-8').send(
      dashboardPage({ health: app.healthSnapshot(), changes: audit.recent(10), csrfToken: session.csrfToken, notice, error })
    );
  });

  // ---- blacklist -----------------------------------------------------------------
  const renderBlacklist = (request, reply, { q = '', form = {}, notice = '', error = '', status = 200 } = {}) => {
    const session = request.adminSession;
    const f = takeFlash(session);
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(
        blacklistPage({
          entries: blacklist.list({ q }),
          total: blacklist.size,
          q,
          persistent: blacklist.persistent,
          exportValue: blacklist.exportEnvValue(),
          csrfToken: session.csrfToken,
          form,
          notice: notice || f.notice || '',
          error: error || f.error || ''
        })
      );
  };

  app.get(
    '/blacklist',
    {
      preHandler: requireAdmin,
      config: { rateLimit: generalRateLimit },
      schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 }, format: { type: 'string', maxLength: 10 } } } }
    },
    async (request, reply) => {
      const q = typeof request.query.q === 'string' ? request.query.q : '';
      if (wantsJson(request)) {
        return { entries: blacklist.list({ q }), total: blacklist.size, persistent: blacklist.persistent };
      }
      return renderBlacklist(request, reply, { q });
    }
  );

  app.post(
    '/blacklist',
    {
      preHandler: [requireAdmin, requireCsrf],
      config: { rateLimit: generalRateLimit },
      schema: {
        body: {
          type: 'object',
          properties: { domain: { type: 'string', maxLength: 300 }, reason: { type: 'string', maxLength: 300 }, _csrf: { type: 'string', maxLength: 200 } }
        }
      }
    },
    async (request, reply) => {
      const { domain = '', reason = '' } = request.body || {};
      const result = await blacklist.add({ domain, reason });
      const json = wantsJson(request);
      if (!result.ok) {
        if (json) return reply.code(result.status).send({ error: { status: result.status, code: result.status === 409 ? 'DUPLICATE' : 'INVALID_DOMAIN', message: result.error } });
        return renderBlacklist(request, reply, { error: result.error, form: { domain, reason }, status: result.status });
      }
      audit.record({ action: 'blacklist.add', target: result.entry.domain, detail: result.entry.reason, actor: request.adminSession.admin.username });
      request.log.info({ domain: result.entry.domain }, 'blacklist entry added');
      if (json) return reply.code(201).send({ entry: result.entry });
      flash(request.adminSession, { notice: `${result.entry.domain} is now blacklisted (including its subdomains).` });
      return reply.redirect('/admin/blacklist', 303);
    }
  );

  const idSchema = { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{16}$' } }, required: ['id'] };

  const removeEntry = async (request) => {
    const result = await blacklist.remove(request.params.id);
    if (result.ok) {
      audit.record({ action: 'blacklist.remove', target: result.entry.domain, actor: request.adminSession.admin.username });
      request.log.info({ domain: result.entry.domain }, 'blacklist entry removed');
    }
    return result;
  };

  app.delete('/blacklist/:id', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: idSchema } }, async (request, reply) => {
    const result = await removeEntry(request);
    if (!result.ok) return reply.code(result.status).send({ error: { status: result.status, code: result.status === 404 ? 'NOT_FOUND' : 'LOCKED', message: result.error } });
    return { ok: true, entry: result.entry };
  });

  app.post('/blacklist/:id/delete', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: idSchema } }, async (request, reply) => {
    const result = await removeEntry(request);
    flash(request.adminSession, result.ok ? { notice: `${result.entry.domain} was removed from the blacklist.` } : { error: result.error });
    return reply.redirect('/admin/blacklist', 303);
  });

  // ---- site directory (shortcuts) -------------------------------------------------
  const siteFieldsSchema = {
    name: { type: 'string', maxLength: 200 },
    shortcut: { type: 'string', maxLength: 100 },
    destination: { type: 'string', maxLength: 2100 },
    description: { type: 'string', maxLength: 300 },
    enabled: {}, // "on" / "1" / true / false — normalised by siteFields()
    _csrf: { type: 'string', maxLength: 200 }
  };
  const siteBodySchema = { type: 'object', properties: siteFieldsSchema };
  const siteIdSchema = { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{16}$' } }, required: ['id'] };
  const siteErrorCode = (result) => (result.status === 409 ? 'DUPLICATE' : result.status === 404 ? 'NOT_FOUND' : result.status === 403 ? 'LOCKED' : result.code || 'INVALID');
  const siteError = (reply, result) => reply.code(result.status).send({ error: { status: result.status, code: siteErrorCode(result), message: result.error } });

  /** Only the fields present in the body (PATCH semantics); HTML checkboxes are absent when unchecked. */
  const siteFields = (body, { checkbox = false } = {}) => {
    const src = body && typeof body === 'object' ? body : {};
    const out = {};
    for (const key of ['name', 'shortcut', 'destination', 'description']) {
      if (typeof src[key] === 'string') out[key] = src[key];
    }
    if (checkbox) out.enabled = src.enabled !== undefined && src.enabled !== '' && src.enabled !== '0' && src.enabled !== 'false' && src.enabled !== false;
    else if (src.enabled !== undefined && src.enabled !== null) out.enabled = src.enabled;
    return out;
  };

  const renderSites = (request, reply, { q = '', form = {}, notice = '', error = '', status = 200 } = {}) => {
    const session = request.adminSession;
    const f = takeFlash(session);
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(
        sitesPage({
          entries: sites.list({ q }),
          total: sites.size,
          enabled: sites.enabledCount,
          q,
          persistent: sites.persistent,
          exportValue: sites.exportEnvValue(),
          csrfToken: session.csrfToken,
          form,
          notice: notice || f.notice || '',
          error: error || f.error || ''
        })
      );
  };

  const recordSite = (request, action, entry, detail = '') => {
    audit.record({ action, target: entry.shortcut, detail: detail || entry.host, actor: request.adminSession.admin.username });
    request.log.info({ shortcut: entry.shortcut, host: entry.host }, action);
  };

  app.get(
    '/sites',
    {
      preHandler: requireAdmin,
      config: { rateLimit: generalRateLimit },
      schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 }, format: { type: 'string', maxLength: 10 } } } }
    },
    async (request, reply) => {
      const q = typeof request.query.q === 'string' ? request.query.q : '';
      if (wantsJson(request)) {
        return { entries: sites.list({ q }), total: sites.size, enabled: sites.enabledCount, persistent: sites.persistent };
      }
      return renderSites(request, reply, { q });
    }
  );

  app.post('/sites', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { body: siteBodySchema } }, async (request, reply) => {
    const json = wantsJson(request);
    const fields = siteFields(request.body, { checkbox: !json });
    const result = await sites.add(fields);
    if (!result.ok) {
      if (json) return siteError(reply, result);
      return renderSites(request, reply, { error: result.error, form: fields, status: result.status });
    }
    recordSite(request, 'site.add', result.entry);
    if (json) return reply.code(201).send({ entry: result.entry });
    flash(request.adminSession, { notice: `Shortcut "${result.entry.shortcut}" now opens ${result.entry.host}.` });
    return reply.redirect('/admin/sites', 303);
  });

  const renderSiteEdit = (request, reply, entry, { form = null, error = '', status = 200 } = {}) =>
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(siteEditPage({ entry, csrfToken: request.adminSession.csrfToken, form, error }));

  app.get('/sites/:id/edit', { preHandler: requireAdmin, config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema } }, async (request, reply) => {
    const entry = sites.getById(request.params.id);
    if (!entry || entry.source === 'env') {
      flash(request.adminSession, { error: entry ? `"${entry.shortcut}" comes from PROXY_SITES and can only be changed by editing the environment.` : 'That shortcut does not exist.' });
      return reply.redirect('/admin/sites', 303);
    }
    return renderSiteEdit(request, reply, entry);
  });

  app.post('/sites/:id', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema, body: siteBodySchema } }, async (request, reply) => {
    const entry = sites.getById(request.params.id);
    const fields = siteFields(request.body, { checkbox: true });
    const result = await sites.update(request.params.id, fields);
    if (!result.ok) {
      if (!entry || result.status === 403) {
        flash(request.adminSession, { error: result.error });
        return reply.redirect('/admin/sites', 303);
      }
      return renderSiteEdit(request, reply, entry, { form: fields, error: result.error, status: result.status });
    }
    recordSite(request, 'site.update', result.entry);
    flash(request.adminSession, { notice: `Shortcut "${result.entry.shortcut}" was updated.` });
    return reply.redirect('/admin/sites', 303);
  });

  const updateSiteJson = async (request, reply) => {
    const result = await sites.update(request.params.id, siteFields(request.body));
    if (!result.ok) return siteError(reply, result);
    recordSite(request, 'site.update', result.entry);
    return { entry: result.entry };
  };
  app.put('/sites/:id', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema, body: siteBodySchema } }, updateSiteJson);
  app.patch('/sites/:id', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema, body: siteBodySchema } }, updateSiteJson);

  app.post(
    '/sites/:id/toggle',
    { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema, body: siteBodySchema } },
    async (request, reply) => {
      const enabled = ['1', 'true', 'on'].includes(String(request.body?.enabled ?? '').toLowerCase());
      const result = await sites.setEnabled(request.params.id, enabled);
      if (result.ok) {
        recordSite(request, enabled ? 'site.enable' : 'site.disable', result.entry);
        flash(request.adminSession, { notice: `Shortcut "${result.entry.shortcut}" is now ${enabled ? 'enabled' : 'disabled'}.` });
      } else {
        flash(request.adminSession, { error: result.error });
      }
      return reply.redirect('/admin/sites', 303);
    }
  );

  const removeSite = async (request) => {
    const result = await sites.remove(request.params.id);
    if (result.ok) recordSite(request, 'site.remove', result.entry);
    return result;
  };

  app.delete('/sites/:id', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema } }, async (request, reply) => {
    const result = await removeSite(request);
    if (!result.ok) return siteError(reply, result);
    return { ok: true, entry: result.entry };
  });

  app.post('/sites/:id/delete', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: { params: siteIdSchema } }, async (request, reply) => {
    const result = await removeSite(request);
    flash(request.adminSession, result.ok ? { notice: `Shortcut "${result.entry.shortcut}" was deleted.` } : { error: result.error });
    return reply.redirect('/admin/sites', 303);
  });

  // ---- settings: authorized scope + configuration -----------------------------------
  const settingsRows = () => [
    { label: 'Authorized scope (environment)', value: config.allowedDomains.join(', ') || '—', env: 'PROXY_ALLOWED_DOMAINS' },
    { label: 'Blacklist (environment)', value: config.blacklistEnv || '—', env: 'PROXY_BLACKLIST' },
    { label: 'Site shortcuts (environment)', value: config.sitesEnv || '—', env: 'PROXY_SITES' },
    { label: 'Web search', value: searchSummary(config.search), env: 'SEARCH_PROVIDER' },
    { label: 'Admin data storage', value: config.adminStorage === 'file' ? 'file (data directory)' : 'memory (ephemeral)', env: 'ADMIN_STORAGE' },
    { label: 'Links to unlisted domains', value: config.unlistedUrlMode === 'proxy' ? 'routed through the proxy (blocked)' : 'left direct', env: 'PROXY_UNLISTED_URL_MODE' },
    { label: 'Rate limit', value: `${config.rateLimit} requests / ${config.rateLimitWindowMs / 1000}s per client`, env: 'RATE_LIMIT' },
    { label: 'Max response size', value: `${Math.round(config.maxResponseSize / 1048576)} MB`, env: 'MAX_RESPONSE_SIZE' },
    { label: 'Max request size', value: `${Math.round(config.maxRequestSize / 1048576)} MB`, env: 'MAX_REQUEST_SIZE' },
    { label: 'Timeouts', value: `connect ${config.connectTimeoutMs / 1000}s · headers/idle ${config.requestTimeoutMs / 1000}s · transfer ${config.transferTimeoutMs / 1000}s`, env: 'REQUEST_TIMEOUT' },
    { label: 'Concurrent upstream requests', value: String(config.maxConcurrentUpstream), env: 'MAX_CONCURRENT_UPSTREAM' },
    { label: 'Session lifetime', value: `${config.sessionTtlMs / 60000} min idle`, env: 'SESSION_TTL' },
    { label: 'Trusted proxy', value: String(config.trustProxy) + (config.clientIpHeader ? ` · client IP from ${config.clientIpHeader}` : ''), env: 'TRUST_PROXY' },
    { label: 'Admin password', value: 'stored as scrypt hash', env: 'ADMIN_PASSWORD_HASH' }
  ];

  const renderSettings = (request, reply) => {
    const session = request.adminSession;
    const { notice = '', error = '' } = takeFlash(session);
    return reply.type('text/html; charset=utf-8').send(
      settingsPage({ scope: allowlist.list(), persistent: Boolean(allowlist.filePath), settings: settingsRows(), csrfToken: session.csrfToken, notice, error })
    );
  };

  app.get('/settings', { preHandler: requireAdmin, config: { rateLimit: generalRateLimit } }, async (request, reply) => renderSettings(request, reply));

  const domainSchema = { body: { type: 'object', properties: { domain: { type: 'string', maxLength: 260 }, _csrf: { type: 'string', maxLength: 200 } } } };

  app.post('/domains', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: domainSchema }, async (request, reply) => {
    const result = await allowlist.add(request.body?.domain || '');
    if (result.ok) {
      audit.record({ action: 'scope.add', target: result.pattern, actor: request.adminSession.admin.username });
      request.log.info({ pattern: result.pattern }, 'authorized scope entry added');
      flash(request.adminSession, { notice: `${result.pattern} was added to the authorized scope.` });
    } else {
      flash(request.adminSession, { error: result.error });
    }
    return reply.redirect('/admin/settings', 303);
  });

  app.post('/domains/remove', { preHandler: [requireAdmin, requireCsrf], config: { rateLimit: generalRateLimit }, schema: domainSchema }, async (request, reply) => {
    const result = await allowlist.remove(request.body?.domain || '');
    if (result.ok) {
      audit.record({ action: 'scope.remove', target: result.pattern, actor: request.adminSession.admin.username });
      request.log.info({ pattern: result.pattern }, 'authorized scope entry removed');
      flash(request.adminSession, { notice: `${result.pattern} was removed from the authorized scope.` });
    } else {
      flash(request.adminSession, { error: result.error });
    }
    return reply.redirect('/admin/settings', 303);
  });
}
