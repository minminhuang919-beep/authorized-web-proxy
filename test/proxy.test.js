import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createTestApp, cookieHeader, cookieFromResponse } from './helpers/app.js';
import { PNG } from './helpers/mock-site.js';

describe('proxy', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp();
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });

  test('homepage renders the search-engine style form', async () => {
    const res = await get('/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /<form class="search[^"]*" method="get" action="\/open"/);
    assert.match(res.body, /class="wordmark">AnonView</);
    assert.match(res.body, /name="url"[^>]*placeholder="Enter a website or URL/);
    assert.match(res.body, /Fast private browsing for authorized websites\./);
    assert.match(res.body, /href="\/about"/);
    assert.doesNotMatch(res.body, /href="\/admin"/, 'Admin link hidden for visitors');
    assert.doesNotMatch(res.body, /No websites have been authorized/);
    assert.match(res.body, /data-theme-toggle/);
    assert.ok(res.headers['content-security-policy'], 'CSP present on own pages');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  });

  test('/open redirects a valid allowlisted address into the proxy', async () => {
    const res = await get('/open?url=site.test%2Fpage%3Fa%3D1');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/page?a=1');
  });

  test('/open explains blocked domains and invalid input', async () => {
    let res = await get('/open?url=https%3A%2F%2Fnot-allowed.example%2F');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.match(res.body, /not-allowed\.example/);
    assert.match(res.body, /not on this proxy/);
    res = await get('/open?url=');
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /enter a web address/i);
    assert.match(res.body, /search-box has-error/, 'inline error state on the homepage');
    res = await get('/open?url=http%3A%2F%2F%5Bbad');
    assert.equal(res.statusCode, 400);
    res = await get('/open?url=<script>alert(1)</script>');
    assert.equal(res.statusCode, 400);
    assert.doesNotMatch(res.body, /<script>alert/);
    assert.match(res.body, /&lt;script&gt;/);
  });

  test('a valid authorized page is fetched and rewritten', async () => {
    const res = await get('/p/http/site.test/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    const body = res.body;
    // relative + root relative + absolute + protocol relative
    assert.match(body, /id="rel" href="\/p\/http\/site\.test\/page\/sub\/index\.html"/);
    assert.match(body, /id="root" href="\/p\/http\/site\.test\/about"/);
    assert.match(body, /id="abs" href="\/p\/http\/site\.test\/contact\?x=1&amp;y=2#frag"/);
    assert.match(body, /id="cdn" href="\/p\/http\/cdn\.test\/file\.zip"/);
    assert.match(body, /id="proto" href="\/p\/http\/cdn\.test\/proto\.js"/);
    // unlisted stays direct; non-http untouched
    assert.match(body, /id="ext" href="https:\/\/blocked\.example\/page"/);
    assert.match(body, /id="mail" href="mailto:someone@example\.com"/);
    assert.match(body, /id="js" href="javascript:void\(0\)"/);
    assert.match(body, /id="hash" href="#section"/);
    // assets
    assert.match(body, /<link rel="stylesheet" href="\/p\/http\/site\.test\/style\.css">/);
    assert.match(body, /<script src="\/p\/http\/cdn\.test\/js\/app\.js"><\/script>/);
    assert.match(body, /src="\/p\/http\/site\.test\/img\.png" srcset="\/p\/http\/site\.test\/img\.png 1x, \/p\/http\/cdn\.test\/img@2x\.png 2x, \/p\/http\/cdn\.test\/img@3x\.png 3x"/);
    assert.match(body, /src="data:image\/gif;base64,R0lGODlhAQABAAAAACw="/);
    assert.match(body, /style="background: url\(&quot;\/p\/http\/site\.test\/img\/inline\.png&quot;\)"/);
    assert.match(body, /<form id="form" action="\/p\/http\/site\.test\/search" method="get">/);
    assert.match(body, /formaction="\/p\/http\/site\.test\/alt"/);
    assert.match(body, /<iframe id="frame" src="\/p\/http\/site\.test\/embed">/);
    assert.match(body, /poster="\/p\/http\/site\.test\/poster\.jpg"/);
    assert.match(body, /<source src="\/p\/http\/site\.test\/video\.mp4" type="video\/mp4">/);
    assert.match(body, /<noscript><img src="\/p\/http\/site\.test\/noscript\.gif" alt=""><\/noscript>/);
    assert.match(body, /<image href="\/p\/http\/site\.test\/vector\.svg"\/>/);
    assert.match(body, /<use xlink:href="\/p\/http\/site\.test\/sprite\.svg#icon"\/>/);
    // inline style block
    assert.match(body, /body \{ background: url\("\/p\/http\/site\.test\/img\/bg\.png"\); \}/);
    assert.match(body, /\.logo \{ background-image: url\("\/p\/http\/site\.test\/img\/logo\.png"\); \}/);
    assert.match(body, /@import "\/p\/http\/site\.test\/print\.css";/);
    // dropped things
    assert.doesNotMatch(body, /preconnect/);
    assert.doesNotMatch(body, /integrity=/);
    assert.doesNotMatch(body, /crossorigin/);
    assert.doesNotMatch(body, /ping=/);
    assert.doesNotMatch(body, /Content-Security-Policy/);
    // injected shim + banner
    assert.match(body, /<head><script>window\.__PXY__=\{"pageUrl":"http:\/\/site\.test\/","prefix":"\/p\/","mode":"direct","allowed":\[/);
    assert.match(body, /<script src="\/_\/shim\.js"><\/script>/);
    assert.match(body, /id="__pxy_banner"/);
    assert.match(body, /Viewing <b[^>]*>site\.test<\/b>/);
    // text preserved verbatim
    assert.match(body, /Body text with &lt;entities&gt; that must survive\./);
  });

  test('relative links resolve against nested page paths', async () => {
    const res = await get('/p/http/site.test/page/sub/index.html');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /id="up" href="\/p\/http\/site\.test\/page\/up\.html"/);
    assert.match(res.body, /id="same" href="\/p\/http\/site\.test\/page\/sub\/sibling\.html"/);
    assert.match(res.body, /<img src="\/p\/http\/site\.test\/page\/sub\/pic\.png">/);
  });

  test('<base href> is honoured and rewritten', async () => {
    const res = await get('/p/http/site.test/base');
    assert.match(res.body, /<base href="\/p\/http\/site\.test\/deep\/dir\/">/);
    assert.match(res.body, /href="\/p\/http\/site\.test\/deep\/dir\/s\.css"/);
    assert.match(res.body, /id="rel" href="\/p\/http\/site\.test\/deep\/dir\/a\.html"/);
  });

  test('meta refresh is rewritten', async () => {
    const res = await get('/p/http/site.test/meta-refresh');
    assert.match(res.body, /content="5; url=\/p\/http\/site\.test\/next"/);
  });

  test('a host path without trailing slash is canonicalised', async () => {
    let res = await get('/p/http/site.test');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/');
    res = await get('/p/http/SITE.test?x=1');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/?x=1');
  });

  test('wildcard allowlist entries work', async () => {
    const res = await get('/p/http/sub.wild.test/landing');
    assert.equal(res.statusCode, 200);
    assert.equal(ctx.mock.last().host, 'sub.wild.test');
  });

  test('blocked domains get a clear 403 page and are never contacted', async () => {
    const res = await get('/p/http/blocked.example/path');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /blocked\.example/);
    assert.match(res.body, /not on this proxy/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('CSS resources are rewritten and served as UTF-8 CSS', async () => {
    const res = await get('/p/http/site.test/style.css');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=3600');
    assert.equal(res.headers.etag, undefined, 'validators dropped for rewritten bodies');
    const css = res.body;
    assert.match(css, /@import "\/p\/http\/site\.test\/reset\.css";/);
    assert.match(css, /@import url\("\/p\/http\/site\.test\/theme\.css"\);/);
    assert.match(css, /src: url\("\/p\/http\/site\.test\/fonts\/a\.woff2"\) format\("woff2"\)/);
    assert.match(css, /\.a \{ background: url\("\/p\/http\/site\.test\/img\/a\.png"\); \}/);
    assert.match(css, /\.b \{ background: url\("\/p\/http\/site\.test\/img\/b\.png"\); \}/);
    assert.match(css, /\.c \{ background: url\("\/p\/http\/cdn\.test\/c\.png"\); \}/);
    assert.match(css, /\.d \{ background: url\(https:\/\/blocked\.example\/d\.png\); \}/);
    assert.match(css, /\.e \{ background: url\(data:image\/png;base64,AAAA\); \}/);
    assert.match(css, /\.f \{ background: url\("\/p\/http\/cdn\.test\/f\.png"\); \}/);
  });

  test('images are relayed byte-for-byte with their headers', async () => {
    const res = await get('/p/http/site.test/img.png');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['content-length'], String(PNG.length));
    assert.equal(res.headers.etag, '"png-1"');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
    assert.ok(res.rawPayload.equals(PNG));
  });

  test('JavaScript is passed through unchanged', async () => {
    const res = await get('/p/http/cdn.test/js/app.js');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/javascript');
    assert.equal(res.body, 'fetch("/api/data"); document.title = "<script>";');
  });

  test('gzip, brotli and deflate HTML are decoded, rewritten and served plain', async () => {
    for (const path of ['/gzip-html', '/br-html', '/deflate-html', '/raw-deflate-html']) {
      const res = await get(`/p/http/site.test${path}`, { 'accept-encoding': 'gzip, br' });
      assert.equal(res.statusCode, 200, path);
      assert.equal(res.headers['content-encoding'], undefined, path);
      assert.equal(res.headers['content-length'], undefined, path);
      assert.match(res.body, /id="root" href="\/p\/http\/site\.test\/about"/, path);
    }
    assert.equal(ctx.mock.last().headers['accept-encoding'], 'gzip, deflate, br, zstd');
  });

  test('compressed binary assets stay compressed when the client accepts it, else are decoded', async () => {
    let res = await get('/p/http/site.test/gzip-image', { 'accept-encoding': 'gzip, deflate' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(zlib.gunzipSync(res.rawPayload).equals(PNG));
    res = await get('/p/http/site.test/gzip-image', { 'accept-encoding': 'identity' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], undefined);
    assert.ok(res.rawPayload.equals(PNG));
  });

  test('legacy charsets are transcoded to UTF-8', async () => {
    const res = await get('/p/http/site.test/latin1');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.body, /café €/);
    assert.match(res.body, /<meta charset="utf-8">/);
    assert.match(res.body, /href="\/p\/http\/site\.test\/l"/);
  });

  test('XHTML is rewritten and served as HTML; fragments without <head> still get the shim', async () => {
    let res = await get('/p/http/site.test/xhtml');
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(res.body, /href="\/p\/http\/site\.test\/x"/);
    res = await get('/p/http/site.test/no-head');
    assert.match(res.body, /window\.__PXY__/);
    assert.match(res.body, /href="\/p\/http\/site\.test\/y"/);
  });

  test('redirects within the allowlist are rewritten to proxy paths', async () => {
    let res = await get('/p/http/site.test/redirect/allowed');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/landing?from=redirect');
    res = await get('/p/http/site.test/redirect/relative');
    assert.equal(res.headers.location, '/p/http/site.test/redirect/landing');
    res = await get('/p/http/site.test/redirect/absolute');
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/p/http/other.test/landing');
    res = await get('/p/http/site.test/redirect/mailto');
    assert.equal(res.headers.location, 'mailto:a@b.test');
  });

  test('a redirect to a blocked domain is stopped with an explanation', async () => {
    const res = await get('/p/http/site.test/redirect/blocked');
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers.location, undefined);
    assert.match(res.body, /blocked\.example\/secret/);
    assert.match(res.body, /redirect was stopped/);
  });

  test('upstream cookies live in a server-side jar and are replayed to the same site only', async () => {
    const first = await get('/p/http/site.test/set-cookie');
    assert.equal(first.statusCode, 200);
    const setCookies = first.headers['set-cookie'];
    const list = Array.isArray(setCookies) ? setCookies : [setCookies];
    assert.equal(list.length, 1, 'only the proxy session cookie reaches the browser');
    assert.match(list[0], /^pxy_sid=/);
    assert.match(list[0], /HttpOnly/);
    assert.match(list[0], /SameSite=Lax/);
    assert.doesNotMatch(list.join(''), /sid=abc123|pref=dark/);
    const cookie = cookieHeader(first);

    const echo = await get('/p/http/site.test/echo-cookies', { cookie });
    assert.equal(echo.statusCode, 200);
    assert.match(echo.body, /sid=abc123/);
    assert.match(echo.body, /pref=dark/);
    assert.doesNotMatch(echo.body, /other=1/, 'a cookie for a foreign domain is rejected by the jar');

    const other = await get('/p/http/other.test/echo-cookies', { cookie });
    assert.equal(other.body, 'none', 'site.test cannot plant cookies for other.test');

    const cdn = await get('/p/http/cdn.test/echo-cookies', { cookie });
    assert.equal(cdn.body, 'none');

    const fresh = await get('/p/http/site.test/echo-cookies');
    assert.equal(fresh.body, 'none', 'no session → no cookies');

    const forged = await get('/p/http/site.test/echo-cookies', { cookie: 'pxy_sid=forged.signature' });
    assert.equal(forged.body, 'none', 'tampered session cookie is ignored');
    assert.equal(cookieFromResponse(forged, 'pxy_sid'), null);
  });

  test('request bodies are forwarded with method and content type', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/p/http/site.test/echo-body',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:80', referer: 'http://localhost:80/p/http/site.test/form' },
      payload: 'q=hello+world&x=1'
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'q=hello+world&x=1', length: 17 });
    const upstream = ctx.mock.last();
    assert.equal(upstream.headers.origin, 'http://site.test');
    assert.equal(upstream.headers.referer, 'http://site.test/form');
    assert.equal(upstream.headers['content-length'], '17');
  });

  test('HTTP error statuses and bodies are relayed', async () => {
    for (const code of [404, 500, 503, 418]) {
      const res = await get(`/p/http/site.test/status/${code}`);
      assert.equal(res.statusCode, code);
      assert.match(res.body, new RegExp(`status ${code}`));
      assert.equal(res.headers['x-status-test'], '1');
    }
  });

  test('a connection refused upstream becomes a friendly 502', async () => {
    const down = await createTestApp();
    const port = down.mock.port;
    await down.mock.stop();
    try {
      const res = await down.app.inject({ method: 'GET', url: '/p/http/site.test/' });
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /could not be reached/);
      assert.doesNotMatch(res.body, new RegExp(String(port)));
      assert.doesNotMatch(res.body, /ECONNREFUSED/);
    } finally {
      await down.app.close();
    }
  });

  test('an upstream that drops the connection mid-body does not crash the proxy', async () => {
    const res = await get('/p/http/site.test/abort-body').catch((err) => err);
    // Either a truncated body or a transport error is acceptable — never a crash.
    assert.ok(res instanceof Error || res.statusCode === 200);
    const after = await get('/p/http/site.test/landing');
    assert.equal(after.statusCode, 200);
  });

  test('dangerous upstream headers are stripped and safe ones kept', async () => {
    const res = await get('/p/http/site.test/');
    for (const h of ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'link', 'alt-svc', 'server']) {
      assert.equal(res.headers[h], undefined, `${h} must be stripped`);
    }
    assert.equal(res.headers['x-custom'], 'kept');
    assert.equal(res.headers['cache-control'], 'private, max-age=60');
    assert.equal(res.headers['referrer-policy'], 'same-origin');
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    const link = await get('/p/http/site.test/link-header');
    assert.equal(link.headers.link, undefined);
    assert.equal(link.headers['alt-svc'], undefined);
  });

  test('HEAD requests and bodiless statuses work', async () => {
    const head = await ctx.app.inject({ method: 'HEAD', url: '/p/http/site.test/img.png' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-type'], 'image/png');
    assert.equal(head.body, '');
    assert.equal(ctx.mock.last().method, 'HEAD');
  });

  test('content-location is rewritten and partial content is passed through untouched', async () => {
    let res = await get('/p/http/site.test/content-location');
    assert.equal(res.headers['content-location'], '/p/http/site.test/canonical');
    res = await get('/p/http/site.test/partial');
    assert.equal(res.statusCode, 206);
    assert.equal(res.body, '<p>pa');
    assert.equal(res.headers['content-range'], 'bytes 0-4/100');
  });

  test('the referer fallback redirects stray root-relative requests into the proxied site', async () => {
    let res = await get('/api/data?x=1', { referer: 'http://localhost:80/p/http/site.test/some/page' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/api/data?x=1');
    res = await get('/p/12345', { referer: 'http://localhost:80/p/http/site.test/' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/p/12345');
    res = await get('/api/data', {});
    assert.equal(res.statusCode, 404);
    res = await ctx.app.inject({ method: 'POST', url: '/api/data', headers: { referer: 'http://localhost:80/p/http/site.test/' }, payload: 'x' });
    assert.equal(res.statusCode, 404, 'only GET/HEAD are redirected');
  });

  test('unknown paths render a 404 page; errors are HTML or JSON by Accept', async () => {
    let res = await get('/definitely/not/here');
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /Page not found/);
    res = await get('/definitely/not/here', { accept: 'application/json' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(JSON.parse(res.body).error.code, 'NOT_FOUND');
  });

  test('internal errors never expose details', async () => {
    const broken = await createTestApp({
      withMock: false,
      setup(app) {
        app.get('/boom', async () => {
          throw new Error('secret internal detail ECONNRESET /etc/passwd');
        });
      }
    });
    try {
      const res = await broken.app.inject({ method: 'GET', url: '/boom' });
      assert.equal(res.statusCode, 500);
      assert.doesNotMatch(res.body, /secret internal detail/);
      assert.match(res.body, /Something went wrong/);
    } finally {
      await broken.close();
    }
  });

  test('health endpoint reports status without secrets', async () => {
    const res = await get('/health');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(body.allowlist.size, ctx.app.allowlist.size);
    assert.doesNotMatch(res.body, /secret|password/i);
  });

  test('static assets are served', async () => {
    const shim = await get('/_/shim.js');
    assert.equal(shim.statusCode, 200);
    assert.match(shim.body, /__PXY__/);
    const css = await get('/_/style.css');
    assert.equal(css.statusCode, 200);
    const fav = await get('/favicon.ico');
    assert.equal(fav.statusCode, 302);
  });
});
