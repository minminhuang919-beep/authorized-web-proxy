/**
 * Builds the proxy app for tests.
 *
 * Production code paths are used as-is with two injected dependencies:
 *  - a fake DNS `lookup` that maps test hostnames to 127.0.0.1 (or to
 *    whatever addresses a test wants to simulate), so no test touches the
 *    network, and
 *  - an address policy that additionally allows 127.0.0.1 (the mock server)
 *    while delegating every other address to the real production check.
 * The scheme default ports are pointed at the mock server's random port; the
 * proxy still refuses any user-supplied port.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { isAddressAllowed as productionIsAddressAllowed } from '../../src/security/address.js';
import { createMockSite } from './mock-site.js';

export const TEST_SECRET = 'test-session-secret-0123456789abcdef0123456789';
export const ADMIN_PASSWORD = 'correct-horse-battery-staple';

export const DEFAULT_HOSTS = {
  'site.test': '127.0.0.1',
  'cdn.test': '127.0.0.1',
  'other.test': '127.0.0.1',
  'sub.wild.test': '127.0.0.1',
  'evil.test': '10.0.0.5',
  'meta.test': '169.254.169.254',
  'loop6.test': '::1',
  'mapped.test': '::ffff:127.0.0.1',
  'mixed.test': ['93.184.216.34', '192.168.1.1'],
  'nx.test': null
};

export function fakeLookup(hosts) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const entry = hosts[hostname];
    setImmediate(() => {
      if (entry === undefined || entry === null) {
        const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = 'ENOTFOUND';
        return callback(err);
      }
      const list = (Array.isArray(entry) ? entry : [entry]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env] extra environment overrides
 * @param {Record<string,string|string[]|null>} [opts.hosts] fake DNS table
 * @param {string[]} [opts.allowedAddresses] addresses permitted on top of the production policy
 * @param {boolean} [opts.withMock] start a mock site (default true)
 * @param {(app: import('fastify').FastifyInstance) => Promise<void>|void} [opts.setup] runs before the app is readied (extra routes)
 * @param {object} [opts.deps] extra buildApp dependencies (e.g. a capturing `logger`)
 */
export async function createTestApp({ env = {}, hosts = DEFAULT_HOSTS, allowedAddresses = ['127.0.0.1'], withMock = true, setup, deps: extraDeps = {} } = {}) {
  const mock = withMock ? await createMockSite().start() : null;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anonview-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PROXY_ALLOWED_DOMAINS: 'site.test,cdn.test,other.test,*.wild.test,evil.test,meta.test,loop6.test,mapped.test,mixed.test,nx.test',
    SESSION_SECRET: TEST_SECRET,
    DATA_DIR: dataDir,
    REQUEST_TIMEOUT: '5',
    CONNECT_TIMEOUT: '5',
    TRANSFER_TIMEOUT: '30',
    ...env
  });
  const app = await buildApp({
    config,
    deps: {
      lookup: fakeLookup(hosts),
      isAddressAllowed: (address) => allowedAddresses.includes(address) || productionIsAddressAllowed(address),
      defaultPorts: mock ? { http: mock.port, https: mock.port } : undefined,
      ...extraDeps
    }
  });
  if (setup) await setup(app);
  await app.ready();
  return {
    app,
    mock,
    config,
    dataDir,
    async close() {
      await app.close();
      if (mock) await mock.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

/** Extract a cookie value (raw, still signed) from a Set-Cookie header list. */
export function cookieFromResponse(res, name) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const m = /^([^=]+)=([^;]*)/.exec(c);
    if (m && m[1] === name) return decodeURIComponent(m[2]);
  }
  return null;
}

/** Turn a Set-Cookie list into a Cookie request header. */
export function cookieHeader(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}
