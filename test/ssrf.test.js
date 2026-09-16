/**
 * SSRF protection tests. Every case must be refused *without* the mock
 * server (which stands in for "an internal service") receiving a request —
 * except where explicitly noted.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/app.js';

describe('SSRF protections', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp();
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });

  test('localhost and loopback literals are refused at the URL stage', async () => {
    const cases = [
      'http://localhost/',
      'http://localhost:8080/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0/',
      'http://foo.localhost/'
    ];
    for (const target of cases) {
      const res = await get(`/open?url=${encodeURIComponent(target)}`);
      assert.ok(res.statusCode === 400 || res.statusCode === 403, `${target}: expected 400/403, got ${res.statusCode}`);
      assert.doesNotMatch(res.headers.location || '', /\/p\//, `${target} must not redirect into the proxy`);
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('private, link-local and metadata addresses are refused at the URL stage', async () => {
    const cases = [
      'http://10.0.0.1/',
      'http://192.168.1.1/admin',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[fd00::1]/',
      'http://100.64.0.1/',
      'http://metadata.google.internal/',
      'http://instance-data.lan/'
    ];
    for (const target of cases) {
      const res = await get(`/open?url=${encodeURIComponent(target)}`);
      assert.ok(res.statusCode === 400 || res.statusCode === 403, `${target}: expected 400/403, got ${res.statusCode}`);
    }
    for (const path of ['/p/http/127.0.0.1/', '/p/http/localhost/', '/p/http/10.0.0.1/', '/p/http/[::1]/', '/p/http/169.254.169.254/latest/', '/p/http/metadata.google.internal/']) {
      const res = await get(path);
      assert.ok(res.statusCode === 400 || res.statusCode === 403, `${path}: expected 400/403, got ${res.statusCode}`);
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('an allowlisted hostname that resolves to a private address is refused after DNS resolution', async () => {
    for (const host of ['evil.test', 'meta.test', 'loop6.test', 'mapped.test']) {
      const res = await get(`/p/http/${host}/`);
      assert.equal(res.statusCode, 403, host);
      assert.match(res.body, /not permitted to reach/);
      assert.doesNotMatch(res.body, /10\.0\.0\.5|169\.254|::1/, 'resolved address is never disclosed');
    }
    assert.equal(ctx.mock.requests.length, 0);
    assert.ok(ctx.app.upstream.stats.blockedAddresses >= 4);
  });

  test('a hostname with mixed public/private DNS answers is refused (rebinding defence)', async () => {
    const res = await get('/p/http/mixed.test/');
    assert.equal(res.statusCode, 403);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('DNS rebinding between requests is caught on every connection', async () => {
    // A DNS table whose answer for site.test flips from the mock server to a
    // private address after the first resolution.
    let calls = 0;
    const hosts = new Proxy(
      {},
      {
        get(_t, name) {
          if (name !== 'site.test') return undefined;
          calls++;
          return calls === 1 ? '127.0.0.1' : '10.0.0.9';
        }
      }
    );
    const rebind = await createTestApp({ hosts });
    try {
      const first = await rebind.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
      assert.equal(first.statusCode, 200);
      // Drop pooled connections so the next request must resolve DNS again.
      rebind.app.upstream.close();
      const second = await rebind.app.inject({ method: 'GET', url: '/p/http/site.test/landing' });
      assert.equal(second.statusCode, 403);
      assert.equal(calls, 2);
      assert.equal(rebind.mock.requests.length, 1, 'the second request never reached the server');
    } finally {
      await rebind.close();
    }
  });

  test('unresolvable hostnames produce a safe 502', async () => {
    const res = await get('/p/http/nx.test/');
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /could not be found/);
    assert.doesNotMatch(res.body, /ENOTFOUND|getaddrinfo/);
  });

  test('user-supplied ports are never honoured, even for allowed hosts', async () => {
    for (const target of [`http://site.test:${ctx.mock.port}/`, 'http://site.test:8080/', 'https://site.test:8443/', 'http://site.test:22/']) {
      const res = await get(`/open?url=${encodeURIComponent(target)}`);
      assert.equal(res.statusCode, 400, target);
      assert.match(res.body, /custom port/);
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('only http and https are supported', async () => {
    for (const target of ['ftp://site.test/', 'file:///etc/passwd', 'gopher://site.test/', 'javascript:alert(1)', 'dict://site.test/', 'ws://site.test/']) {
      const res = await get(`/open?url=${encodeURIComponent(target)}`);
      assert.ok(res.statusCode === 400, `${target}: got ${res.statusCode}`);
    }
    const res = await get('/p/ftp/site.test/');
    assert.equal(res.statusCode, 400);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('embedded credentials are refused', async () => {
    const res = await get(`/open?url=${encodeURIComponent('http://user:pass@site.test/')}`);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /username or password/);
  });

  test('redirects to private / blocked / ported destinations are stopped', async () => {
    for (const path of ['/p/http/site.test/redirect/blocked', '/p/http/site.test/redirect/private', '/p/http/site.test/redirect/port']) {
      const res = await get(path);
      assert.equal(res.statusCode, 403, path);
      assert.equal(res.headers.location, undefined, 'no Location header leaks through');
    }
    // the redirecting server was contacted (that is fine), the targets were not
    assert.equal(ctx.mock.requests.length, 3);
    assert.ok(ctx.mock.requests.every((r) => r.path.startsWith('/redirect/')));
  });

  test('client-identifying and credential headers are not forwarded upstream', async () => {
    const res = await get('/p/http/site.test/echo-headers', {
      cookie: 'pxy_sid=forged; session=abc',
      authorization: 'Bearer secret-token',
      'x-forwarded-for': '203.0.113.5',
      'x-real-ip': '203.0.113.5',
      'cf-connecting-ip': '203.0.113.5',
      'sec-fetch-site': 'same-origin',
      'proxy-authorization': 'Basic xyz',
      'accept-language': 'de-DE',
      'user-agent': 'TestBrowser/1.0'
    });
    assert.equal(res.statusCode, 200);
    const upstreamHeaders = JSON.parse(res.body);
    for (const h of ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'sec-fetch-site', 'proxy-authorization']) {
      assert.equal(upstreamHeaders[h], undefined, `${h} must not be forwarded`);
    }
    assert.equal(upstreamHeaders['accept-language'], 'de-DE');
    assert.equal(upstreamHeaders['user-agent'], 'TestBrowser/1.0');
    assert.equal(upstreamHeaders.host, 'site.test');
    assert.match(upstreamHeaders.via, /^1\.1 anonview/);
  });

  test('the referer fallback never redirects to a non-proxied origin', async () => {
    const res = await get('/some/site/path', { referer: 'http://attacker.example/p/http/site.test/' });
    assert.equal(res.statusCode, 404);
    const res2 = await get('/some/site/path', { referer: 'http://localhost:80/p/http/blocked.example/', host: 'localhost:80' });
    assert.equal(res2.statusCode, 302);
    assert.equal(res2.headers.location, '/p/http/blocked.example/some/site/path');
    const follow = await get(res2.headers.location);
    assert.equal(follow.statusCode, 403, 'the redirect target is still validated');
  });
});
