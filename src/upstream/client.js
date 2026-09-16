/**
 * Outbound HTTP(S) client used to fetch content from allowlisted sites.
 *
 * - Every connection resolves DNS through `createSafeLookup`, so the
 *   private/loopback/link-local check happens on the exact address the socket
 *   connects to (no rebinding window). TLS still verifies the certificate
 *   against the hostname.
 * - Only the scheme's default port is ever used.
 * - Redirects are never followed here; the caller re-validates them.
 * - Connect, header, idle and total-transfer timeouts are enforced, as is a
 *   cap on concurrent upstream requests and on declared response sizes.
 */
import http from 'node:http';
import https from 'node:https';
import { createSafeLookup } from '../security/safe-lookup.js';
import {
  BlockedAddressError,
  InvalidUrlError,
  ResponseTooLargeError,
  ServiceBusyError,
  UpstreamError,
  UpstreamTimeoutError
} from '../errors.js';

const kGuarded = Symbol('anonview.socketGuarded');

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO',
  'CERT_REVOKED',
  'HOSTNAME_MISMATCH'
]);

/**
 * @param {object} opts
 * @param {import('../config.js').loadConfig extends (...a: any) => infer R ? R : never} opts.config
 * @param {import('pino').Logger} opts.logger
 * @param {Function} [opts.lookup] DNS lookup override (tests)
 * @param {(address: string) => boolean} [opts.isAddressAllowed] address policy override (tests)
 * @param {{ http: number, https: number }} [opts.defaultPorts] scheme default ports (tests point these at a mock server)
 */
export function createUpstreamClient({ config, logger, lookup, isAddressAllowed, defaultPorts = { http: 80, https: 443 } }) {
  const stats = { inFlight: 0, total: 0, errors: 0, blockedAddresses: 0, timeouts: 0 };

  const safeLookup = createSafeLookup({
    lookup,
    isAddressAllowed,
    onBlocked(hostname) {
      stats.blockedAddresses++;
      logger.warn({ hostname }, 'refused to connect: hostname resolved to a non-public address');
    }
  });

  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 64,
    maxFreeSockets: 16,
    scheduling: 'lifo',
    timeout: config.requestTimeoutMs,
    lookup: safeLookup
  };
  const agents = {
    http: new http.Agent(agentOptions),
    https: new https.Agent({ ...agentOptions, maxCachedSessions: 200 })
  };

  function mapError(err, hostname) {
    if (!err) return new UpstreamError();
    if (err.expose) return err; // already one of ours
    const code = err.code || '';
    if (code === 'EBLOCKED') return new BlockedAddressError(hostname);
    if (code === 'ABORT_ERR' || err.name === 'AbortError') {
      const e = new UpstreamError('Request aborted.', 'CLIENT_ABORTED', 499);
      e.clientAborted = true;
      return e;
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME' || code === 'EAI_FAIL') {
      return new UpstreamError(`The address of "${hostname}" could not be found.`, 'DNS_ERROR', 502);
    }
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
      return new UpstreamTimeoutError();
    }
    if (TLS_ERROR_CODES.has(code) || /certificate|tls|ssl/i.test(code)) {
      return new UpstreamError(`The security certificate of "${hostname}" could not be verified.`, 'TLS_ERROR', 502);
    }
    if (code === 'ERR_UNESCAPED_CHARACTERS' || code === 'ERR_INVALID_URL' || code === 'ERR_INVALID_HTTP_TOKEN' || code === 'ERR_INVALID_CHAR') {
      return new InvalidUrlError();
    }
    if (code.startsWith('HPE_')) {
      return new UpstreamError('The website sent an invalid response.', 'BAD_UPSTREAM_RESPONSE', 502);
    }
    return new UpstreamError();
  }

  /**
   * @param {object} opts
   * @param {string} opts.method
   * @param {URL} opts.target validated target URL
   * @param {Record<string, string|string[]>} opts.headers
   * @param {import('node:stream').Readable|Buffer|null} [opts.body]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{ statusCode: number, headers: import('node:http').IncomingHttpHeaders, body: import('node:http').IncomingMessage }>}
   */
  function request({ method, target, headers, body = null, signal }) {
    if (stats.inFlight >= config.maxConcurrentUpstream) {
      return Promise.reject(new ServiceBusyError());
    }
    const scheme = target.protocol === 'https:' ? 'https' : 'http';
    const mod = scheme === 'https' ? https : http;
    const hostname = target.hostname;

    stats.inFlight++;
    stats.total++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        stats.inFlight--;
      }
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let headersDeadline = null;
      let transferDeadline = null;
      const clearTimers = () => {
        if (headersDeadline) clearTimeout(headersDeadline);
        if (transferDeadline) clearTimeout(transferDeadline);
        headersDeadline = transferDeadline = null;
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        release();
        const mapped = mapError(err, hostname);
        if (mapped instanceof UpstreamTimeoutError) stats.timeouts++;
        if (!mapped.clientAborted) stats.errors++;
        reject(mapped);
      };

      let req;
      try {
        req = mod.request({
          protocol: `${scheme}:`,
          hostname,
          port: defaultPorts[scheme],
          path: `${target.pathname}${target.search}`,
          method,
          headers,
          agent: agents[scheme],
          servername: scheme === 'https' ? hostname : undefined,
          setHost: false,
          signal
        });
      } catch (err) {
        fail(err);
        return;
      }

      // Absolute deadline for receiving the response headers (guards against
      // slow-loris style upstreams that trickle bytes to defeat idle timeouts).
      headersDeadline = setTimeout(() => req.destroy(new UpstreamTimeoutError()), config.connectTimeoutMs + config.requestTimeoutMs);

      req.on('socket', (socket) => {
        // Node briefly leaves keep-alive sockets without an 'error' listener
        // while handing them back to the pool; an abort in that window would
        // otherwise surface as an uncaught exception. Guard each socket once.
        if (!socket[kGuarded]) {
          socket[kGuarded] = true;
          socket.on('error', () => {});
        }
        if (socket.connecting) {
          socket.setTimeout(config.connectTimeoutMs);
          const connected = () => socket.setTimeout(config.requestTimeoutMs);
          socket.once(scheme === 'https' ? 'secureConnect' : 'connect', connected);
        } else {
          socket.setTimeout(config.requestTimeoutMs);
        }
      });
      req.on('timeout', () => req.destroy(new UpstreamTimeoutError()));
      req.on('error', fail);

      req.on('response', (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        if (headersDeadline) clearTimeout(headersDeadline);
        headersDeadline = null;

        const declared = res.headers['content-length'];
        if (declared !== undefined && Number(declared) > config.maxResponseSize) {
          res.destroy(new ResponseTooLargeError());
          clearTimers();
          release();
          stats.errors++;
          reject(new ResponseTooLargeError());
          return;
        }

        // Consumers attach their own listeners; this one only prevents an
        // unhandled 'error' when the body is dropped early (client aborts).
        res.on('error', () => {});
        transferDeadline = setTimeout(() => {
          stats.timeouts++;
          res.destroy(new UpstreamTimeoutError());
        }, config.transferTimeoutMs);
        res.once('close', () => {
          clearTimers();
          release();
        });
        // An upstream that drops the connection mid-body surfaces as an
        // 'aborted' + 'error' pair; make sure consumers see an error.
        res.once('aborted', () => {
          if (!res.destroyed) res.destroy(new UpstreamError('The website closed the connection early.', 'UPSTREAM_ABORTED', 502));
        });
        resolve({ statusCode: res.statusCode, headers: res.headers, body: res });
      });

      if (body === null || body === undefined) {
        req.end();
      } else if (Buffer.isBuffer(body) || typeof body === 'string') {
        req.end(body);
      } else {
        body.on('error', (err) => req.destroy(err));
        body.pipe(req);
      }
    });
  }

  function close() {
    agents.http.destroy();
    agents.https.destroy();
  }

  return { request, stats, close, safeLookup };
}
