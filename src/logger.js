/**
 * Pino logger options. Sensitive request/response material is redacted as a
 * second line of defence — the app never logs full headers on purpose, and
 * proxied URLs are logged as hostnames only.
 */
export function loggerOptions(config) {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["proxy-authorization"]',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'headers.cookie',
        'headers.authorization',
        'headers["set-cookie"]',
        '*.password',
        '*.secret',
        '*.token',
        'password',
        'secret',
        'token'
      ],
      censor: '[redacted]'
    },
    serializers: {
      // Only log what is needed to trace a request; never the query string
      // (proxied URLs may contain tokens) and never headers.
      req(request) {
        return {
          id: request.id,
          method: request.method,
          path: safePath(request.url),
          ip: request.ip
        };
      },
      res(reply) {
        return { statusCode: reply.statusCode };
      }
    }
  };
}

/** Strip the query string and reduce proxied URLs to `/p/<scheme>/<host>/…`. */
export function safePath(url) {
  if (typeof url !== 'string') return url;
  const path = url.split('?')[0];
  const m = /^\/p\/(https?)\/([^/?#]+)/.exec(path);
  if (m) return `/p/${m[1]}/${m[2]}/…`;
  return path;
}
