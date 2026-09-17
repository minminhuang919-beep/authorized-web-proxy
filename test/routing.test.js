/**
 * Search-box routing: the fixed priority configured shortcut → explicit URL →
 * domain-like → search query, proven with the concrete examples from the
 * specification, plus regression checks that the routing never weakens the
 * security boundary (a bare word is a search, never `word.com`; opening a
 * result or an address always runs authorization → blacklist → SSRF checks).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, isDomainLike } from '../src/resolve.js';
import { createTestApp } from './helpers/app.js';
import { createMockSearch } from './helpers/mock-search.js';

const SITES = 'google=http://site.test/|Google|Google Search,youtube=http://site.test/landing|YouTube|Videos,wikipedia=http://sub.wild.test/landing|Wikipedia';

describe('input classification (unit)', () => {
  const isShortcut = (s) => ['google', 'youtube', 'wikipedia'].includes(s);
  const kind = (input) => classifyInput(input, { isShortcut }).kind;

  test('the specification examples', () => {
    assert.deepEqual(classifyInput('google', { isShortcut }), { kind: 'shortcut', shortcut: 'google' });
    assert.deepEqual(classifyInput('youtube', { isShortcut }), { kind: 'shortcut', shortcut: 'youtube' });
    assert.deepEqual(classifyInput('wikipedia', { isShortcut }), { kind: 'shortcut', shortcut: 'wikipedia' });
    assert.deepEqual(classifyInput('geoguessr', { isShortcut }), { kind: 'search', query: 'geoguessr' });
    assert.deepEqual(classifyInput('weather today', { isShortcut }), { kind: 'search', query: 'weather today' });
    assert.deepEqual(classifyInput('best hockey drills', { isShortcut }), { kind: 'search', query: 'best hockey drills' });
    assert.deepEqual(classifyInput('GCSE physics electricity', { isShortcut }), { kind: 'search', query: 'GCSE physics electricity' });
    assert.deepEqual(classifyInput('minecraft building ideas', { isShortcut }), { kind: 'search', query: 'minecraft building ideas' });
    assert.deepEqual(classifyInput('randomword', { isShortcut }), { kind: 'search', query: 'randomword' });
    assert.deepEqual(classifyInput('example.com', { isShortcut }), { kind: 'url', value: 'example.com' });
    assert.deepEqual(classifyInput('example.co.uk', { isShortcut }), { kind: 'url', value: 'example.co.uk' });
    assert.deepEqual(classifyInput('subdomain.example.com', { isShortcut }), { kind: 'url', value: 'subdomain.example.com' });
    assert.deepEqual(classifyInput('randomword.com', { isShortcut }), { kind: 'url', value: 'randomword.com' });
    assert.deepEqual(classifyInput('https://example.com', { isShortcut }), { kind: 'url', value: 'https://example.com' });
    assert.deepEqual(classifyInput('http://example.com/a?b=1', { isShortcut }), { kind: 'url', value: 'http://example.com/a?b=1' });
  });

  test('words that happen to be well-known sites are searches unless configured', () => {
    for (const word of ['geoguessr', 'minecraft', 'weather', 'reddit', 'amazon', 'GeoGuessr', 'Weather']) {
      assert.equal(kind(word), 'search', word);
    }
    // the same words become shortcuts only when an administrator configured them
    assert.equal(classifyInput('reddit', { isShortcut: (s) => s === 'reddit' }).kind, 'shortcut');
    // shortcuts win over everything, case-insensitively
    for (const v of ['Google', 'GOOGLE', ' google ']) assert.equal(kind(v), 'shortcut', v);
  });

  test('only values that clearly look like a domain are domains', () => {
    for (const v of ['example.com', 'example.co.uk', 'sub.example.com', 'a-b.example', 'node.js', 'Example.COM']) assert.equal(isDomainLike(v), true, v);
    for (const v of ['geoguessr', 'e.g', 'v1.2', '3.14', 'x.y2', 'localhost', '127.0.0.1', '', 'a b.com', 'example.', '-x.com']) assert.equal(isDomainLike(v), false, v);
    assert.equal(kind('example.com/some/page?x=1'), 'url');
    assert.equal(kind('geoguessr/maps'), 'search');
    assert.equal(kind('e.g'), 'search');
    assert.equal(kind('what is 3.14?'), 'search');
  });
});

describe('routing through the search box', () => {
  let api;
  let ctx;
  before(async () => {
    api = await createMockSearch().start();
    ctx = await createTestApp({ env: { PROXY_SITES: SITES, PROXY_BLACKLIST: 'cdn.test', SEARCH_PROVIDER: 'searxng', SEARCH_URL: api.url, SEARCH_TIMEOUT: '2' } });
  });
  after(async () => {
    await ctx.close();
    await api.stop();
  });
  beforeEach(() => {
    api.reset();
    ctx.mock.reset();
  });

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });
  const search = (q, extra = '') => get(`/search?q=${encodeURIComponent(q)}${extra}`);

  test('"google" and "youtube" open the configured shortcuts through the proxy', async () => {
    let res = await search('google');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/');
    res = await search('youtube');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/landing');
    const page = await get(res.headers.location);
    assert.equal(page.statusCode, 200, 'opened through the proxy, address bar stays on the proxy');
    assert.match(page.body, /landed/);
    assert.equal(api.requests.length, 0, 'no search was performed');
  });

  test('"geoguessr" is a search query — never geoguessr.com, never "Website not authorized"', async () => {
    const res = await search('geoguessr');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Search results for geoguessr/);
    assert.match(res.body, /via SearXNG/);
    assert.doesNotMatch(res.body, /geoguessr\.com/);
    assert.doesNotMatch(res.body, /page-error|<h1 id="error-title">/, 'not the authorization error page');
    assert.equal(api.last().query.q, 'geoguessr');
    assert.equal(ctx.mock.requests.length, 0, 'nothing was proxied');
  });

  test('phrases and unknown words are search queries', async () => {
    for (const q of ['weather today', 'best hockey drills', 'GCSE physics electricity', 'minecraft building ideas', 'randomword', 'GeoGuessr']) {
      const res = await search(q);
      assert.equal(res.statusCode, 200, q);
      assert.match(res.body, /via SearXNG/, q);
      assert.doesNotMatch(res.body, /page-error|<h1 id="error-title">/, q);
      assert.equal(api.last().query.q, q, q);
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('domains and explicit URLs are addresses: authorized ones open, others get the secure 403', async () => {
    let res = await search('site.test');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/');
    res = await search('https://site.test/page?x=1');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/page?x=1');
    for (const q of ['example.com', 'randomword.com', 'https://example.com', 'http://example.co.uk/x', 'subdomain.example.com']) {
      res = await search(q);
      assert.equal(res.statusCode, 403, q);
      assert.match(res.body, /Website not authorized/, q);
      assert.doesNotMatch(res.body, /via SearXNG/, `${q} was not searched`);
    }
    assert.equal(api.requests.length, 0, 'addresses are never searched');
    assert.equal(ctx.mock.requests.length, 0, 'unauthorized addresses are never fetched');
  });

  test('a bare word never produces the authorization error even without a search provider', async () => {
    const off = await createTestApp({ withMock: false, env: { PROXY_SITES: SITES } });
    try {
      for (const q of ['geoguessr', 'randomword', 'weather today']) {
        const res = await off.app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}` });
        assert.equal(res.statusCode, 200, q);
        assert.match(res.body, /Web search isn.t set up yet/, q);
        assert.doesNotMatch(res.body, /Website not authorized|not on this proxy/, q);
      }
      assert.equal((await off.app.inject({ method: 'GET', url: '/search?q=google' })).headers.location, '/p/http/site.test/');
      assert.equal((await off.app.inject({ method: 'GET', url: '/search?q=randomword.com' })).statusCode, 403);
    } finally {
      await off.close();
    }
  });

  test('clicking a search result runs the authorization chain; unauthorized results get the secure 403', async () => {
    const res = await search('hockey');
    assert.equal(res.statusCode, 200);
    const hrefs = [...res.body.matchAll(/<h2 class="result-title"><a href="([^"]+)">/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    assert.ok(hrefs.length >= 3, 'results rendered');
    assert.ok(hrefs.every((h) => h.startsWith('/open?url=')), 'every result goes through /open on this origin');
    const [authorized, unauthorized, blacklisted] = hrefs;
    const ok = await get(authorized);
    assert.equal(ok.statusCode, 302);
    assert.equal(ok.headers.location, '/p/http/site.test/landing');
    const refused = await get(unauthorized);
    assert.equal(refused.statusCode, 403);
    assert.match(refused.body, /Website not authorized/);
    assert.match(refused.body, /outside\.example/);
    const blocked = await get(blacklisted);
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.body, /Website unavailable/);
    assert.equal(ctx.mock.requests.length, 0, 'nothing outside the scope was contacted');
  });

  test('autocomplete distinguishes configured shortcuts from search and never invents a domain', async () => {
    let body = JSON.parse((await get('/suggest?q=goo')).body);
    assert.deepEqual(body.sites.map((s) => s.shortcut), ['google']);
    assert.equal(body.search, true);
    body = JSON.parse((await get('/suggest?q=geoguessr')).body);
    assert.deepEqual(body.sites, []);
    assert.doesNotMatch(JSON.stringify(body), /geoguessr\.com/);
  });
});

describe('security regression through the search box', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp({ env: { PROXY_SITES: SITES, PROXY_BLACKLIST: 'cdn.test', MAX_RESPONSE_SIZE: '100k', MAX_REQUEST_SIZE: '1k' } });
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });
  const search = (q) => get(`/search?q=${encodeURIComponent(q)}`);
  const follow = async (q) => {
    const res = await search(q);
    assert.equal(res.statusCode, 302, `${q} passes the scope/blacklist checks and is redirected into the proxy`);
    return get(res.headers.location);
  };

  test('localhost, IP literals (v4, v6, mapped, decimal/hex) are refused before any DNS lookup', async () => {
    for (const q of ['localhost', 'localhost:8080', 'http://localhost/', '127.0.0.1', 'http://127.0.0.1/', '10.0.0.1', '192.168.1.1/admin', '169.254.169.254', 'http://0x7f000001/', 'http://2130706433/', 'http://0177.0.0.1/', '[::1]', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[64:ff9b::7f00:1]/']) {
      const res = await search(q);
      assert.equal(res.statusCode, 400, q);
      assert.doesNotMatch(res.body, /via SearXNG|Web search/, `${q} is not searched for either`);
      assert.equal((await get(`/open?url=${encodeURIComponent(q)}`)).statusCode, 400, `/open ${q}`);
    }
    // Dotless numeric/hex words are just words (a search, never an address); as explicit URLs they are refused above.
    for (const q of ['0x7f000001', '2130706433']) {
      const res = await search(q);
      assert.equal(res.statusCode, 200, q);
      assert.match(res.body, /Web search isn.t set up yet/, q);
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('hosts that resolve to private, loopback, link-local or mixed addresses are stopped at connection time', async () => {
    // evil.test → 10.0.0.5, meta.test → 169.254.169.254, loop6.test → ::1, mapped.test → ::ffff:127.0.0.1, mixed.test → public + private
    for (const q of ['evil.test', 'http://meta.test/latest/meta-data/', 'loop6.test', 'mapped.test', 'mixed.test']) {
      const res = await follow(q);
      assert.equal(res.statusCode, 403, q);
      assert.match(res.body, /Website not reachable/, q);
      assert.doesNotMatch(res.body, /10\.0\.0\.5|169\.254|::1|192\.168/, 'resolved addresses are never disclosed');
    }
    assert.equal(ctx.mock.requests.length, 0);
    // DNS rebinding across connections is exercised in test/ssrf.test.js (the lookup runs on every socket).
  });

  test('redirects from an opened page to unauthorized, private or ported destinations are stopped', async () => {
    let res = await follow('http://site.test/redirect/blocked');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.match(res.body, /blocked\.example\/secret/);
    assert.equal(res.headers.location, undefined);
    res = await follow('http://site.test/redirect/private');
    assert.equal(res.statusCode, 403);
    res = await follow('http://site.test/redirect/port');
    assert.equal(res.statusCode, 403);
    res = await follow('http://site.test/redirect/allowed');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/landing?from=redirect');
    assert.equal(ctx.mock.requests.length, 4, 'only the authorized first hops were fetched');
  });

  test('blacklist and authorization checks apply to typed domains exactly as before', async () => {
    let res = await search('cdn.test');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website unavailable/);
    res = await search('https://cdn.test/asset');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /The administrator has blocked this website/);
    res = await search('sub.cdn.test');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/, 'scope first: an unauthorized subdomain of a blacklisted host is "not authorized"');
    res = await search('randomword.com');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('response and request size limits still apply to pages reached through the box', async () => {
    const big = await follow('http://site.test/big-known?size=200000');
    assert.equal(big.statusCode, 502);
    assert.match(big.body, /Response too large/);
    const post = await ctx.app.inject({ method: 'POST', url: '/p/http/site.test/echo-body', headers: { 'content-type': 'text/plain' }, payload: 'x'.repeat(2048) });
    assert.equal(post.statusCode, 413);
  });

  test('/search has its own rate limit and the proxy limit is unchanged', async () => {
    const limited = await createTestApp({ env: { SEARCH_RATE_LIMIT: '2', RATE_LIMIT: '3' } });
    try {
      const hit = (url) => limited.app.inject({ method: 'GET', url });
      assert.equal((await hit('/search?q=randomword')).statusCode, 200);
      assert.equal((await hit('/search?q=randomword')).statusCode, 200);
      assert.equal((await hit('/search?q=randomword')).statusCode, 429);
      assert.equal((await hit('/p/http/site.test/landing')).statusCode, 200);
      assert.equal((await hit('/p/http/site.test/landing')).statusCode, 200);
      assert.equal((await hit('/p/http/site.test/landing')).statusCode, 200);
      assert.equal((await hit('/p/http/site.test/landing')).statusCode, 429);
    } finally {
      await limited.close();
    }
  });
});
