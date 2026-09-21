/**
 * The proxy's own pages: homepage, /search, /open, /suggest, /about, /health,
 * static assets and the admin area. Registered as an encapsulated plugin so
 * that Helmet's security headers apply here but not to proxied responses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { toProxyPath } from '../security/target.js';
import { ProxyError } from '../errors.js';
import { resolveInput } from '../resolve.js';
import { MAX_PAGE, annotateResults } from '../search/index.js';
import { readAdminSession } from '../session-helpers.js';
import { homePage } from '../views/home.js';
import { aboutPage } from '../views/about.js';
import { searchPage } from '../views/search.js';
import adminRoutes from './admin.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export default async function siteRoutes(app) {
  const { config, allowlist, policy, sessions, sites, search } = app;

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"]
      }
    },
    referrerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    hsts: false // added by app.js for HTTPS requests
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/_/',
    decorateReply: false,
    maxAge: '1h',
    immutable: false,
    index: false,
    list: false,
    dotfiles: 'ignore'
  });

  app.get('/favicon.ico', async (_request, reply) => reply.redirect('/_/favicon.svg', 302));

  const proxyRateLimit = { max: config.rateLimit, timeWindow: config.rateLimitWindowMs };
  const searchRateLimit = { max: config.search.rateLimit, timeWindow: config.rateLimitWindowMs };
  const isAdmin = (request) => config.admin.enabled && Boolean(readAdminSession(request, sessions));

  const pageModel = (request) => ({
    adminLoggedIn: isAdmin(request),
    quickLinks: sites.featured(8),
    searchEnabled: search.enabled,
    // Nothing is authorized yet: the pages say so instead of silently
    // refusing every destination (PROXY_ALLOWED_DOMAINS is unset).
    scopeConfigured: allowlist.size > 0
  });

  function renderHome(request, reply, { error = '', value = '', status = 200 } = {}) {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(homePage({ ...pageModel(request), error, value }));
  }

  app.get('/', { config: { rateLimit: proxyRateLimit } }, async (request, reply) => renderHome(request, reply));

  app.get('/about', { config: { rateLimit: proxyRateLimit } }, async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(
      aboutPage({
        scope: allowlist.patterns(),
        showScope: config.showAllowlist,
        shortcuts: sites.featured(50),
        searchEnabled: search.enabled,
        searchLabel: search.label,
        adminLoggedIn: isAdmin(request)
      })
    )
  );

  /**
   * Shared handler for the search box and /open. Resolves the input
   * (shortcut → explicit URL → domain-like → query); shortcuts and addresses
   * go through authorized scope → blacklist and are redirected into the
   * proxy (SSRF address checks run when the proxy route connects upstream);
   * queries get the results page. With `openOnly` a query is not an option.
   */
  async function dispatch(request, reply, input, { page = 1, forceSearch = false, openOnly = false } = {}) {
    let resolved;
    try {
      resolved = resolveInput(input, { sites, policy, maxLength: config.maxUrlLength, forceSearch, openOnly });
    } catch (err) {
      if (err instanceof ProxyError) {
        if (err.code === 'DOMAIN_BLACKLISTED' || err.code === 'DOMAIN_NOT_ALLOWED') throw err; // full-page explanation
        return renderHome(request, reply, { error: err.message, value: input.slice(0, 512), status: err.status });
      }
      throw err;
    }
    reply.header('cache-control', 'no-store');
    if (resolved.kind === 'site') {
      request.log.info({ shortcut: resolved.entry.shortcut, host: resolved.target.hostname }, 'shortcut opened');
      return reply.redirect(toProxyPath(resolved.target), 302);
    }
    if (resolved.kind === 'url') return reply.redirect(toProxyPath(resolved.target), 302);
    return renderSearch(request, reply, resolved.query, page);
  }

  async function renderSearch(request, reply, query, page) {
    const model = { ...pageModel(request), query, page, provider: search.label, searchReason: search.reason || '' };
    const send = (status, extra) => reply.code(status).type('text/html; charset=utf-8').send(searchPage({ ...model, ...extra }));
    if (search.mode === 'redirect') return reply.redirect(toProxyPath(search.targetFor(query)), 302);
    if (!search.enabled) return send(200, { state: 'unconfigured' });
    try {
      const data = await search.search(query, { page });
      const results = annotateResults(data.results, { policy });
      return send(200, { state: results.length ? 'results' : 'empty', results, page: data.page, hasNext: data.hasNext, total: data.total, related: data.related });
    } catch (err) {
      if (!(err instanceof ProxyError)) throw err;
      request.log.warn({ code: err.code, reason: err.message }, 'search failed');
      return send(err.status, { state: 'error', message: err.message });
    }
  }

  const clampPage = (value) => {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
  };

  app.get(
    '/search',
    {
      config: { rateLimit: searchRateLimit },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: config.maxUrlLength },
            page: { type: 'string', maxLength: 4 },
            mode: { type: 'string', maxLength: 16 }
          }
        }
      }
    },
    async (request, reply) => {
      const q = typeof request.query.q === 'string' ? request.query.q : '';
      if (!q.trim()) return reply.redirect('/', 302);
      return dispatch(request, reply, q, { page: clampPage(request.query.page), forceSearch: request.query.mode === 'search' });
    }
  );

  // "Open this": a shortcut or an address — used by search-result links and
  // the About page, and the form target of older links. Never a search and
  // never a guessed domain: a bare word is an invalid address here.
  app.get(
    '/open',
    {
      config: { rateLimit: proxyRateLimit },
      schema: { querystring: { type: 'object', properties: { url: { type: 'string', maxLength: config.maxUrlLength } } } }
    },
    async (request, reply) => {
      const input = typeof request.query.url === 'string' ? request.query.url : '';
      return dispatch(request, reply, input, { openOnly: true });
    }
  );

  // Autocomplete for the search box: only administrator-configured, enabled
  // and currently usable shortcuts are ever exposed.
  app.get(
    '/suggest',
    {
      config: { rateLimit: proxyRateLimit },
      schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 100 } } } }
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
      return { query: q, sites: sites.suggest(q, 8), search: search.enabled };
    }
  );

  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return app.healthSnapshot();
  });

  await app.register(adminRoutes, { prefix: '/admin' });
}
