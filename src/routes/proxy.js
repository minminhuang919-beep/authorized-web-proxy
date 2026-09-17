/**
 * The proxy endpoint: `/p/<scheme>/<host>/<path>`.
 *
 * Flow: validate target → build a sanitised upstream request (session cookie
 * jar, rewritten Referer/Origin) → fetch through the SSRF-safe client →
 * intercept Set-Cookie into the jar → re-validate redirects → filter response
 * headers → stream the body back, decoding and rewriting HTML/CSS on the fly.
 */
import { pipeline } from 'node:stream';
import { DomainBlockedError, DomainNotAllowedError, InvalidUrlError, ProxyError, RequestTooLargeError } from '../errors.js';
import { splitProxyPath, targetFromProxyPath, toProxyPath, validateTarget } from '../security/target.js';
import { ACCEPT_ENCODING, canDecode, clientAccepts, createDecoder, normalizeEncoding } from '../upstream/decompress.js';
import { buildUpstreamRequestHeaders, filterUpstreamResponseHeaders } from '../upstream/headers.js';
import { ByteLimit, collect } from '../upstream/limits.js';
import { DecodeStream, charsetFromContentType, decodeBuffer } from '../rewrite/charset.js';
import { rewriteCss } from '../rewrite/css.js';
import { createHtmlRewriter, safeJsonForScript } from '../rewrite/html.js';
import { readSession, setSessionCookie } from '../session-helpers.js';
import { esc } from '../views/layout.js';
import { ownReferer, tryRefererFallback } from './fallback.js';

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_STATUS = new Set([204, 205, 304]);
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export default async function proxyRoutes(app) {
  const { config, allowlist, policy, sessions, upstream, urlRewriter } = app;
  const via = `1.1 anonview/${app.appVersion}`;

  // Bodies are streamed through untouched, whatever their content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  const bannerHtml = (target) => {
    if (!config.banner) return '';
    const s = 'all:initial;font:inherit;color:#4cc2ff;cursor:pointer;text-decoration:underline;';
    return (
      `<div id="__pxy_banner" data-pxy-ignore="1" style="all:initial;position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px;padding:6px 12px;background:#0f1419;color:#e6edf3;font:13px/1.4 system-ui,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,.4)">` +
      `<span style="all:initial;font:inherit;color:inherit">Viewing <b style="all:initial;font:inherit;font-weight:700;color:#4cc2ff">${esc(target.hostname)}</b> through AnonView</span>` +
      `<a href="/" data-pxy-ignore="1" style="${s}">Home</a>` +
      `<a href="${esc(target.href)}" data-pxy-ignore="1" rel="noopener noreferrer" style="${s}">Leave proxy ↗</a>` +
      `<button type="button" onclick="this.parentNode.remove()" aria-label="Hide banner" style="all:initial;font:inherit;color:#9aa7b4;cursor:pointer;margin-left:8px">✕</button>` +
      `</div>`
    );
  };

  const headHtml = (target) => {
    const cfg = { pageUrl: target.href, prefix: '/p/', mode: config.unlistedUrlMode, allowed: allowlist.patterns() };
    return `<script>window.__PXY__=${safeJsonForScript(cfg)};</script><script src="/_/shim.js"></script>`;
  };

  /** Translate a proxied Referer back to its upstream form. */
  function upstreamReferer(request) {
    const url = ownReferer(request);
    if (!url) return null;
    const parts = splitProxyPath(url.pathname + url.search);
    if (!parts) return null;
    try {
      return new URL(`${parts.scheme}://${parts.host}${parts.rest}`).href;
    } catch {
      return null;
    }
  }

  app.route({
    method: METHODS,
    url: '/p/*',
    config: { rateLimit: { max: config.rateLimit, timeWindow: config.rateLimitWindowMs } },
    handler: async (request, reply) => {
      const rawUrl = request.raw.url || '';
      const parts = splitProxyPath(rawUrl);
      if (!parts) {
        // e.g. a site's own "/p/123" path requested root-relatively
        if (tryRefererFallback(request, reply)) return reply;
        throw new InvalidUrlError();
      }
      // Canonicalise `/p/https/host` → `/p/https/host/` so relative links resolve.
      const afterHost = rawUrl.slice(`/p/${parts.scheme}/`.length + parts.host.length);
      if (afterHost === '' || afterHost.startsWith('?')) {
        return reply.redirect(`/p/${parts.scheme}/${parts.host.toLowerCase()}/${afterHost}`, 302);
      }

      const { target } = targetFromProxyPath(rawUrl, policy, { maxLength: config.maxUrlLength });
      const method = request.method;

      let session = readSession(request, sessions);
      let cookieHeader = null;
      if (session) {
        try {
          cookieHeader = session.jar.getCookieStringSync(target.href) || null;
        } catch {
          cookieHeader = null;
        }
      }

      const referer = upstreamReferer(request);
      const origin = request.headers.origin !== undefined ? (referer ? new URL(referer).origin : target.origin) : null;

      // Request body (streamed, size-capped).
      let body = null;
      let contentLength;
      if (request.body && typeof request.body.pipe === 'function') {
        const declared = request.headers['content-length'];
        if (declared !== undefined && Number(declared) > config.maxRequestSize) throw new RequestTooLargeError();
        contentLength = declared;
        const limiter = new ByteLimit(config.maxRequestSize, () => new RequestTooLargeError());
        request.body.on('error', (err) => limiter.destroy(err));
        body = request.body.pipe(limiter);
      }

      const headers = buildUpstreamRequestHeaders(request.headers, {
        target,
        cookie: cookieHeader,
        acceptEncoding: ACCEPT_ENCODING,
        referer,
        origin,
        via,
        contentLength
      });

      // Abort the upstream fetch if the client goes away mid-transfer.
      const ac = new AbortController();
      let upstreamDone = false;
      reply.raw.once('close', () => {
        if (!upstreamDone && !reply.raw.writableFinished) ac.abort();
      });

      const res = await upstream.request({ method, target, headers, body, signal: ac.signal });
      const uh = res.headers;
      const markDone = () => {
        upstreamDone = true;
      };
      res.body.once('end', markDone);
      res.body.once('close', markDone);

      // Upstream cookies go into the visitor's server-side jar, never to the browser.
      const setCookies = uh['set-cookie'];
      if (Array.isArray(setCookies) && setCookies.length > 0) {
        if (!session) {
          session = sessions.create();
          setSessionCookie(reply, request, config, session);
        }
        for (const c of setCookies) {
          try {
            session.jar.setCookieSync(c, target.href, { ignoreError: true });
          } catch {
            /* malformed cookie: ignore */
          }
        }
      }

      // Redirects are re-validated against the allowlist.
      let location = null;
      if (REDIRECT_CODES.has(res.statusCode) && typeof uh.location === 'string') {
        const resolved = parseUrl(uh.location, target);
        if (resolved && (resolved.protocol === 'http:' || resolved.protocol === 'https:')) {
          try {
            const validated = validateTarget(resolved, policy);
            location = toProxyPath(validated) + resolved.hash;
          } catch (err) {
            // Whatever the reason (outside the authorized scope, blacklisted,
            // IP literal, custom port…) the upstream redirect is stopped and
            // explained to the user.
            res.body.destroy();
            if (!(err instanceof ProxyError)) throw err;
            if (err.code === 'DOMAIN_BLACKLISTED') throw new DomainBlockedError(resolved.hostname, { redirectTarget: resolved.href });
            throw new DomainNotAllowedError(resolved.hostname, { redirectTarget: resolved.href });
          }
        } else if (resolved) {
          location = resolved.href; // mailto:, etc. — passes through untouched
        }
      }

      const contentType = typeof uh['content-type'] === 'string' ? uh['content-type'] : '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      const encoding = normalizeEncoding(uh['content-encoding']);
      const hasBody = method !== 'HEAD' && !BODYLESS_STATUS.has(res.statusCode);
      const partial = res.statusCode === 206;
      const isHtml = hasBody && !partial && (mime === 'text/html' || mime === 'application/xhtml+xml');
      const isCss = hasBody && !partial && mime === 'text/css';
      const rewrite = (isHtml || isCss) && canDecode(encoding);
      const decodeForClient = hasBody && encoding !== 'identity' && canDecode(encoding) && !clientAccepts(request.headers['accept-encoding'], encoding);
      const mustDecode = rewrite || decodeForClient;

      const out = filterUpstreamResponseHeaders(uh, { bodyModified: mustDecode });
      if (location) out.location = location;
      if (typeof uh['content-location'] === 'string') {
        try {
          out['content-location'] = urlRewriter.rewrite(new URL(uh['content-location'], target).href, target);
        } catch {
          /* drop unparsable header */
        }
      }
      out['referrer-policy'] = 'same-origin';
      out['x-robots-tag'] = 'noindex, nofollow';
      if (rewrite) out['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';

      reply.code(res.statusCode);
      reply.headers(out);

      if (!hasBody) {
        res.body.resume();
        return reply.send();
      }

      const stages = [res.body, new ByteLimit(config.maxResponseSize)];
      if (mustDecode) {
        const decoder = createDecoder(encoding);
        if (decoder) stages.push(decoder, new ByteLimit(config.maxResponseSize));
      }

      const onPipelineDone = (err) => {
        if (err && !isBenignStreamError(err)) {
          request.log.warn({ code: err.code, err: err.message, host: target.hostname }, 'proxy stream ended with error');
        }
      };

      if (rewrite && isCss) {
        const buf = await collect(pipeline(...stages, onPipelineDone), config.maxResponseSize);
        const css = rewriteCss(decodeBuffer(buf, charsetFromContentType(contentType)), target, urlRewriter);
        return reply.send(Buffer.from(css, 'utf8'));
      }

      if (rewrite && isHtml) {
        stages.push(new DecodeStream({ headerCharset: charsetFromContentType(contentType), sniff: true }));
        stages.push(createHtmlRewriter({ pageUrl: target, urlRewriter, headSnippet: headHtml(target), bodySnippet: bannerHtml(target) }));
      }

      return reply.send(pipeline(...stages, onPipelineDone));
    }
  });
}

function parseUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function isBenignStreamError(err) {
  return err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ABORT_ERR' || err.clientAborted || err.code === 'ECONNRESET';
}
