/**
 * Self-hosted web search end to end: the input classification promised in the
 * specification (shortcut → URL → domain → query, never `word.com`), the
 * search route's validation, the results page states, the SearXNG provider
 * against a stand-in JSON API, the authorization → blacklist → SSRF →
 * redirect chain behind every result click, and the deployment files that
 * keep SearXNG private.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyInput, resolveInput, MAX_QUERY_LENGTH } from '../src/resolve.js';
import { createSearchProvider } from '../src/search/index.js';
import { loadConfig } from '../src/config.js';
import { createTestApp } from './helpers/app.js';
import { createMockSearch, CHAIN_RESULTS } from './helpers/mock-search.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = 'google=http://site.test/|Google|Google Search,youtube=http://site.test/landing|YouTube|Videos';
const isShortcut = (s) => ['google', 'youtube'].includes(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

describe('input classification', () => {
  test('configured shortcuts win, arbitrary words are searches, never word.com', () => {
    assert.deepEqual(classifyInput('google', { isShortcut }), { kind: 'shortcut', shortcut: 'google' });
    assert.deepEqual(classifyInput('YouTube', { isShortcut }), { kind: 'shortcut', shortcut: 'youtube' });
    assert.deepEqual(classifyInput('youtube'), { kind: 'search', query: 'youtube' }, 'without a shortcut "youtube" is a search');
    assert.deepEqual(classifyInput('geoguessr', { isShortcut }), { kind: 'search', query: 'geoguessr' });
    assert.deepEqual(classifyInput('weather', { isShortcut }), { kind: 'search', query: 'weather' });
    assert.deepEqual(classifyInput('minecraft', { isShortcut }), { kind: 'search', query: 'minecraft' });
    assert.deepEqual(classifyInput('weather today', { isShortcut }), { kind: 'search', query: 'weather today' });
    assert.deepEqual(classifyInput('best GCSE physics revision', { isShortcut }), { kind: 'search', query: 'best GCSE physics revision' });
    assert.deepEqual(classifyInput('https://example.com', { isShortcut }), { kind: 'url', value: 'https://example.com' });
    assert.deepEqual(classifyInput('example.com', { isShortcut }), { kind: 'url', value: 'example.com' });
    assert.deepEqual(classifyInput('sub.example.co.uk/path?x=1', { isShortcut }), { kind: 'url', value: 'sub.example.co.uk/path?x=1' });
    assert.deepEqual(classifyInput(''), { kind: 'empty' });
    assert.deepEqual(classifyInput('   \t '), { kind: 'empty' });
  });

  test('resolveInput enforces the maximum query length and clamps search queries', () => {
    const policy = { isAllowed: () => true, isBlacklisted: () => false };
    assert.throws(() => resolveInput('x'.repeat(300), { policy, maxLength: 256 }), /too long/);
    const long = resolveInput(`weather ${'x'.repeat(400)}`, { policy, maxLength: 4096 });
    assert.equal(long.kind, 'search');
    assert.ok(long.query.length <= MAX_QUERY_LENGTH);
    assert.throws(() => resolveInput('', { policy }), /enter a website/);
  });
});

describe('search provider abstraction', () => {
  test('the app only sees SearchProvider.search(query, options); provider settings never leak into results', async () => {
    const api = await createMockSearch().start();
    try {
      const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40), SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url });
      const provider = createSearchProvider({ config, policy: { isAllowed: () => true, isBlacklisted: () => false } });
      assert.equal(typeof provider.search, 'function');
      assert.equal(provider.enabled, true);
      assert.equal(provider.mode, 'results');
      const data = await provider.search('hockey', { page: 2 });
      assert.deepEqual(Object.keys(data).sort(), ['hasNext', 'page', 'provider', 'query', 'related', 'results', 'total']);
      assert.equal(data.page, 2);
      assert.ok(data.results.every((r) => /^https?:\/\//.test(r.url) && typeof r.title === 'string' && typeof r.snippet === 'string' && typeof r.host === 'string'));
      assert.ok(data.results.every((r) => !/<[a-z]/i.test(r.title) && !/<[a-z]/i.test(r.snippet)), 'plain text only');
      const req = api.last();
      assert.equal(req.path, '/search');
      assert.equal(req.query.format, 'json');
      assert.equal(req.query.pageno, '2');
      assert.equal(req.headers.cookie, undefined, 'no visitor cookies reach the backend');
      assert.equal(req.headers.authorization, undefined);
      assert.equal(JSON.stringify(data).includes(api.url), false, 'the backend URL never appears in the normalized response');
    } finally {
      await api.stop();
    }
  });
});

describe('GET /search end to end (SearXNG stand-in)', () => {
  let api;
  let ctx;
  before(async () => {
    api = await createMockSearch().start();
    ctx = await createTestApp({
      env: { PROXY_SITES: SITES, PROXY_BLACKLIST: 'cdn.test', SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, SEARCH_TIMEOUT: '1', SEARCH_RATE_LIMIT: '1000' }
    });
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
  const resultLinks = (body) => [...body.matchAll(/<h2 class="result-title"><a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, '&'), title: m[2] }));

  test('youtube → configured shortcut opens through the proxy without searching', async () => {
    const res = await search('youtube');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/landing');
    assert.equal(api.requests.length, 0);
  });

  test('youtube → search results when no such shortcut is configured', async () => {
    const plain = await createTestApp({ env: { SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, SEARCH_TIMEOUT: '1' } });
    try {
      const res = await plain.app.inject({ method: 'GET', url: '/search?q=youtube' });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Search results for youtube/);
      assert.match(res.body, /class="results"/);
      assert.doesNotMatch(res.body, /Web search isn't set up yet/);
      assert.doesNotMatch(res.body, /youtube\.com/);
      assert.equal(api.last().query.q, 'youtube');
    } finally {
      await plain.close();
    }
  });

  test('geoguessr, "weather today" and unknown words are searches with real results', async () => {
    for (const q of ['geoguessr', 'weather today', 'zxqv-unknown-word']) {
      const res = await search(q);
      assert.equal(res.statusCode, 200, q);
      assert.match(res.body, /class="results"/, q);
      assert.match(res.body, /result-snippet/, q);
      assert.match(res.body, /class="result-host"/, q);
      assert.doesNotMatch(res.body, /Web search isn't set up yet/);
      assert.doesNotMatch(res.body, /<h1 id="error-title">/, 'not the authorization error page');
      assert.equal(api.last().query.q, q);
    }
    assert.equal(ctx.mock.requests.length, 0, 'nothing proxied by merely searching');
  });

  test('explicit URL and domain inputs are addresses, not searches', async () => {
    let res = await search('https://site.test/landing');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/landing');
    res = await search('site.test');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/');
    res = await search('outside.example');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.equal(api.requests.length, 0);
  });

  test('empty query goes back to the homepage; whitespace-only too', async () => {
    let res = await get('/search?q=');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/');
    res = await get('/search?q=%20%20');
    assert.equal(res.statusCode, 302);
    res = await get('/search');
    assert.equal(res.statusCode, 302);
    assert.equal(api.requests.length, 0);
  });

  test('oversized query is refused before reaching the backend; long-but-valid queries are clamped', async () => {
    const huge = await search('a '.repeat(3000));
    assert.equal(huge.statusCode, 400);
    assert.equal(api.requests.length, 0);
    const long = await search(`weather ${'b'.repeat(1000)}`);
    assert.equal(long.statusCode, 200);
    assert.ok(api.last().query.q.length <= MAX_QUERY_LENGTH);
  });

  test('search backend unavailable → "Search is temporarily unavailable", no internals leaked', async () => {
    const dead = await createTestApp({ env: { SEARCH_PROVIDER: 'searxng', SEARXNG_URL: 'http://127.0.0.1:1', SEARCH_TIMEOUT: '1' } });
    try {
      const res = await dead.app.inject({ method: 'GET', url: '/search?q=hockey' });
      assert.equal(res.statusCode, 502);
      assert.match(res.body, /Search is temporarily unavailable/);
      assert.match(res.body, /Try again/);
      assert.doesNotMatch(res.body, /127\.0\.0\.1:1|ECONNREFUSED|at .*\.js:\d+/, 'no internal URL or stack trace');
    } finally {
      await dead.close();
    }
    const failing = await search('fail');
    assert.equal(failing.statusCode, 502);
    assert.match(failing.body, /Search is temporarily unavailable/);
    assert.doesNotMatch(failing.body, /boom/);
    const slow = await search('slow');
    assert.equal(slow.statusCode, 504);
    assert.match(slow.body, /Search is temporarily unavailable/);
  });

  test('empty result set gets the empty state', async () => {
    const res = await search('empty');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /No results for/);
  });

  test('pagination links and page clamping', async () => {
    let res = await search('hockey');
    assert.match(res.body, /rel="next"/);
    assert.doesNotMatch(res.body, /rel="prev"/);
    res = await search('hockey', '&page=2');
    assert.match(res.body, /rel="prev"/);
    assert.equal(api.last().query.pageno, '2');
    res = await search('hockey', '&page=999');
    assert.equal(res.statusCode, 200);
    assert.equal(api.last().query.pageno, '10', 'clamped to MAX_PAGE');
  });

  test('every result click runs the chain: authorized → proxy, unauthorized → 403, blacklisted → 403, SSRF → 403, bad redirects → 403', async () => {
    const res = await search('chain');
    assert.equal(res.statusCode, 200);
    const links = resultLinks(res.body);
    assert.equal(links.length, CHAIN_RESULTS.length);
    assert.ok(links.every((l) => l.href.startsWith('/open?url=')), 'no result links straight to its destination');
    for (const r of CHAIN_RESULTS) assert.doesNotMatch(res.body, new RegExp(`href="${escapeRe(r.url)}"`), 'raw destination never used as href');
    const byTitle = Object.fromEntries(links.map((l) => [l.title, l.href]));

    // Follow /open (validation + redirect into the proxy) and then the proxy request itself.
    async function open(title) {
      const first = await get(byTitle[title]);
      if (first.statusCode !== 302) return first;
      return get(first.headers.location);
    }

    const authorized = await open('Authorized');
    assert.equal(authorized.statusCode, 200);
    assert.match(authorized.body, /landed/);

    const unauthorized = await open('Unauthorized');
    assert.equal(unauthorized.statusCode, 403);
    assert.match(unauthorized.body, /Website not authorized/);

    const blacklisted = await open('Blacklisted');
    assert.equal(blacklisted.statusCode, 403);
    assert.match(blacklisted.body, /Website unavailable/);

    ctx.mock.reset();
    for (const title of ['Metadata service', 'Private network', 'Loopback v6']) {
      const ssrf = await open(title);
      assert.equal(ssrf.statusCode, 403, title);
      assert.doesNotMatch(ssrf.body, /169\.254\.169\.254|10\.0\.0\.5/, 'resolved address is not disclosed');
    }
    assert.equal(ctx.mock.requests.length, 0, 'SSRF destinations were never connected to');

    for (const title of ['Redirects outside', 'Redirects to private', 'Redirects to a port']) {
      const redirected = await open(title);
      assert.equal(redirected.statusCode, 403, title);
      assert.equal(redirected.headers.location, undefined, 'the browser is never sent on');
    }
    const inside = await open('Redirects inside');
    assert.equal(inside.statusCode, 302);
    assert.equal(inside.headers.location, '/p/http/site.test/landing?from=redirect');
  });

  test('/open never searches and never guesses a domain', async () => {
    const res = await get('/open?url=geoguessr');
    assert.equal(res.statusCode, 400);
    assert.doesNotMatch(res.body, /geoguessr\.com/);
    assert.equal(api.requests.length, 0);
  });
});

describe('deployment keeps SearXNG private', () => {
  test('render.yaml: embedded SearXNG on loopback, generated secret, no second service, no maxShutdownDelaySeconds', async () => {
    const text = await fs.readFile(path.join(ROOT, 'render.yaml'), 'utf8');
    assert.equal((text.match(/^\s*-\s*type: web$/gm) || []).length, 1, 'a single web service');
    assert.doesNotMatch(text, /type: pserv/);
    assert.match(text, /- key: SEARCH_PROVIDER\s*\n\s*value: searxng/);
    assert.match(text, /- key: SEARXNG_URL\s*\n\s*value: http:\/\/127\.0\.0\.1:8888/);
    assert.match(text, /- key: SEARXNG_SECRET[^\n]*\n\s*generateValue: true/);
    assert.doesNotMatch(text, /SEARXNG_SECRET[^\n]*\n\s*value:/);
    assert.doesNotMatch(text, /maxShutdownDelaySeconds/);
  });

  test('Dockerfile and entrypoint: SearXNG bound to 127.0.0.1 only, non-root, /health kept', async () => {
    const docker = await fs.readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(docker, /^ARG SEARXNG_COMMIT=[0-9a-f]{40}$/m, 'pinned SearXNG commit');
    assert.match(docker, /searxng\/searxng\/archive\/\$\{SEARXNG_COMMIT\}\.tar\.gz/);
    assert.match(docker, /--only-binary=:all:/);
    assert.match(docker, /^USER 1000:1000$/m);
    assert.match(docker, /\/health/);
    assert.match(docker, /ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]/);
    const entry = await fs.readFile(path.join(ROOT, 'deploy/docker-entrypoint.sh'), 'utf8');
    assert.match(entry, /--host 127\.0\.0\.1/);
    assert.match(entry, /SEARXNG_BIND_ADDRESS=127\.0\.0\.1/);
    assert.match(entry, /node \/app\/src\/server\.js/);
    const settings = await fs.readFile(path.join(ROOT, 'deploy/searxng/settings.yml'), 'utf8');
    assert.match(settings, /bind_address: "127\.0\.0\.1"/);
    assert.match(settings, /^\s*- json\b/m, 'JSON API enabled for the provider');
    assert.match(settings, /public_instance: false/);
    assert.match(settings, /secret_key: "change-me-via-SEARXNG_SECRET"/);
  });

  test('docker-compose: searxng is an internal service with no published ports', async () => {
    const compose = await fs.readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const block = compose.slice(compose.indexOf('\n  searxng:'), compose.indexOf('\n  caddy:'));
    assert.match(block, /image: docker\.io\/searxng\/searxng/);
    assert.doesNotMatch(block, /^\s*ports:/m, 'never published on the host');
    assert.match(block, /networks:\s*\n\s*- internal/);
    assert.match(compose, /SEARXNG_URL: http:\/\/searxng:8080/);
    assert.match(compose, /SEARXNG_EMBEDDED: "false"/);
  });
});

describe('PROXY_ALLOWED_DOMAINS=* authorizes every website', () => {
  let api;
  let ctx;
  before(async () => {
    api = await createMockSearch().start();
    ctx = await createTestApp({ env: { PROXY_ALLOWED_DOMAINS: '*', PROXY_BLACKLIST: 'cdn.test', SEARCH_PROVIDER: 'searxng', SEARXNG_URL: api.url, SEARCH_TIMEOUT: '1' } });
  });
  after(async () => {
    await ctx.close();
    await api.stop();
  });
  const get = (url) => ctx.app.inject({ method: 'GET', url });

  test('any hostname is inside the scope; blacklist and SSRF checks still apply', async () => {
    assert.equal(ctx.app.allowlist.allowsAll, true);
    assert.equal(ctx.app.allowlist.isAllowed('anything.example'), true);
    assert.equal(ctx.app.allowlist.isAllowed('deep.sub.domain.example.co.uk'), true);
    let res = await get('/search?q=outside.example');
    assert.equal(res.statusCode, 302, 'a domain never seen before opens through the proxy');
    assert.equal(res.headers.location, '/p/https/outside.example/');
    res = await get('/open?url=http%3A%2F%2Fcdn.test%2Fasset');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website unavailable/, 'blacklist still wins');
    res = await get('/p/http/meta.test/latest/');
    assert.equal(res.statusCode, 403, 'SSRF address check still wins');
    res = await get('/open?url=http%3A%2F%2F169.254.169.254%2F');
    assert.equal(res.statusCode, 400, 'IP literals still refused');
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('search results are all marked "via proxy" except blacklisted ones; a bare word is still a search', async () => {
    let res = await get('/search?q=hockey');
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /is-unauthorized/);
    assert.match(res.body, /is-proxied/);
    assert.match(res.body, /is-blocked/);
    res = await get('/search?q=geoguessr');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Search results for geoguessr/);
    const about = await get('/about');
    assert.match(about.body, /Every website is authorized/);
  });

  test('* is only valid on its own; partial wildcards are still refused', async () => {
    assert.equal(ctx.app.allowlist.isAllowed(''), false);
    await assert.rejects(createTestApp({ withMock: false, env: { PROXY_ALLOWED_DOMAINS: 'ex*.com' } }), /invalid entry/);
    await assert.rejects(createTestApp({ withMock: false, env: { PROXY_ALLOWED_DOMAINS: '**' } }), /invalid entry/);
  });
});
