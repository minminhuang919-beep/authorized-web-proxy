/**
 * Behaviour required for hosting on Render (ephemeral filesystem, TLS
 * terminated at the edge, $PORT binding): in-memory allowlist storage, HSTS,
 * edge client-IP header for rate limiting, and the render.yaml contents.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createTestApp, cookieHeader, ADMIN_PASSWORD } from './helpers/app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40) };

describe('render hosting', () => {
  test('config: ALLOWLIST_STORAGE, numeric TRUST_PROXY, CLIENT_IP_HEADER', () => {
    const file = loadConfig(base);
    assert.equal(file.allowlistStorage, 'file');
    assert.match(file.allowlistFile, /allowlist\.json$/);
    const mem = loadConfig({ ...base, ALLOWLIST_STORAGE: 'memory' });
    assert.equal(mem.allowlistFile, null);
    assert.throws(() => loadConfig({ ...base, ALLOWLIST_STORAGE: 'disk' }), /ADMIN_STORAGE/);
    assert.equal(loadConfig({ ...base, ADMIN_STORAGE: 'memory' }).blacklistFile, null);
    assert.match(loadConfig(base).blacklistFile, /blacklist\.json$/);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(loadConfig({ ...base, CLIENT_IP_HEADER: 'True-Client-IP' }).clientIpHeader, 'true-client-ip');
    assert.equal(loadConfig(base).clientIpHeader, null);
    assert.throws(() => loadConfig({ ...base, CLIENT_IP_HEADER: 'bad header' }), /CLIENT_IP_HEADER/);
  });

  test('memory allowlist storage never touches the filesystem but works for admins', async () => {
    const ctx = await createTestApp({ env: { ALLOWLIST_STORAGE: 'memory', ADMIN_USERNAME: 'root', ADMIN_PASSWORD } });
    try {
      const login = await ctx.app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `username=root&password=${encodeURIComponent(ADMIN_PASSWORD)}`
      });
      const cookie = cookieHeader(login);
      const dash = await ctx.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
      assert.match(dash.body, /memory only/);
      const settings = await ctx.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } });
      assert.match(settings.body, /memory only/);
      const csrf = /name="_csrf" value="([^"]+)"/.exec(dash.body)[1];
      const add = await ctx.app.inject({
        method: 'POST',
        url: '/admin/domains',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${csrf}&domain=memory.example`
      });
      assert.equal(add.statusCode, 303);
      assert.equal(ctx.app.allowlist.isAllowed('memory.example'), true);
      const bl = await ctx.app.inject({
        method: 'POST',
        url: '/admin/blacklist',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `_csrf=${csrf}&domain=blocked.memory.example`
      });
      assert.equal(bl.statusCode, 303);
      assert.equal(ctx.app.blacklist.isBlocked('blocked.memory.example'), true);
      const files = await fs.readdir(ctx.dataDir);
      assert.deepEqual(files, [], 'nothing written to DATA_DIR');
    } finally {
      await ctx.close();
    }
  });

  test('HSTS is sent only for HTTPS requests seen through the trusted proxy', async () => {
    const ctx = await createTestApp({ env: { TRUST_PROXY: 'true' } });
    try {
      const secure = await ctx.app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(secure.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
      const proxied = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing', headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(proxied.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
      const plain = await ctx.app.inject({ method: 'GET', url: '/' });
      assert.equal(plain.headers['strict-transport-security'], undefined);
      // Secure session cookies when the edge says https
      const cookies = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/set-cookie', headers: { 'x-forwarded-proto': 'https' } });
      assert.match([].concat(cookies.headers['set-cookie']).join(';'), /Secure/);
    } finally {
      await ctx.close();
    }
  });

  test('rate limiting keys on the edge-provided client IP header when configured', async () => {
    const ctx = await createTestApp({ env: { TRUST_PROXY: 'true', CLIENT_IP_HEADER: 'true-client-ip', RATE_LIMIT: '2' } });
    try {
      const hit = (ip, extra = {}) => ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing', headers: { 'true-client-ip': ip, ...extra } });
      assert.equal((await hit('198.51.100.1')).statusCode, 200);
      assert.equal((await hit('198.51.100.1')).statusCode, 200);
      assert.equal((await hit('198.51.100.1')).statusCode, 429, 'third request from the same client is limited');
      // A spoofed X-Forwarded-For does not create a fresh bucket.
      assert.equal((await hit('198.51.100.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode, 429);
      assert.equal((await hit('198.51.100.2')).statusCode, 200, 'another client is unaffected');
    } finally {
      await ctx.close();
    }
  });

  test('the server binds to 0.0.0.0:$PORT and serves /health', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        HOST: '0.0.0.0',
        SESSION_SECRET: 's'.repeat(40),
        PROXY_ALLOWED_DOMAINS: 'example.com',
        ALLOWLIST_STORAGE: 'memory',
        LOG_LEVEL: 'silent'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      let health;
      for (let i = 0; i < 50 && !health; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) health = await res.json();
        } catch {
          /* not up yet */
        }
      }
      assert.ok(health, `server did not answer on port ${port}`);
      assert.equal(health.status, 'ok');
      assert.equal(health.allowlist.size, 1);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });

  test('render.yaml describes a free Docker web service with the required variables', async () => {
    const text = await fs.readFile(path.join(ROOT, 'render.yaml'), 'utf8');
    assert.match(text, /^\s*-\s*type: web$/m);
    assert.match(text, /^\s*runtime: docker$/m);
    assert.match(text, /^\s*plan: free$/m);
    assert.match(text, /^\s*healthCheckPath: \/health$/m);
    assert.match(text, /^\s*dockerfilePath: \.\/Dockerfile$/m);
    for (const key of ['PROXY_ALLOWED_DOMAINS', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'RATE_LIMIT', 'MAX_RESPONSE_SIZE', 'REQUEST_TIMEOUT', 'PORT', 'TRUST_PROXY', 'ADMIN_STORAGE']) {
      assert.match(text, new RegExp(`^\\s*- key: ${key}\\b`, 'm'), `${key} configured`);
    }
    // secrets are never given literal values
    assert.match(text, /- key: ADMIN_PASSWORD[^\n]*\n\s*sync: false/);
    assert.match(text, /- key: SESSION_SECRET[^\n]*\n\s*generateValue: true/);
    assert.doesNotMatch(text, /ADMIN_PASSWORD[^\n]*\n\s*value:/);
    assert.doesNotMatch(text, /maxShutdownDelaySeconds/, 'rejected by the Render free plan');
  });
});
