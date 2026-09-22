/**
 * Environment configuration.
 *
 * Every setting comes from environment variables (see `.env.example`).
 * Values are validated up-front so the process fails fast with a clear
 * message instead of misbehaving later. Nothing here is hard-coded secret
 * material; secrets are only ever read from the environment.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { hashPassword, isPasswordHash } from './security/password.js';

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i;
const SIZE_MULT = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export class ConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** Parse a byte size such as `1048576`, `20m`, `512k`, `1g`. */
export function parseSize(value, name) {
  const m = SIZE_RE.exec(String(value).trim());
  if (!m) throw new ConfigError(`${name}: "${value}" is not a valid size (examples: 1048576, 512k, 20m, 1g)`);
  const n = Math.round(parseFloat(m[1]) * SIZE_MULT[m[2].toLowerCase()]);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name}: must be a positive size`);
  return n;
}

function parseInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) throw new ConfigError(`${name}: "${value}" is not an integer`);
  const n = Number.parseInt(s, 10);
  if (n < min || n > max) throw new ConfigError(`${name}: must be between ${min} and ${max}`);
  return n;
}

function parseBool(value, name) {
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  throw new ConfigError(`${name}: "${value}" is not a boolean (use true/false)`);
}

function parseList(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pick(env, name, fallback) {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Which required setting is missing before `provider` can answer a search?
 * Returns '' when the provider is ready to use.
 * @param {string} provider
 * @param {{ searchUrl: string, searchApiKey: string, searchEngineId: string }} settings
 */
function searchConfigurationGap(provider, { searchUrl, searchApiKey, searchEngineId }) {
  if (provider === 'searxng' && !searchUrl) {
    return 'SEARCH_PROVIDER_URL is not set (the base URL of a SearXNG instance that has `json` in its search.formats, e.g. https://searxng.example)';
  }
  if (provider === 'proxy' && !searchUrl) {
    return 'SEARCH_PROVIDER_URL is not set (a URL template containing {q}, e.g. https://duckduckgo.com/html/?q={q})';
  }
  if ((provider === 'brave' || provider === 'google') && !searchApiKey) {
    return `SEARCH_API_KEY is not set (required by SEARCH_PROVIDER=${provider})`;
  }
  if (provider === 'google' && !searchEngineId) {
    return 'SEARCH_ENGINE_ID is not set (the Programmable Search Engine id, "cx")';
  }
  return '';
}

/**
 * Build the configuration object from an environment map.
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  const nodeEnv = pick(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  // Admin credentials. The password is never kept in plaintext by the app:
  // either ADMIN_PASSWORD_HASH (scrypt, from `npm run hash-password`) is given,
  // or ADMIN_PASSWORD is hashed at start-up and only the hash is retained.
  const adminUsername = pick(env, 'ADMIN_USERNAME', '');
  const adminPassword = pick(env, 'ADMIN_PASSWORD', '');
  const adminPasswordHash = pick(env, 'ADMIN_PASSWORD_HASH', '');
  if (adminPasswordHash && !isPasswordHash(adminPasswordHash)) {
    throw new ConfigError('ADMIN_PASSWORD_HASH is not a valid hash (generate one with: npm run hash-password)');
  }
  const hasCredential = Boolean(adminPassword || adminPasswordHash);
  if ((adminUsername && !hasCredential) || (!adminUsername && hasCredential)) {
    throw new ConfigError('ADMIN_USERNAME and ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) must both be set, or both left empty to disable the admin area');
  }
  if (adminPassword && !adminPasswordHash) {
    if (adminPassword.length < 12) {
      throw new ConfigError('ADMIN_PASSWORD must be at least 12 characters long');
    }
    if (['password', 'changeme', 'admin'].some((w) => adminPassword.toLowerCase().includes(w))) {
      throw new ConfigError('ADMIN_PASSWORD is too weak (contains a common word)');
    }
  }
  const adminHash = adminPasswordHash || (adminPassword ? hashPassword(adminPassword) : '');

  let sessionSecret = pick(env, 'SESSION_SECRET', '');
  let generatedSessionSecret = false;
  if (!sessionSecret) {
    if (isProduction) {
      throw new ConfigError('SESSION_SECRET is required in production (generate one with: openssl rand -hex 32)');
    }
    sessionSecret = randomBytes(32).toString('hex');
    generatedSessionSecret = true;
  } else if (sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 characters long');
  }

  const unlistedUrlMode = pick(env, 'PROXY_UNLISTED_URL_MODE', 'direct').toLowerCase();
  if (!['direct', 'proxy'].includes(unlistedUrlMode)) {
    throw new ConfigError('PROXY_UNLISTED_URL_MODE must be "direct" or "proxy"');
  }

  const requestTimeout = parseInteger(pick(env, 'REQUEST_TIMEOUT', '30'), 'REQUEST_TIMEOUT', { min: 1, max: 600 });
  const connectTimeout = parseInteger(pick(env, 'CONNECT_TIMEOUT', '10'), 'CONNECT_TIMEOUT', { min: 1, max: 120 });
  const transferTimeout = parseInteger(pick(env, 'TRANSFER_TIMEOUT', '300'), 'TRANSFER_TIMEOUT', { min: 1, max: 3600 });

  // TRUST_PROXY: true/false, or the number of reverse-proxy hops in front of
  // the app (Fastify then uses the address that many hops from the right of
  // X-Forwarded-For, which clients cannot spoof).
  const trustProxyRaw = pick(env, 'TRUST_PROXY', 'false');
  const trustProxy = /^\d+$/.test(String(trustProxyRaw).trim())
    ? parseInteger(trustProxyRaw, 'TRUST_PROXY', { min: 0, max: 16 })
    : parseBool(trustProxyRaw, 'TRUST_PROXY');

  // Optional header carrying the real client IP, set by a trusted edge
  // (e.g. `true-client-ip` on Render / Cloudflare). Used for rate limiting.
  const clientIpHeader = pick(env, 'CLIENT_IP_HEADER', '').trim().toLowerCase();
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) {
    throw new ConfigError('CLIENT_IP_HEADER must be a header name such as true-client-ip');
  }

  // ADMIN_STORAGE (alias: ALLOWLIST_STORAGE): `file` persists admin-managed
  // data (authorized scope additions, blacklist) as JSON under DATA_DIR;
  // `memory` keeps it in RAM only — for hosts with an ephemeral filesystem
  // such as Render's free plan, where the environment is the source of truth.
  const adminStorage = pick(env, 'ADMIN_STORAGE', pick(env, 'ALLOWLIST_STORAGE', 'file')).toLowerCase();
  if (!['file', 'memory'].includes(adminStorage)) {
    throw new ConfigError('ADMIN_STORAGE must be "file" or "memory"');
  }
  const dataDir = path.resolve(pick(env, 'DATA_DIR', './data'));

  // Web search for the homepage box: off unless SEARCH_PROVIDER is set.
  //
  // A *malformed* setting (unknown provider, non-http URL, a `proxy` template
  // without {q}) fails at start-up. A *missing* one only disables search:
  // `config.search.configured` becomes false and `config.search.reason` names
  // the variable, so an incomplete search configuration can never take the
  // whole proxy down — the results page reports that search is not set up.
  const searchProvider = pick(env, 'SEARCH_PROVIDER', 'none').trim().toLowerCase();
  if (!['none', 'searxng', 'brave', 'google', 'proxy'].includes(searchProvider)) {
    throw new ConfigError('SEARCH_PROVIDER must be one of: none, searxng, brave, google, proxy');
  }
  // SEARCH_PROVIDER_URL is the backend's URL for every provider that takes one
  // (SearXNG base URL, `proxy` template, brave/google endpoint override).
  // SEARXNG_URL (searxng only) and SEARCH_URL remain accepted as aliases.
  const providerUrl = pick(env, 'SEARCH_PROVIDER_URL', '').trim();
  const searxngUrl = searchProvider === 'searxng' ? pick(env, 'SEARXNG_URL', '').trim() : '';
  const legacyUrl = pick(env, 'SEARCH_URL', '').trim();
  const searchUrl = providerUrl || searxngUrl || legacyUrl;
  const searchUrlName = providerUrl ? 'SEARCH_PROVIDER_URL' : searxngUrl ? 'SEARXNG_URL' : legacyUrl ? 'SEARCH_URL' : 'SEARCH_PROVIDER_URL';
  const searchApiKey = pick(env, 'SEARCH_API_KEY', '').trim();
  const searchEngineId = pick(env, 'SEARCH_ENGINE_ID', '').trim();
  if (searchUrl && !isHttpUrl(searchUrl.replaceAll('{q}', 'q'))) {
    throw new ConfigError(`${searchUrlName} must be an http:// or https:// URL`);
  }
  if (searchProvider === 'proxy' && searchUrl && !searchUrl.includes('{q}')) {
    throw new ConfigError('SEARCH_PROVIDER_URL must be a URL template containing {q} when SEARCH_PROVIDER=proxy, e.g. https://duckduckgo.com/html/?q={q}');
  }
  const searchGap = searchConfigurationGap(searchProvider, { searchUrl, searchApiKey, searchEngineId });

  return Object.freeze({
    nodeEnv,
    isProduction,
    isTest,
    host: pick(env, 'HOST', '0.0.0.0'),
    port: parseInteger(pick(env, 'PORT', '8080'), 'PORT', { min: 0, max: 65535 }),
    logLevel: pick(env, 'LOG_LEVEL', isTest ? 'silent' : 'info'),
    trustProxy,
    clientIpHeader: clientIpHeader || null,
    dataDir,
    adminStorage,
    allowlistStorage: adminStorage,
    allowlistFile: adminStorage === 'file' ? path.join(dataDir, 'allowlist.json') : null,
    blacklistFile: adminStorage === 'file' ? path.join(dataDir, 'blacklist.json') : null,
    blacklistEnv: pick(env, 'PROXY_BLACKLIST', ''),
    sitesFile: adminStorage === 'file' ? path.join(dataDir, 'sites.json') : null,
    sitesEnv: pick(env, 'PROXY_SITES', ''),

    search: Object.freeze({
      provider: searchProvider,
      url: searchUrl,
      apiKey: searchApiKey,
      engineId: searchEngineId,
      // `configured`: the selected provider has everything it needs (always
      // true for `none`, where search is deliberately off). `reason` names the
      // missing variable when it does not.
      configured: searchProvider === 'none' ? true : !searchGap,
      reason: searchGap,
      timeoutMs: parseInteger(pick(env, 'SEARCH_TIMEOUT', '10'), 'SEARCH_TIMEOUT', { min: 1, max: 60 }) * 1000,
      rateLimit: parseInteger(pick(env, 'SEARCH_RATE_LIMIT', '60'), 'SEARCH_RATE_LIMIT', { min: 1, max: 100_000 })
    }),

    allowedDomains: parseList(pick(env, 'PROXY_ALLOWED_DOMAINS', '')),
    // Hosts whose sign-in / OAuth flows may be proxied because the operator
    // runs the application and its OAuth client (README §6). Empty by
    // default: every third-party authentication flow gets the explanation
    // page instead of a provider error.
    authFlowHosts: parseList(pick(env, 'PROXY_AUTH_FLOW_HOSTS', '')),
    unlistedUrlMode,
    showAllowlist: parseBool(pick(env, 'PROXY_SHOW_ALLOWLIST', 'true'), 'PROXY_SHOW_ALLOWLIST'),
    banner: parseBool(pick(env, 'PROXY_BANNER', 'true'), 'PROXY_BANNER'),

    admin: Object.freeze({
      enabled: Boolean(adminUsername && adminHash),
      username: adminUsername,
      passwordHash: adminHash
    }),

    sessionSecret,
    generatedSessionSecret,
    sessionTtlMs: parseInteger(pick(env, 'SESSION_TTL', '1800'), 'SESSION_TTL', { min: 60, max: 86400 * 30 }) * 1000,
    sessionMax: parseInteger(pick(env, 'SESSION_MAX', '5000'), 'SESSION_MAX', { min: 1, max: 1_000_000 }),

    rateLimit: parseInteger(pick(env, 'RATE_LIMIT', '300'), 'RATE_LIMIT', { min: 1, max: 1_000_000 }),
    rateLimitWindowMs: parseInteger(pick(env, 'RATE_LIMIT_WINDOW', '60'), 'RATE_LIMIT_WINDOW', { min: 1, max: 3600 }) * 1000,
    adminRateLimit: parseInteger(pick(env, 'ADMIN_RATE_LIMIT', '10'), 'ADMIN_RATE_LIMIT', { min: 1, max: 10_000 }),

    maxResponseSize: parseSize(pick(env, 'MAX_RESPONSE_SIZE', '20m'), 'MAX_RESPONSE_SIZE'),
    maxRequestSize: parseSize(pick(env, 'MAX_REQUEST_SIZE', '2m'), 'MAX_REQUEST_SIZE'),
    requestTimeoutMs: requestTimeout * 1000,
    connectTimeoutMs: connectTimeout * 1000,
    transferTimeoutMs: transferTimeout * 1000,
    maxConcurrentUpstream: parseInteger(pick(env, 'MAX_CONCURRENT_UPSTREAM', '64'), 'MAX_CONCURRENT_UPSTREAM', { min: 1, max: 10_000 }),

    maxUrlLength: 4096
  });
}
