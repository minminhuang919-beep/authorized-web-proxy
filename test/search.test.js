/**
 * Web search: provider configuration, the API adapters (against a local mock
 * of the SearXNG / Brave / Google JSON shapes), the results page and its
 * states, `proxy` mode, and result linking rules (scope → blacklist).
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Allowlist } from '../src/allowlist.js';
import { Blacklist } from '../src/blacklist.js';
import { createAccessPolicy } from '../src/policy.js';
import { annotateResults, createSearchProvider, sanitizeResults, stripHtml } from '../src/search/index.js';
import { createTestApp } from './helpers/app.js';
import { createMockSearch } from './helpers/mock-search.js';

const base = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40) };

describe('search configuration', () => {
  test('search is off unless SEARCH_PROVIDER is set, and each provider validates its settings', () => {
    assert.equal(loadConfig(base).search.provider, 'none');
    assert.equal(loadConfig(base).search.configured, true, 'nothing to configure when search is off');
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'bing' }), /SEARCH_PROVIDER/);
    // A malformed value is fatal ...
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARCH_PROVIDER_URL: 'searx.example' }), /SEARCH_PROVIDER_URL must be an http/);
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARXNG_URL: 'searx.example' }), /SEARXNG_URL must be an http/);
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARCH_URL: 'searx.example' }), /http/);
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'proxy', SEARCH_PROVIDER_URL: 'https://duckduckgo.com/html/' }), /\{q\}/);
    assert.throws(() => loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARCH_URL: 'https://searx.example', SEARCH_TIMEOUT: '0' }), /SEARCH_TIMEOUT/);
    // ... a missing one only disables search, with the variable named in `reason`.
    for (const [env, name] of [
      [{ SEARCH_PROVIDER: 'searxng' }, /SEARCH_PROVIDER_URL/],
      [{ SEARCH_PROVIDER: 'proxy' }, /SEARCH_PROVIDER_URL/],
      [{ SEARCH_PROVIDER: 'brave' }, /SEARCH_API_KEY/],
      [{ SEARCH_PROVIDER: 'google', SEARCH_API_KEY: 'k' }, /SEARCH_ENGINE_ID/]
    ]) {
      const cfg = loadConfig({ ...base, ...env });
      assert.equal(cfg.search.configured, false, JSON.stringify(env));
      assert.match(cfg.search.reason, name);
    }
    // SEARCH_PROVIDER_URL is the canonical name; SEARXNG_URL (searxng only) and SEARCH_URL are aliases.
    assert.equal(loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARCH_PROVIDER_URL: 'http://127.0.0.1:8888' }).search.url, 'http://127.0.0.1:8888');
    assert.equal(loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARXNG_URL: 'http://127.0.0.1:8888' }).search.url, 'http://127.0.0.1:8888');
    assert.equal(loadConfig({ ...base, SEARCH_PROVIDER: 'searxng', SEARXNG_URL: 'http://127.0.0.1:8888', SEARCH_URL: 'http://other:1' }).search.url, 'http://127.0.0.1:8888');
    assert.equal(loadConfig({ ...base, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'k', SEARXNG_URL: 'http://127.0.0.1:8888' }).search.url, '', 'SEARXNG_URL only applies to searxng');
    const c = loadConfig({ ...base, SEARCH_PROVIDER: 'SearXNG', SEARCH_URL: 'https://searx.example/', SEARCH_TIMEOUT: '5', SEARCH_RATE_LIMIT: '7' });
    assert.deepEqual(c.search, { provider: 'searxng', url: 'https://searx.example/', apiKey: '', engineId: '', configured: true, reason: '', timeoutMs: 5000, rateLimit: 7 });
    assert.equal(loadConfig({ ...base, SEARCH_PROVIDER: 'proxy', SEARCH_PROVIDER_URL: 'https://duckduckgo.com/html/?q={q}' }).search.provider, 'proxy');
  });

  test('proxy mode refuses a search website outside the authorized scope at start-up', async () => {
    await assert.rejects(createTestApp({ withMock: false, env: { SEARCH_PROVIDER: 'proxy', SEARCH_URL: 'https://duckduckgo.com/html/?q={q}' } }), /not inside the authorized scope/);
    await assert.rejects(createTestApp({ withMock: false, env: { SEARCH_PROVIDER: 'proxy', SEARCH_URL: 'http://cdn.test/?q={q}', PROXY_BLACKLIST: 'cdn.test' } }), /blacklisted/);
  });
});

describe('result sanitising and linking', () => {
  test('stripHtml removes tags and decodes entities', () => {
    assert.equal(stripHtml('A <b>bold</b> &amp; &lt;safe&gt; &#39;quote&#x27; &nbsp; end'), "A bold & <safe> 'quote'   end".replace(/\s+/g, ' '));
    assert.equal(stripHtml(null), '');
    assert.equal(stripHtml('&#0;x&#1114112;'), 'x');
  });

  test('sanitizeResults keeps http(s) results only, as plain text, without duplicates', () => {
    const out = sanitizeResults([
      { title: '<b>One</b>', url: 'https://a.example/x#frag', snippet: 'first &amp; second' },
      { title: 'Dup', url: 'https://a.example/x', snippet: '' },
      { title: '', url: 'https://b.example/', snippet: 'x'.repeat(1000) },
      { title: 'ftp', url: 'ftp://c.example/' },
      { title: 'js', url: 'javascript:alert(1)' },
      { title: 'broken', url: 'nope' },
      null,
      { title: 'no url' }
    ]);
    assert.deepEqual(
      out.map((r) => [r.title, r.url, r.host]),
      [
        ['One', 'https://a.example/x', 'a.example'],
        ['b.example', 'https://b.example/', 'b.example']
      ]
    );
    assert.equal(out[0].snippet, 'first & second');
    assert.equal(out[1].snippet.length, 320);
    assert.equal(sanitizeResults(Array.from({ length: 50 }, (_, i) => ({ title: 't', url: `https://x.example/${i}` }))).length, 20);
  });

  test('every result opens through /open; the annotation only predicts the outcome', () => {
    const policy = createAccessPolicy({ allowlist: new Allowlist({ envDomains: ['a.example', 'b.example'] }), blacklist: new Blacklist({ envValue: 'b.example' }) });
    const results = [
      { url: 'https://a.example/x?y=1', host: 'a.example' },
      { url: 'https://b.example/', host: 'b.example' },
      { url: 'https://c.example/', host: 'c.example' },
      { url: 'https://a.example:8443/', host: 'a.example' }
    ];
    assert.deepEqual(
      annotateResults(results, { policy }).map((r) => [r.state, r.href]),
      [
        ['proxied', '/open?url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1'],
        ['blocked', '/open?url=https%3A%2F%2Fb.example%2F'],
        ['unauthorized', '/open?url=https%3A%2F%2Fc.example%2F'],
        ['unsupported', '/open?url=https%3A%2F%2Fa.example%3A8443%2F']
      ]
    );
  });

  test('the none provider is inert, and so is one that is missing a setting', async () => {
    const policy = createAccessPolicy({ allowlist: new Allowlist() });
    const provider = createSearchProvider({ config: loadConfig(base), policy });
    assert.equal(provider.enabled, false);
    assert.equal(provider.mode, 'off');
    assert.equal(provider.configured, true);
    await assert.rejects(provider.search('x'), { code: 'SEARCH_UNAVAILABLE' });

    const warnings = [];
    const incomplete = createSearchProvider({
      config: loadConfig({ ...base, SEARCH_PROVIDER: 'brave' }),
      policy,
      logger: { warn: (details, msg) => warnings.push({ details, msg }) }
    });
    assert.equal(incomplete.enabled, false);
    assert.equal(incomplete.configured, false);
    assert.match(incomplete.reason, /SEARCH_API_KEY/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].msg, /not fully configured/);
    await assert.rejects(incomplete.search('x'), { code: 'SEARCH_UNAVAILABLE' });
  });
});

describe('search providers and the results page', () => {
  let api;
  before(async () => {
    api = await createMockSearch().start();
  });
  after(() => api.stop());
  beforeEach(() => api.reset());

  async function withApp(env, fn) {
    const ctx = await createTestApp({ env: { PROXY_BLACKLIST: 'cdn.test', SEARCH_TIMEOUT: '1', ...env } });
    try {
      await fn(ctx);
    } finally {
      await ctx.close();
    }
  }
  const get = (ctx, url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });

  test('searxng: results page with proxied, unauthorized and blocked results, related searches and paging', async () => {
    await withApp({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url }, async (ctx) => {
      const home = await get(ctx, '/');
      assert.match(home.body, /data-search-enabled="1"/);
      assert.match(home.body, /placeholder="Search the web or open a configured site/);
      assert.match(home.body, /Search the web or open a configured site\./, 'tagline');
      assert.match(home.body, /anything else (to search|searches) the web/);

      const res = await get(ctx, '/search?q=best%20hockey%20drills');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.ok(res.headers['content-security-policy']);
      const body = res.body;
      assert.match(body, /<title>best hockey drills – Search · AnonView<\/title>/);
      assert.match(body, /value="best hockey drills"/, 'query stays in the box');
      assert.match(body, /About 1,234 results · via SearXNG/);
      // every result opens through /open (never a direct link); markup in titles/snippets is flattened
      assert.match(body, /<li class="result is-proxied is-top">[\s\S]*?<span class="result-kicker">Top result<\/span>[\s\S]*?<span class="result-host">site\.test<\/span> <span class="tag tag-ok"[^>]*>via proxy<\/span>[\s\S]*?<a href="\/open\?url=http%3A%2F%2Fsite\.test%2Flanding">Landing page<\/a>[\s\S]*?<p class="result-snippet">A page on the &amp; test site with markup<\/p>/);
      assert.doesNotMatch(body, /<b>page<\/b>|<em>/);
      assert.match(body, /<li class="result is-unauthorized">[\s\S]*?<span class="tag tag-warn"[^>]*>not authorized<\/span>[\s\S]*?<a href="\/open\?url=https%3A%2F%2Foutside\.example%2Fpage">Outside<\/a>/);
      assert.match(body, /<li class="result is-blocked">[\s\S]*?<span class="tag tag-danger"[^>]*>blocked<\/span>[\s\S]*?<a href="\/open\?url=http%3A%2F%2Fcdn\.test%2Fasset">CDN asset<\/a>/);
      assert.doesNotMatch(body, /href="https?:\/\//, 'no result links leave the proxy');
      assert.doesNotMatch(body, /target="_blank"/);
      // clicking results runs the full chain
      const opened = await get(ctx, '/open?url=http%3A%2F%2Fsite.test%2Flanding');
      assert.equal(opened.statusCode, 302);
      assert.equal(opened.headers.location, '/p/http/site.test/landing');
      const refused = await get(ctx, '/open?url=https%3A%2F%2Foutside.example%2Fpage');
      assert.equal(refused.statusCode, 403);
      assert.match(refused.body, /Website not authorized/);
      const blocked = await get(ctx, '/open?url=http%3A%2F%2Fcdn.test%2Fasset');
      assert.equal(blocked.statusCode, 403);
      assert.match(blocked.body, /Website unavailable/);
      // duplicates and non-http results dropped
      assert.equal((body.match(/<li class="result/g) || []).length, 3);
      assert.doesNotMatch(body, /ftp:|Broken/);
      // related searches, escaped
      assert.match(body, /Related searches/);
      assert.match(body, /<a class="chip" href="\/search\?q=hockey\+drills&amp;mode=search">hockey drills<\/a>/);
      assert.match(body, /hockey skills</);
      assert.doesNotMatch(body, /<b>skills/);
      // paging
      assert.match(body, /<span class="pager-page">Page 1<\/span>/);
      assert.match(body, /href="\/search\?q=best\+hockey\+drills&amp;page=2&amp;mode=search" rel="next"/);
      assert.doesNotMatch(body, /rel="prev"/);
      const sent = api.last();
      assert.equal(sent.path, '/search');
      assert.deepEqual(sent.query, { q: 'best hockey drills', format: 'json', pageno: '1' });

      const page2 = await get(ctx, '/search?q=best%20hockey%20drills&page=2');
      assert.match(page2.body, /Landing page \(page 2\)/);
      assert.doesNotMatch(page2.body, /Top result/, 'only on the first page');
      assert.match(page2.body, /page 2 · via SearXNG/);
      assert.match(page2.body, /rel="prev"/);
      assert.equal(api.last().query.pageno, '2');
      assert.equal(api.requests.length, 2);
      assert.equal((await get(ctx, '/search?q=x&page=99')).statusCode, 200);
      assert.equal(api.last().query.pageno, '10', 'page is clamped');
      assert.equal((await get(ctx, '/search?q=x&page=abc')).statusCode, 200);
      assert.equal(api.last().query.pageno, '1');
      assert.equal(ctx.mock.requests.length, 0, 'the proxy never fetched anything');
    });
  });

  test('searxng: empty, error, invalid JSON, rate-limited and timeout states', async () => {
    await withApp({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url }, async (ctx) => {
      let res = await get(ctx, '/search?q=empty');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /No results for “empty”/);
      assert.match(res.body, /SearXNG found nothing/);
      res = await get(ctx, '/search?q=empty&page=3');
      assert.match(res.body, /No more results/);
      res = await get(ctx, '/search?q=fail');
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /Search is temporarily unavailable/);
      assert.match(res.body, /temporarily unavailable/);
      assert.match(res.body, /href="\/search\?q=fail&amp;mode=search">Try again/);
      assert.doesNotMatch(res.body, /boom|127\.0\.0\.1/, 'no provider details leak');
      res = await get(ctx, '/search?q=badjson');
      assert.equal(res.statusCode, 502);
      res = await get(ctx, '/search?q=limited');
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /rate limiting requests/);
      res = await get(ctx, '/search?q=slow');
      assert.equal(res.statusCode, 504);
      assert.match(res.body, /took too long/);
    });
  });

  test('brave: API key header, offsets and more_results_available', async () => {
    await withApp({ SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: 'brave-secret-key', SEARCH_URL: `${api.url}/brave` }, async (ctx) => {
      const res = await get(ctx, '/search?q=hockey&page=2');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /via Brave Search/);
      assert.match(res.body, /Landing page \(page 2\)/);
      assert.match(res.body, /rel="next"/);
      const sent = api.last();
      assert.equal(sent.path, '/brave');
      assert.equal(sent.headers['x-subscription-token'], 'brave-secret-key');
      assert.equal(sent.headers.accept, 'application/json');
      assert.deepEqual(sent.query, { q: 'hockey', count: '20', offset: '1' });
      assert.doesNotMatch(res.body, /brave-secret-key/);
      const last = await get(ctx, '/search?q=hockey&page=3');
      assert.doesNotMatch(last.body, /rel="next"/, 'provider says no more results');
    });
  });

  test('google: key, cx and start parameters; total results; API key never shown', async () => {
    await withApp({ SEARCH_PROVIDER: 'google', SEARCH_API_KEY: 'google-secret-key', SEARCH_ENGINE_ID: 'cx-123', SEARCH_URL: `${api.url}/google` }, async (ctx) => {
      const res = await get(ctx, '/search?q=hockey&page=2');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /About 98,700 results · page 2 · via Google Programmable Search/);
      assert.match(res.body, /Landing page \(page 2\)/);
      const sent = api.last();
      assert.deepEqual(sent.query, { key: 'google-secret-key', cx: 'cx-123', q: 'hockey', num: '10', start: '11' });
      assert.doesNotMatch(res.body, /google-secret-key/);
      const settings = await get(ctx, '/health');
      assert.doesNotMatch(settings.body, /google-secret-key/);
    });
  });

  test('shortcuts and addresses still win over search; mode=search forces a search', async () => {
    await withApp({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, PROXY_SITES: 'google=http://site.test/|Google' }, async (ctx) => {
      let res = await get(ctx, '/search?q=google');
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, '/p/http/site.test/');
      res = await get(ctx, '/search?q=site.test');
      assert.equal(res.headers.location, '/p/https/site.test/');
      res = await get(ctx, '/search?q=google&mode=search');
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /via SearXNG/);
      assert.equal(api.last().query.q, 'google');
      res = await get(ctx, '/search?q=https%3A%2F%2Fsite.test%2F&mode=search');
      assert.equal(res.statusCode, 200);
      assert.equal(api.last().query.q, 'https://site.test/');
      const suggest = JSON.parse((await get(ctx, '/suggest?q=goo')).body);
      assert.equal(suggest.search, true);
      assert.equal(api.requests.length, 2);
    });
  });

  test('PROXY_UNLISTED_URL_MODE does not change the results page: results never link out directly', async () => {
    await withApp({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, PROXY_UNLISTED_URL_MODE: 'direct' }, async (ctx) => {
      const res = await get(ctx, '/search?q=hockey');
      assert.match(res.body, /<li class="result is-unauthorized">[\s\S]*?<a href="\/open\?url=https%3A%2F%2Foutside\.example%2Fpage">Outside<\/a>/);
      assert.doesNotMatch(res.body, /href="https:\/\/outside\.example/);
    });
  });

  test('searches are rate limited separately from the proxy', async () => {
    await withApp({ SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, SEARCH_RATE_LIMIT: '2' }, async (ctx) => {
      assert.equal((await get(ctx, '/search?q=hockey')).statusCode, 200);
      assert.equal((await get(ctx, '/search?q=hockey')).statusCode, 200);
      const limited = await get(ctx, '/search?q=hockey');
      assert.equal(limited.statusCode, 429);
      assert.match(limited.body, /Too many requests/);
      assert.equal(api.requests.length, 2);
      assert.equal((await get(ctx, '/p/http/site.test/landing')).statusCode, 200, 'proxying is unaffected');
    });
  });

  test('proxy mode opens the query on the configured search website through the proxy', async () => {
    await withApp({ SEARCH_PROVIDER: 'proxy', SEARCH_URL: 'http://site.test/search?q={q}&safe=1' }, async (ctx) => {
      const home = await get(ctx, '/');
      assert.match(home.body, /data-search-enabled="1"/);
      const res = await get(ctx, '/search?q=hello%20world%20%26%20more');
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, '/p/http/site.test/search?q=hello%20world%20%26%20more&safe=1');
      const followed = await get(ctx, res.headers.location);
      assert.equal(followed.statusCode, 404, 'the mock has no /search, but the request went to it');
      assert.equal(ctx.mock.last().url, '/search?q=hello%20world%20%26%20more&safe=1');
      // the search website is validated like any other target when the query is opened
      const about = await get(ctx, '/about');
      assert.match(about.body, /searched with <strong>site\.test<\/strong>/);
      assert.equal(api.requests.length, 0);
    });
  });
});
