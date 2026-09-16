import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, parseSize } from '../src/config.js';

const base = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40) };

test('sizes accept plain bytes and k/m/g suffixes', () => {
  assert.equal(parseSize('1048576', 'X'), 1048576);
  assert.equal(parseSize('512k', 'X'), 524288);
  assert.equal(parseSize('20m', 'X'), 20 * 1024 * 1024);
  assert.equal(parseSize('1.5G', 'X'), 1.5 * 1024 ** 3);
  assert.equal(parseSize('2MB', 'X'), 2 * 1024 ** 2);
  assert.throws(() => parseSize('lots', 'X'), ConfigError);
  assert.throws(() => parseSize('0', 'X'), ConfigError);
});

test('defaults are sensible', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.rateLimit, 300);
  assert.equal(c.maxResponseSize, 20 * 1024 * 1024);
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.admin.enabled, false);
  assert.equal(c.unlistedUrlMode, 'direct');
  assert.deepEqual(c.allowedDomains, []);
});

test('lists split on commas and whitespace', () => {
  const c = loadConfig({ ...base, PROXY_ALLOWED_DOMAINS: 'a.example, b.example\n c.example,,' });
  assert.deepEqual(c.allowedDomains, ['a.example', 'b.example', 'c.example']);
});

test('production requires a session secret; development generates one', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /SESSION_SECRET is required/);
  const dev = loadConfig({ NODE_ENV: 'development' });
  assert.equal(dev.generatedSessionSecret, true);
  assert.ok(dev.sessionSecret.length >= 32);
  assert.throws(() => loadConfig({ ...base, SESSION_SECRET: 'short' }), /at least 32/);
});

test('admin credentials are validated', () => {
  assert.throws(() => loadConfig({ ...base, ADMIN_USERNAME: 'a' }), /must both be set/);
  assert.throws(() => loadConfig({ ...base, ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'short' }), /at least 12/);
  assert.throws(() => loadConfig({ ...base, ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'password12345' }), /too weak/);
  const ok = loadConfig({ ...base, ADMIN_USERNAME: 'a', ADMIN_PASSWORD: 'correct-horse-battery' });
  assert.equal(ok.admin.enabled, true);
});

test('invalid values fail fast with clear messages', () => {
  assert.throws(() => loadConfig({ ...base, PORT: 'eighty' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }), /between/);
  assert.throws(() => loadConfig({ ...base, TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...base, PROXY_UNLISTED_URL_MODE: 'block' }), /direct.*proxy/);
  assert.throws(() => loadConfig({ ...base, REQUEST_TIMEOUT: '0' }), /REQUEST_TIMEOUT/);
});
