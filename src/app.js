/**
 * Application factory. Tests build the app with injected dependencies
 * (fake DNS lookup, address policy, mock server ports); production uses the
 * defaults.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { Allowlist } from './allowlist.js';
import { AuditLog } from './audit.js';
import { Blacklist } from './blacklist.js';
import { ProxyError, TooManyRequestsError } from './errors.js';
import { createAccessPolicy } from './policy.js';
import { loggerOptions, safePath } from './logger.js';
import { createUrlRewriter } from './rewrite/url.js';
import { createSearchProvider } from './search/index.js';
import { SessionStore } from './sessions.js';
import { SiteDirectory } from './sites.js';
import { createUpstreamClient } from './upstream/client.js';
import { errorJson, errorPage } from './views/error.js';
import { tryRefererFallback } from './routes/fallback.js';
import proxyRoutes from './routes/proxy.js';
import siteRoutes from './routes/site.js';

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

/**
 * @param {object} opts
 * @param {ReturnType<import('./config.js').loadConfig>} opts.config
 * @param {object} [opts.deps]
 * @param {Function} [opts.deps.lookup] DNS lookup override
 * @param {(address: string) => boolean} [opts.deps.isAddressAllowed]
 * @param {{ http: number, https: number }} [opts.deps.defaultPorts]
 * @param {Allowlist} [opts.deps.allowlist]
 * @param {SiteDirectory} [opts.deps.sites]
 * @param {typeof fetch} [opts.deps.fetch] fetch used for search API providers (tests)
 * @param {object} [opts.deps.logger] Fastify logger option override
 */
export async function buildApp({ config, deps = {} }) {
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config),
    trustProxy: config.trustProxy,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: config.maxRequestSize,
    routerOptions: { maxParamLength: config.maxUrlLength },
    requestTimeout: 120_000,
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    return503OnClosing: true,
    forceCloseConnections: 'idle'
  });

  const allowlist =
    deps.allowlist ??
    (await new Allowlist({
      envDomains: config.allowedDomains,
      filePath: config.allowlistFile, // null → in-memory only (ephemeral hosts)
      logger: app.log
    }).load());

  const blacklist =
    deps.blacklist ??
    (await new Blacklist({
      envValue: config.blacklistEnv,
      filePath: config.blacklistFile, // null → in-memory only (ephemeral hosts)
      logger: app.log
    }).load());

  // Order of checks: authorized scope → blacklist → (later) SSRF address policy.
  const policy = createAccessPolicy({ allowlist, blacklist });
  const audit = new AuditLog({ max: 50 });

  // Shortcuts (site directory). Destinations are validated against the
  // policy on every use; entries that drifted out of it are only flagged here.
  const sites =
    deps.sites ??
    (await new SiteDirectory({
      envValue: config.sitesEnv,
      filePath: config.sitesFile, // null → in-memory only (ephemeral hosts)
      policy,
      logger: app.log
    }).load());
  for (const entry of sites.list()) {
    if (entry.status !== 'ok') app.log.warn({ shortcut: entry.shortcut, host: entry.host, status: entry.status }, 'site shortcut is not currently usable');
  }

  const search = createSearchProvider({ config, policy, logger: app.log, fetchImpl: deps.fetch });

  const sessions = new SessionStore({ ttlMs: config.sessionTtlMs, max: config.sessionMax });
  sessions.start();

  const upstream = createUpstreamClient({
    config,
    logger: app.log,
    lookup: deps.lookup,
    isAddressAllowed: deps.isAddressAllowed,
    defaultPorts: deps.defaultPorts
  });

  const urlRewriter = createUrlRewriter({ allowlist, mode: config.unlistedUrlMode });
  const startedAt = Date.now();

  app.decorate('config', config);
  app.decorate('allowlist', allowlist);
  app.decorate('blacklist', blacklist);
  app.decorate('policy', policy);
  app.decorate('sites', sites);
  app.decorate('search', search);
  app.decorate('audit', audit);
  app.decorate('sessions', sessions);
  app.decorate('upstream', upstream);
  app.decorate('urlRewriter', urlRewriter);
  app.decorate('appVersion', pkg.version);
  app.decorate('healthSnapshot', () => {
    const mem = process.memoryUsage();
    return {
      status: 'ok',
      version: pkg.version,
      // Which build is actually live: Render injects RENDER_GIT_COMMIT into
      // every deploy, so `/health` answers "did my push reach production?"
      // without reading the dashboard. Null anywhere else.
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      // `configured`: an administrator has defined an authorized scope — with
      // none, the proxy runs but opens nothing (see PROXY_ALLOWED_DOMAINS).
      allowlist: { size: allowlist.size, persistent: Boolean(allowlist.filePath), configured: allowlist.size > 0 },
      blacklist: { size: blacklist.size, persistent: blacklist.persistent },
      sites: { size: sites.size, enabled: sites.enabledCount, persistent: sites.persistent },
      search: { provider: search.kind, enabled: search.enabled, configured: search.configured !== false },
      sessions: sessions.stats(),
      upstream: { ...upstream.stats },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal }
    };
  });

  await app.register(fastifyCookie, { secret: config.sessionSecret, hook: 'onRequest' });
  await app.register(fastifyRateLimit, {
    global: false,
    keyGenerator: (request) => clientIp(request, config),
    errorResponseBuilder: () => new TooManyRequestsError()
  });

  // Behind a TLS-terminating edge (Render, Caddy) tell browsers to stick to
  // HTTPS. Upstream HSTS headers are stripped, so this is the only one sent.
  app.addHook('onSend', async (request, reply) => {
    if (request.protocol === 'https' && !reply.hasHeader('strict-transport-security')) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(
    { preHandler: app.rateLimit({ max: config.rateLimit, timeWindow: config.rateLimitWindowMs }) },
    async (request, reply) => {
      if (tryRefererFallback(request, reply)) return reply;
      return sendError(request, reply, { status: 404, code: 'NOT_FOUND', message: 'There is nothing at this address.' });
    }
  );

  await app.register(siteRoutes);
  await app.register(proxyRoutes);

  app.addHook('onResponse', async (request, reply) => {
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    if (request.routeOptions?.logLevel === 'warn' && reply.statusCode < 400) return; // /health noise
    request.log[level](
      { method: request.method, path: safePath(request.url), status: reply.statusCode, ms: Math.round(reply.elapsedTime), ip: clientIp(request, config) },
      'request'
    );
  });

  app.addHook('onClose', async () => {
    sessions.stop();
    upstream.close();
  });

  return app;
}

/**
 * Best available client address: a trusted edge header when configured
 * (e.g. true-client-ip on Render), otherwise Fastify's proxy-aware request.ip.
 */
export function clientIp(request, config) {
  if (config.clientIpHeader) {
    const value = request.headers[config.clientIpHeader];
    if (typeof value === 'string' && value.trim()) return value.split(',')[0].trim();
  }
  return request.ip;
}

function wantsJson(request) {
  const accept = String(request.headers.accept || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

function sendError(request, reply, { status, code, message, extra = {} }) {
  // Drop headers copied from an upstream response before the failure.
  for (const name of Object.keys(reply.getHeaders())) {
    if (name === 'set-cookie' || name.startsWith('x-ratelimit') || name === 'retry-after') continue;
    reply.removeHeader(name);
  }
  reply.code(status).header('cache-control', 'no-store');
  const payload = { status, code, message, extra, requestId: request.id };
  if (wantsJson(request)) return reply.type('application/json; charset=utf-8').send(errorJson(payload));
  return reply.type('text/html; charset=utf-8').send(errorPage(payload));
}

function errorHandler(err, request, reply) {
  if (reply.raw.headersSent) {
    request.log.warn({ code: err.code, err: err.message }, 'error after headers were sent');
    reply.raw.destroy();
    return;
  }
  let status = 500;
  let code = 'INTERNAL';
  let message = 'An unexpected error occurred. Please try again later.';
  let extra = {};

  if (err instanceof ProxyError) {
    ({ status, code, message, extra } = err);
    if (status >= 500) request.log.warn({ code, reason: err.message, path: safePath(request.url) }, 'upstream failure');
  } else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
    status = 413;
    code = 'REQUEST_TOO_LARGE';
    message = 'The request body is larger than this proxy allows.';
  } else if (err.statusCode === 429) {
    status = 429;
    code = 'RATE_LIMITED';
    message = 'Too many requests. Please slow down and try again shortly.';
  } else if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'The request could not be understood.';
  } else if (err.statusCode === 404) {
    status = 404;
    code = 'NOT_FOUND';
    message = 'There is nothing at this address.';
  } else {
    // Unknown error: log the details, never show them.
    request.log.error({ err }, 'unhandled error');
  }
  return sendError(request, reply, { status, code, message, extra });
}
