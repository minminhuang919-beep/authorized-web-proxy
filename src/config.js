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

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i;
const SIZE_MULT = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export class ConfigError extends Error {
  constructor(message) {
    super(message);
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

/**
 * Build the configuration object from an environment map.
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  const nodeEnv = pick(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const adminUsername = pick(env, 'ADMIN_USERNAME', '');
  const adminPassword = pick(env, 'ADMIN_PASSWORD', '');
  if ((adminUsername && !adminPassword) || (!adminUsername && adminPassword)) {
    throw new ConfigError('ADMIN_USERNAME and ADMIN_PASSWORD must both be set (or both left empty to disable the admin area)');
  }
  if (adminPassword && adminPassword.length < 12) {
    throw new ConfigError('ADMIN_PASSWORD must be at least 12 characters long');
  }
  if (adminPassword && ['password', 'changeme', 'admin'].some((w) => adminPassword.toLowerCase().includes(w))) {
    throw new ConfigError('ADMIN_PASSWORD is too weak (contains a common word)');
  }

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

  return Object.freeze({
    nodeEnv,
    isProduction,
    isTest,
    host: pick(env, 'HOST', '0.0.0.0'),
    port: parseInteger(pick(env, 'PORT', '8080'), 'PORT', { min: 0, max: 65535 }),
    logLevel: pick(env, 'LOG_LEVEL', isTest ? 'silent' : 'info'),
    trustProxy: parseBool(pick(env, 'TRUST_PROXY', 'false'), 'TRUST_PROXY'),
    dataDir: path.resolve(pick(env, 'DATA_DIR', './data')),

    allowedDomains: parseList(pick(env, 'PROXY_ALLOWED_DOMAINS', '')),
    unlistedUrlMode,
    showAllowlist: parseBool(pick(env, 'PROXY_SHOW_ALLOWLIST', 'true'), 'PROXY_SHOW_ALLOWLIST'),
    banner: parseBool(pick(env, 'PROXY_BANNER', 'true'), 'PROXY_BANNER'),

    admin: Object.freeze({
      enabled: Boolean(adminUsername && adminPassword),
      username: adminUsername,
      password: adminPassword
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
