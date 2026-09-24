/**
 * End-to-end proxying of a modern, client-side-routed "gaming" site
 * (`arcade.test` in the mock), covering the URL shapes that make naive proxies
 * serve a destination site's own 404: a locale redirect on open, a `<base
 * href>`, nested game pages under a trailing slash, assets referenced
 * relatively / root-relatively / with encoded characters, a JSON data endpoint
 * with a query string, and direct navigation ("refresh") to a nested path.
 *
 * Every case also asserts, via the mock's request log, that the *upstream*
 * path and Host the proxy built are exactly what the destination expects, so a
 * mis-constructed URL surfaces as the branded 404 instead of passing silently.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, DEFAULT_HOSTS } from './helpers/app.js';
import { PNG } from './helpers/mock-site.js';

describe('proxying a client-side-routed gaming site', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp({
      env: { PROXY_ALLOWED_DOMAINS: 'arcade.test,*.arcade.test' },
      hosts: { ...DEFAULT_HOSTS, 'arcade.test': '127.0.0.1' }
    });
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });
  const lastPath = () => {
    const r = ctx.mock.last();
    return r ? r.path + (new URL('http://x' + r.url).search) : null;
  };

  test('opening the site follows its locale redirect back through the proxy', async () => {
    const res = await get('/p/http/arcade.test/');
    assert.equal(res.statusCode, 302);
    // The upstream `Location: /en` (root-relative) is resolved and re-proxied,
    // never handed to the browser as the bare upstream address.
    assert.equal(res.headers.location, '/p/http/arcade.test/en');
    assert.equal(ctx.mock.last().host, 'arcade.test');
    assert.equal(lastPath(), '/');
  });

  test('a bare host is canonicalised to a trailing slash without contacting upstream', async () => {
    const res = await get('/p/http/arcade.test');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/arcade.test/');
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('the locale home rewrites <base>, root-relative assets and base-relative nav', async () => {
    const res = await get('/p/http/arcade.test/en');
    assert.equal(res.statusCode, 200);
    assert.equal(lastPath(), '/en');
    const b = res.body;
    assert.match(b, /<base href="\/p\/http\/arcade\.test\/en\/">/);
    // root-relative assets: unaffected by <base>, always the origin root
    assert.match(b, /<link rel="stylesheet" href="\/p\/http\/arcade\.test\/assets\/main\.css">/);
    assert.match(b, /<script src="\/p\/http\/arcade\.test\/assets\/app\.js" defer=""><\/script>/);
    assert.match(b, /id="logo" src="\/p\/http\/arcade\.test\/assets\/logo\.png"/);
    // base-relative nav: `games/` resolves against <base href="/en/">
    assert.match(b, /id="all" href="\/p\/http\/arcade\.test\/en\/games\/"/);
    // root-relative nav
    assert.match(b, /id="feat" href="\/p\/http\/arcade\.test\/en\/g\/tomb-of-the-mask\/"/);
    assert.match(b, /id="home" href="\/p\/http\/arcade\.test\/en"/);
  });

  test('a listing page resolves base-relative, root-relative-encoded and query links', async () => {
    const res = await get('/p/http/arcade.test/en/games/');
    assert.equal(res.statusCode, 200);
    assert.equal(lastPath(), '/en/games/');
    const b = res.body;
    assert.match(b, /id="rel" href="\/p\/http\/arcade\.test\/en\/g\/moto-x3m\/"/);
    // an encoded space in the path survives the round trip verbatim
    assert.match(b, /id="enc" href="\/p\/http\/arcade\.test\/en\/g\/subway%20surfers\/"/);
    // query string preserved (& serialised as &amp; in the attribute)
    assert.match(b, /id="q" href="\/p\/http\/arcade\.test\/en\/g\/2048\/\?ref=list&amp;level=3"/);
  });

  test('a nested game page loads directly (refresh) with correct relative assets', async () => {
    const res = await get('/p/http/arcade.test/en/g/tomb-of-the-mask/');
    assert.equal(res.statusCode, 200);
    assert.equal(lastPath(), '/en/g/tomb-of-the-mask/');
    const b = res.body;
    // relative to the game page's own directory
    assert.match(b, /id="thumb" src="\/p\/http\/arcade\.test\/en\/g\/tomb-of-the-mask\/thumb\.png"/);
    assert.match(b, /id="play" src="\/p\/http\/arcade\.test\/en\/g\/tomb-of-the-mask\/play\.js"/);
    // `../../games/` resolves up two directories
    assert.match(b, /id="back" href="\/p\/http\/arcade\.test\/en\/games\/"/);
    // root-relative stylesheet
    assert.match(b, /href="\/p\/http\/arcade\.test\/assets\/main\.css"/);
  });

  test('an encoded slug is fetched upstream exactly as encoded', async () => {
    const res = await get('/p/http/arcade.test/en/g/subway%20surfers/');
    assert.equal(res.statusCode, 200);
    assert.equal(lastPath(), '/en/g/subway%20surfers/');
    assert.match(res.body, /<h1 id="title">subway surfers<\/h1>/);
  });

  test("the game's relative assets resolve and load", async () => {
    const js = await get('/p/http/arcade.test/en/g/tomb-of-the-mask/play.js');
    assert.equal(js.statusCode, 200);
    assert.match(js.headers['content-type'], /javascript/);
    // JavaScript is passed through untouched (never string-rewritten)
    assert.match(js.body, /fetch\("\/_data\/game\.json\?slug="/);

    const png = await get('/p/http/arcade.test/en/g/tomb-of-the-mask/thumb.png');
    assert.equal(png.statusCode, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.ok(png.rawPayload.equals(PNG));
  });

  test('stylesheet url()/@import resolve root-relative and relative', async () => {
    const res = await get('/p/http/arcade.test/assets/main.css');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    const css = res.body;
    assert.match(css, /@import "\/p\/http\/arcade\.test\/assets\/tokens\.css";/);
    assert.match(css, /url\("\/p\/http\/arcade\.test\/assets\/logo\.png"\)/);
    assert.match(css, /url\("\/p\/http\/arcade\.test\/assets\/fonts\/f\.woff2"\)/);
  });

  test('the SPA data endpoint keeps its query string intact', async () => {
    const res = await get('/p/http/arcade.test/_data/games.json?loc=en');
    assert.equal(res.statusCode, 200);
    assert.equal(lastPath(), '/_data/games.json?loc=en');
    const data = JSON.parse(res.body);
    assert.equal(data.path, '/_data/games.json');
    assert.equal(data.query, '?loc=en');
  });

  test('a genuinely missing path returns the destination 404, proving correct paths do not', async () => {
    const res = await get('/p/http/arcade.test/nope/missing');
    assert.equal(res.statusCode, 404);
    assert.equal(lastPath(), '/nope/missing');
    assert.match(res.body, /does not exist on this site/);
  });
});
