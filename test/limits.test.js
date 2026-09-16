import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestApp } from './helpers/app.js';

/** Perform a real HTTP GET against a listening app and collect the result. */
function realGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
      res.on('error', (err) => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: false, error: err }));
      res.on('aborted', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: false, aborted: true }));
    });
    req.on('error', reject);
  });
}

describe('limits', () => {
  test('rate limiting returns a friendly 429 after the configured number of requests', async () => {
    const ctx = await createTestApp({ env: { RATE_LIMIT: '3', RATE_LIMIT_WINDOW: '60' } });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
        assert.equal(res.statusCode, 200, `request ${i + 1}`);
        assert.equal(res.headers['x-ratelimit-limit'], '3');
      }
      const limited = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
      assert.equal(limited.statusCode, 429);
      assert.match(limited.body, /Too many requests/);
      assert.ok(limited.headers['retry-after']);
      assert.equal(ctx.mock.requests.length, 3, 'the limited request never reached upstream');
      // Other clients (other IPs) are unaffected.
      const other = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing', remoteAddress: '198.51.100.7' });
      assert.equal(other.statusCode, 200);
      const json = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing', headers: { accept: 'application/json' } });
      assert.equal(json.statusCode, 429);
      assert.equal(JSON.parse(json.body).error.code, 'RATE_LIMITED');
    } finally {
      await ctx.close();
    }
  });

  test('responses with a declared size above the maximum are refused up front', async () => {
    const ctx = await createTestApp({ env: { MAX_RESPONSE_SIZE: '100k' } });
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/big-known?size=200000' });
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /larger than this proxy allows/);
      const ok = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/big-known?size=50000' });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.rawPayload.length, 50000);
    } finally {
      await ctx.close();
    }
  });

  test('chunked responses are cut off once the maximum is exceeded', async () => {
    const ctx = await createTestApp({ env: { MAX_RESPONSE_SIZE: '100k' } });
    try {
      const port = (await ctx.app.listen({ port: 0, host: '127.0.0.1' }), ctx.app.server.address().port);
      const res = await realGet(port, '/p/http/site.test/big?size=1000000');
      assert.equal(res.statusCode, 200);
      assert.equal(res.complete, false, 'the connection is terminated, never a silently complete truncated body');
      assert.ok(res.body.length <= 100 * 1024 + 64 * 1024, `received ${res.body.length} bytes`);
      // The proxy is still healthy afterwards.
      const health = await realGet(port, '/health');
      assert.equal(health.statusCode, 200);
      // HTML is limited on the decoded/rewritten path too.
      const html = await realGet(port, '/p/http/site.test/big-html?size=1000000');
      assert.equal(html.complete, false);
    } finally {
      await ctx.close();
    }
  });

  test('an upstream that never sends headers times out with a 504', async () => {
    const ctx = await createTestApp({ env: { REQUEST_TIMEOUT: '1', CONNECT_TIMEOUT: '1' } });
    try {
      const started = Date.now();
      const res = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/slow?ms=10000' });
      assert.equal(res.statusCode, 504);
      assert.match(res.body, /took too long/);
      assert.ok(Date.now() - started < 5000, 'timed out promptly');
      assert.equal(ctx.app.upstream.stats.timeouts, 1);
      assert.equal(ctx.app.upstream.stats.inFlight, 0, 'the slot is released');
    } finally {
      await ctx.close();
    }
  });

  test('an upstream body that stalls is cut off by the idle timeout', async () => {
    const ctx = await createTestApp({ env: { REQUEST_TIMEOUT: '1', CONNECT_TIMEOUT: '1' } });
    try {
      await ctx.app.listen({ port: 0, host: '127.0.0.1' });
      const port = ctx.app.server.address().port;
      const started = Date.now();
      const res = await realGet(port, '/p/http/site.test/slow-body?ms=10000');
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.toString(), 'first');
      assert.equal(res.complete, false);
      assert.ok(Date.now() - started < 6000);
    } finally {
      await ctx.close();
    }
  });

  test('request bodies above the maximum are rejected', async () => {
    const ctx = await createTestApp({ env: { MAX_REQUEST_SIZE: '1k' } });
    try {
      const big = 'x'.repeat(2048);
      const declared = await ctx.app.inject({ method: 'POST', url: '/p/http/site.test/echo-body', headers: { 'content-type': 'text/plain' }, payload: big });
      assert.equal(declared.statusCode, 413);
      assert.match(declared.body, /larger than this proxy allows/);
      assert.equal(ctx.mock.requests.length, 0);
      const small = await ctx.app.inject({ method: 'POST', url: '/p/http/site.test/echo-body', headers: { 'content-type': 'text/plain' }, payload: 'small' });
      assert.equal(small.statusCode, 200);
      assert.equal(JSON.parse(small.body).body, 'small');
    } finally {
      await ctx.close();
    }
  });

  test('the concurrent upstream request cap returns 503 instead of queueing forever', async () => {
    const ctx = await createTestApp({ env: { MAX_CONCURRENT_UPSTREAM: '2', REQUEST_TIMEOUT: '3' } });
    try {
      const slow = [
        ctx.app.inject({ method: 'GET', url: '/p/http/site.test/slow?ms=500' }),
        ctx.app.inject({ method: 'GET', url: '/p/http/site.test/slow?ms=500' })
      ];
      await new Promise((r) => setTimeout(r, 100));
      const busy = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
      assert.equal(busy.statusCode, 503);
      assert.match(busy.body, /busy/i);
      const results = await Promise.all(slow);
      assert.deepEqual(
        results.map((r) => r.statusCode),
        [200, 200]
      );
      const after = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
      assert.equal(after.statusCode, 200);
    } finally {
      await ctx.close();
    }
  });

  test('over-long URLs are rejected', async () => {
    const ctx = await createTestApp();
    try {
      const res = await ctx.app.inject({ method: 'GET', url: `/p/http/site.test/${'a'.repeat(5000)}` });
      assert.equal(res.statusCode, 400);
      assert.equal(ctx.mock.requests.length, 0);
    } finally {
      await ctx.close();
    }
  });
});
