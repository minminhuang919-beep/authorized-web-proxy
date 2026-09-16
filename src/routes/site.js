/**
 * The proxy's own pages: homepage, /open, /health, static assets and admin.
 * Registered as an encapsulated plugin so that Helmet's security headers
 * apply here but not to proxied responses.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { parseUserUrl, toProxyPath } from '../security/target.js';
import { ProxyError } from '../errors.js';
import { homePage } from '../views/home.js';
import adminRoutes from './admin.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export default async function siteRoutes(app) {
  const { config, allowlist } = app;

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
    hsts: false // Caddy adds HSTS at the TLS edge
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

  function renderHome(reply, { error = '', value = '', status = 200 } = {}) {
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(homePage({ allowedPatterns: allowlist.patterns(), showAllowlist: config.showAllowlist, error, value }));
  }

  app.get('/', { config: { rateLimit: proxyRateLimit } }, async (_request, reply) => renderHome(reply));

  app.get(
    '/open',
    {
      config: { rateLimit: proxyRateLimit },
      schema: { querystring: { type: 'object', properties: { url: { type: 'string', maxLength: config.maxUrlLength } } } }
    },
    async (request, reply) => {
      const input = typeof request.query.url === 'string' ? request.query.url : '';
      try {
        const target = parseUserUrl(input, allowlist, { maxLength: config.maxUrlLength });
        reply.header('cache-control', 'no-store');
        return reply.redirect(toProxyPath(target), 302);
      } catch (err) {
        if (err instanceof ProxyError) {
          return renderHome(reply, { error: err.message, value: input.slice(0, 512), status: err.status });
        }
        throw err;
      }
    }
  );

  app.get('/health', { logLevel: 'warn' }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return app.healthSnapshot();
  });

  await app.register(adminRoutes, { prefix: '/admin' });
}
