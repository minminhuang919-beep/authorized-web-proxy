/**
 * Site directory (shortcuts): the model, input classification, the shortcut
 * flow through the app (authorized scope → blacklist → SSRF → redirect
 * validation) and the admin UI / JSON API.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Allowlist } from '../src/allowlist.js';
import { Blacklist } from '../src/blacklist.js';
import { createAccessPolicy } from '../src/policy.js';
import { classifyInput, resolveInput, MAX_QUERY_LENGTH } from '../src/resolve.js';
import { SiteDirectory, entryId, normalizeShortcut, parseDestination, parseShortcut, parseSitesEnv, sanitizeText } from '../src/sites.js';
import { createTestApp, cookieHeader, ADMIN_PASSWORD } from './helpers/app.js';

const ADMIN_ENV = { ADMIN_USERNAME: 'root', ADMIN_PASSWORD };

function makePolicy({ scope = ['site.test', 'cdn.test', '*.wild.test'], blacklist = 'cdn.test' } = {}) {
  return createAccessPolicy({ allowlist: new Allowlist({ envDomains: scope }), blacklist: new Blacklist({ envValue: blacklist }) });
}

describe('site directory model', () => {
  test('shortcuts are normalised case-insensitively and validated', () => {
    assert.equal(normalizeShortcut('  Google '), 'google');
    assert.equal(normalizeShortcut('GOOGLE'), 'google');
    assert.equal(normalizeShortcut('hacker-news_2'), 'hacker-news_2');
    for (const bad of ['', ' ', 'goo gle', 'google.com', '-google', 'a'.repeat(33), 'gøogle', 'http://x', null, 42]) {
      assert.equal(normalizeShortcut(bad), null, JSON.stringify(bad));
      assert.equal(parseShortcut(bad).ok, false);
    }
    assert.deepEqual(parseShortcut('YouTube'), { ok: true, shortcut: 'youtube' });
    assert.equal(sanitizeText('  Google\u0000  Search \n', 60), 'Google Search');
    assert.equal(sanitizeText('x'.repeat(100), 60).length, 60);
  });

  test('destinations are validated exactly like typed addresses, including scope and blacklist', () => {
    const policy = makePolicy();
    const ok = parseDestination('site.test/path?x=1', policy);
    assert.equal(ok.ok, true);
    assert.equal(ok.url.href, 'https://site.test/path?x=1');
    assert.equal(ok.host, 'site.test');
    assert.equal(parseDestination('HTTP://SITE.test/', policy).url.href, 'http://site.test/');
    assert.equal(parseDestination('//sub.wild.test/', policy).url.href, 'https://sub.wild.test/');
    const cases = {
      '': 'INVALID_DESTINATION',
      'http://127.0.0.1/': 'INVALID_DESTINATION',
      'http://localhost/': 'INVALID_DESTINATION',
      'http://[::1]/': 'INVALID_DESTINATION',
      'http://10.0.0.5/': 'INVALID_DESTINATION',
      'http://0x7f000001/': 'INVALID_DESTINATION',
      'http://site.test:8080/': 'INVALID_DESTINATION',
      'http://user:pw@site.test/': 'INVALID_DESTINATION',
      'ftp://site.test/': 'INVALID_DESTINATION',
      'javascript:alert(1)': 'INVALID_DESTINATION',
      'http://site.test/a b': 'INVALID_DESTINATION',
      'http://intranet.internal/': 'INVALID_DESTINATION',
      'https://outside.example/': 'DESTINATION_NOT_AUTHORIZED',
      'https://cdn.test/': 'DESTINATION_BLACKLISTED',
      'https://cdn.test/x?y=1': 'DESTINATION_BLACKLISTED',
      'https://www.cdn.test/x': 'DESTINATION_NOT_AUTHORIZED' // scope is strict and checked first
    };
    for (const [input, code] of Object.entries(cases)) {
      const r = parseDestination(input, policy);
      assert.equal(r.ok, false, input);
      assert.equal(r.code, code, input);
      assert.ok(r.error.length > 10, input);
    }
    assert.match(parseDestination('https://outside.example/', policy).error, /outside the authorized scope/);
    assert.match(parseDestination('https://cdn.test/', policy).error, /blacklisted/);
    assert.match(parseDestination('http://intranet.internal/', policy).error, /internal or special-use/);
  });

  test('PROXY_SITES parsing: format, names, descriptions, disabled marker, errors', () => {
    const { entries, errors } = parseSitesEnv('google=https://google.com|Google|Google Search, yt=youtube.com|YouTube ,!old=https://old.example,hn=https://news.ycombinator.com/?a=1|Hacker News|has|pipes');
    assert.deepEqual(errors, []);
    assert.deepEqual(entries, [
      { shortcut: 'google', destination: 'https://google.com', name: 'Google', description: 'Google Search', enabled: true },
      { shortcut: 'yt', destination: 'youtube.com', name: 'YouTube', description: '', enabled: true },
      { shortcut: 'old', destination: 'https://old.example', name: '', description: '', enabled: false },
      { shortcut: 'hn', destination: 'https://news.ycombinator.com/?a=1', name: 'Hacker News', description: 'has|pipes', enabled: true }
    ]);
    assert.equal(parseSitesEnv('nodestination').errors.length, 1);
    assert.equal(parseSitesEnv('bad shortcut=https://x.example').errors.length, 1);
    assert.throws(() => new SiteDirectory({ envValue: 'google' }), /PROXY_SITES/);
    assert.throws(() => new SiteDirectory({ envValue: 'g=http://127.0.0.1/' }), /IP addresses/);
    assert.throws(() => new SiteDirectory({ envValue: 'g=https://a.example,g=https://b.example' }), /duplicate/);
    // Out-of-scope env entries are kept (warned about at start-up) but flagged and refused on use.
    const dir = new SiteDirectory({ envValue: 'out=https://outside.example|Outside', policy: makePolicy() });
    assert.equal(dir.list()[0].status, 'unauthorized');
    assert.equal(dir.list()[0].source, 'env');
    assert.deepEqual(dir.featured(), [], 'not featured');
    assert.deepEqual(dir.suggest('out'), [], 'not suggested');
    assert.ok(dir.resolve('out'), 'still resolvable so the visitor sees why it is refused');
  });

  test('add / duplicate / update / rename clash / toggle / remove / locked env entries', async () => {
    const dir = new SiteDirectory({ envValue: 'site=http://site.test/|Site', policy: makePolicy() });
    const added = await dir.add({ name: '  Wild  ', shortcut: 'Wild', destination: 'sub.wild.test/start', description: 'A wild site' });
    assert.equal(added.ok, true);
    assert.equal(added.entry.shortcut, 'wild');
    assert.equal(added.entry.name, 'Wild');
    assert.equal(added.entry.destination, 'https://sub.wild.test/start');
    assert.equal(added.entry.host, 'sub.wild.test');
    assert.equal(added.entry.enabled, true);
    assert.equal(added.entry.status, 'ok');
    assert.equal(added.entry.source, 'admin');
    assert.match(added.entry.addedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(added.entry.id, entryId('wild'));

    const dup = await dir.add({ name: 'Again', shortcut: 'WILD', destination: 'https://sub.wild.test/' });
    assert.deepEqual([dup.ok, dup.status, dup.code], [false, 409, 'DUPLICATE']);
    const dupEnv = await dir.add({ name: 'Again', shortcut: 'site', destination: 'https://site.test/' });
    assert.equal(dupEnv.status, 409);
    const badShortcut = await dir.add({ name: 'x', shortcut: 'no spaces', destination: 'https://site.test/' });
    assert.deepEqual([badShortcut.status, badShortcut.code], [400, 'INVALID_SHORTCUT']);
    const badDest = await dir.add({ name: 'x', shortcut: 'loop', destination: 'http://127.0.0.1/' });
    assert.deepEqual([badDest.status, badDest.code], [400, 'INVALID_DESTINATION']);
    const outside = await dir.add({ name: 'x', shortcut: 'out', destination: 'https://outside.example/' });
    assert.deepEqual([outside.status, outside.code], [400, 'DESTINATION_NOT_AUTHORIZED']);
    const blocked = await dir.add({ name: 'x', shortcut: 'cdn', destination: 'https://cdn.test/' });
    assert.deepEqual([blocked.status, blocked.code], [400, 'DESTINATION_BLACKLISTED']);
    const noName = await dir.add({ shortcut: 'plain', destination: 'https://site.test/plain' });
    assert.equal(noName.entry.name, 'Plain', 'name defaults to the capitalised shortcut');

    // update: partial fields, destination always re-validated
    const renamed = await dir.update(added.entry.id, { shortcut: 'wilder', description: '' });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.entry.shortcut, 'wilder');
    assert.equal(renamed.entry.destination, 'https://sub.wild.test/start');
    assert.equal(dir.resolve('wild'), null);
    assert.equal(dir.resolve('WILDER').shortcut, 'wilder');
    const clash = await dir.update(renamed.entry.id, { shortcut: 'plain' });
    assert.deepEqual([clash.ok, clash.status], [false, 409]);
    const same = await dir.update(renamed.entry.id, { shortcut: 'WILDER', name: 'Wilder' });
    assert.equal(same.ok, true, 'renaming to the same shortcut is not a clash');
    const badUpdate = await dir.update(renamed.entry.id, { destination: 'https://cdn.test/' });
    assert.deepEqual([badUpdate.ok, badUpdate.code], [false, 'DESTINATION_BLACKLISTED']);
    const missing = await dir.update('0123456789abcdef', { name: 'x' });
    assert.deepEqual([missing.ok, missing.status], [false, 404]);
    const lockedUpdate = await dir.update(entryId('site'), { name: 'x' });
    assert.deepEqual([lockedUpdate.ok, lockedUpdate.status, lockedUpdate.code], [false, 403, 'LOCKED']);

    // toggle
    const off = await dir.setEnabled(renamed.entry.id, false);
    assert.equal(off.entry.enabled, false);
    assert.equal(dir.has('wilder'), false);
    assert.equal(dir.resolve('wilder'), null, 'disabled shortcuts do not resolve');
    assert.equal(dir.enabledCount, 2);
    assert.deepEqual(dir.suggest('wil'), [], 'disabled shortcuts are not suggested');
    const on = await dir.setEnabled(renamed.entry.id, '1');
    assert.equal(on.entry.enabled, true);
    assert.equal(dir.has('WILDER'), true);

    // remove
    const lockedRemove = await dir.remove(entryId('site'));
    assert.deepEqual([lockedRemove.ok, lockedRemove.status], [false, 403]);
    assert.equal((await dir.remove('nope')).status, 404);
    const removed = await dir.remove(renamed.entry.id);
    assert.equal(removed.ok, true);
    assert.equal(dir.resolve('wilder'), null);
    assert.equal(dir.size, 2);
  });

  test('list filter, suggestions ranking, featured order and export round-trip', async () => {
    const dir = new SiteDirectory({ envValue: 'google=https://site.test/|Google|Google Search,yt=http://site.test/yt|YouTube,!old=https://site.test/old|Old', policy: makePolicy() });
    await dir.add({ name: 'Wild Goose', shortcut: 'goose', destination: 'https://a.wild.test/' });
    await dir.add({ name: 'Go Board', shortcut: 'baduk', destination: 'https://b.wild.test/' });
    assert.deepEqual(
      dir.list().map((e) => e.shortcut),
      ['baduk', 'google', 'goose', 'old', 'yt'],
      'alphabetical'
    );
    assert.deepEqual(dir.list({ q: 'GOOGLE' }).map((e) => e.shortcut), ['google']);
    assert.deepEqual(dir.list({ q: 'wild.test' }).map((e) => e.shortcut), ['baduk', 'goose']);
    assert.deepEqual(dir.list({ q: 'search' }).map((e) => e.shortcut), ['google'], 'description is searchable');
    // shortcut prefix, then name prefix, then name word, then substring
    assert.deepEqual(dir.suggest('go').map((s) => s.shortcut), ['google', 'goose', 'baduk']);
    assert.deepEqual(dir.suggest('GOO').map((s) => s.shortcut), ['google', 'goose']);
    assert.deepEqual(dir.suggest('tube').map((s) => s.shortcut), ['yt']);
    assert.deepEqual(dir.suggest('wild').map((s) => s.shortcut), ['goose', 'baduk'], 'name prefix before host label');
    assert.deepEqual(dir.suggest('b').map((s) => s.shortcut), ['baduk'], 'single letters only match prefixes');
    assert.deepEqual(dir.suggest('oog').map((s) => s.shortcut), ['google'], 'substrings from 3 characters');
    assert.deepEqual(dir.suggest('oo').map((s) => s.shortcut), [], 'but not shorter');
    assert.deepEqual(dir.suggest(''), []);
    assert.deepEqual(dir.suggest('zzz'), []);
    assert.equal(dir.suggest('g', 1).length, 1);
    assert.deepEqual(dir.suggest('go')[0], { name: 'Google', shortcut: 'google', host: 'site.test', description: 'Google Search' });
    assert.deepEqual(
      dir.featured(3).map((s) => s.shortcut),
      ['google', 'yt', 'goose'],
      'configuration order, enabled only, capped'
    );

    const exported = dir.exportEnvValue();
    // a name that equals the default (capitalised shortcut) is omitted, as is an empty description
    assert.equal(exported, 'google=https://site.test/|Google|Google Search,yt=http://site.test/yt|YouTube,!old=https://site.test/old,goose=https://a.wild.test/|Wild Goose,baduk=https://b.wild.test/|Go Board');
    const again = new SiteDirectory({ envValue: exported, policy: makePolicy() });
    assert.deepEqual(
      again.list().map((e) => [e.shortcut, e.name, e.destination, e.description, e.enabled]),
      dir.list().map((e) => [e.shortcut, e.name, e.destination, e.description, e.enabled])
    );
    await dir.add({ name: 'Commas, pipes|and more', shortcut: 'odd', destination: 'https://c.wild.test/?a=1,2|3' });
    const roundTrip = new SiteDirectory({ envValue: dir.exportEnvValue(), policy: makePolicy() });
    assert.equal(roundTrip.resolve('odd').destination, 'https://c.wild.test/?a=1%2C2%7C3');
    assert.equal(roundTrip.resolve('odd').name, 'Commas; pipes;and more');
  });

  test('status follows blacklist and scope changes made at runtime', async () => {
    const allowlist = new Allowlist({ envDomains: ['site.test'] });
    const blacklist = new Blacklist({ envValue: '' });
    const policy = createAccessPolicy({ allowlist, blacklist });
    const dir = new SiteDirectory({ policy });
    await allowlist.add('later.example');
    const a = await dir.add({ name: 'Later', shortcut: 'later', destination: 'https://later.example/' });
    assert.equal(a.entry.status, 'ok');
    await blacklist.add({ domain: 'later.example' });
    assert.equal(dir.getById(a.entry.id).status, 'blacklisted');
    assert.deepEqual(dir.featured(), []);
    const edit = await dir.update(a.entry.id, { name: 'Renamed' });
    assert.deepEqual([edit.ok, edit.code], [false, 'DESTINATION_BLACKLISTED'], 'saving re-validates the existing destination');
    await blacklist.remove(blacklist.list()[0].id);
    assert.equal(dir.getById(a.entry.id).status, 'ok');
    await allowlist.remove('later.example');
    assert.equal(dir.getById(a.entry.id).status, 'unauthorized');
  });

  test('file persistence survives a reload; memory mode never writes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anonview-sites-'));
    const file = path.join(dir, 'sites.json');
    try {
      const policy = makePolicy();
      const a = await new SiteDirectory({ envValue: 'site=http://site.test/', filePath: file, policy }).load();
      await a.add({ name: 'Saved', shortcut: 'saved', destination: 'https://x.wild.test/', description: 'kept', enabled: false });
      const b = await new SiteDirectory({ envValue: 'site=http://site.test/', filePath: file, policy }).load();
      const saved = b.list().find((e) => e.shortcut === 'saved');
      assert.equal(saved.destination, 'https://x.wild.test/');
      assert.equal(saved.description, 'kept');
      assert.equal(saved.enabled, false);
      assert.equal(saved.source, 'admin');
      assert.equal(b.list().find((e) => e.shortcut === 'site').source, 'env');
      await fs.writeFile(file, JSON.stringify({ entries: [{ shortcut: 'ok', destination: 'https://y.wild.test/' }, { shortcut: 'bad one', destination: 'https://z.wild.test/' }, { shortcut: 'ip', destination: 'http://10.0.0.1/' }, { shortcut: 'site', destination: 'https://other.test/' }] }));
      const c = await new SiteDirectory({ envValue: 'site=http://site.test/', filePath: file, policy }).load();
      assert.deepEqual(c.list().map((e) => [e.shortcut, e.destination]), [
        ['ok', 'https://y.wild.test/'],
        ['site', 'http://site.test/']
      ]);
      await fs.writeFile(file, '{not json');
      await assert.rejects(new SiteDirectory({ filePath: file }).load(), /not valid JSON/);
      const mem = new SiteDirectory({ filePath: null, policy });
      assert.equal(mem.persistent, false);
      await mem.add({ name: 'Mem', shortcut: 'mem', destination: 'https://site.test/' });
      assert.equal(mem.resolve('mem').host, 'site.test');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('input classification', () => {
  const policy = makePolicy();
  const sites = new SiteDirectory({ envValue: 'google=http://site.test/|Google,!off=http://site.test/off,cdn=http://cdn.test/,out=https://outside.example/', policy });
  const isShortcut = (s) => sites.has(s);

  test('known shortcuts match case-insensitively; unknown words and phrases are searches', () => {
    for (const input of ['google', 'Google', 'GOOGLE', '  google  ']) {
      assert.deepEqual(classifyInput(input, { isShortcut }), { kind: 'shortcut', shortcut: 'google' }, input);
    }
    assert.deepEqual(classifyInput('goog', { isShortcut }), { kind: 'search', query: 'goog' });
    assert.deepEqual(classifyInput('weather today', { isShortcut }), { kind: 'search', query: 'weather today' });
    assert.deepEqual(classifyInput('  best   hockey\tdrills ', { isShortcut }), { kind: 'search', query: 'best hockey drills' });
    assert.deepEqual(classifyInput('off', { isShortcut }), { kind: 'search', query: 'off' }, 'disabled shortcut is not a shortcut');
    assert.deepEqual(classifyInput('what is 3.14?', { isShortcut }), { kind: 'search', query: 'what is 3.14?' });
    assert.deepEqual(classifyInput('3.14', { isShortcut }), { kind: 'search', query: '3.14' });
    assert.deepEqual(classifyInput('python?', { isShortcut }), { kind: 'search', query: 'python?' });
    assert.deepEqual(classifyInput('', { isShortcut }), { kind: 'empty' });
    assert.deepEqual(classifyInput('  \u0000 ', { isShortcut }), { kind: 'empty' });
  });

  test('URLs, bare domains, IP literals and local names are addresses', () => {
    for (const input of [
      'https://example.com',
      'HTTP://example.com/x',
      'http:example.com',
      '//example.com/x',
      'example.com',
      'Example.COM/path?x=1#frag',
      'sub.wild.test',
      'example.com:8080',
      'user:pw@example.com',
      'node.js',
      'randomword.com',
      '127.0.0.1',
      '127.0.0.1:8080/x',
      '[::1]',
      'localhost',
      'localhost:3000',
      'ftp://example.com',
      'mailto:a@b.example'
    ]) {
      assert.equal(classifyInput(input, { isShortcut }).kind, 'url', input);
    }
    // never guessed into a domain: bare words, dotted values without a real top-level label, `scheme:` words
    for (const input of ['geoguessr', 'randomword', 'minecraft', 'weather', 'e.g', 'v1.2', 'x.y2', 'javascript:alert(1)', 're:invent', 'geoguessr/maps']) {
      assert.equal(classifyInput(input, { isShortcut }).kind, 'search', input);
    }
    assert.deepEqual(classifyInput('Example.COM/path', { isShortcut }), { kind: 'url', value: 'Example.COM/path' });
  });

  test('resolveInput runs the full validation chain for shortcuts and addresses', () => {
    const opts = { sites, policy };
    let r = resolveInput('GOOGLE', opts);
    assert.equal(r.kind, 'site');
    assert.equal(r.entry.shortcut, 'google');
    assert.equal(r.target.href, 'http://site.test/');
    r = resolveInput('site.test/page?a=1', opts);
    assert.equal(r.kind, 'url');
    assert.equal(r.target.href, 'https://site.test/page?a=1');
    r = resolveInput('  latest physics revision topics ', opts);
    assert.deepEqual(r, { kind: 'search', query: 'latest physics revision topics' });
    assert.deepEqual(resolveInput('off', opts), { kind: 'search', query: 'off' }, 'disabled shortcut falls through to search');
    assert.throws(() => resolveInput('cdn', opts), { code: 'DOMAIN_BLACKLISTED' }, 'blacklisted shortcut');
    assert.throws(() => resolveInput('out', opts), { code: 'DOMAIN_NOT_ALLOWED' }, 'unauthorized shortcut');
    assert.throws(() => resolveInput('outside.example', opts), { code: 'DOMAIN_NOT_ALLOWED' });
    assert.throws(() => resolveInput('cdn.test/x', opts), { code: 'DOMAIN_BLACKLISTED' });
    assert.throws(() => resolveInput('127.0.0.1', opts), { code: 'INVALID_URL' });
    assert.throws(() => resolveInput('localhost', opts), { code: 'INVALID_URL' });
    assert.throws(() => resolveInput('site.test:8443', opts), { code: 'INVALID_URL', message: /custom port/ });
    assert.throws(() => resolveInput('localhost:3000/x', opts), { code: 'INVALID_URL' });
    assert.deepEqual(resolveInput('javascript:alert(1)', opts), { kind: 'search', query: 'javascript:alert(1)' }, 'a scheme without // is just words');
    assert.throws(() => resolveInput('javascript:alert(1)', { ...opts, openOnly: true }), { code: 'UNSUPPORTED_PROTOCOL' }, '/open semantics: an address');
    assert.throws(() => resolveInput('ftp://site.test/', opts), { code: 'UNSUPPORTED_PROTOCOL' });
    assert.throws(() => resolveInput('geoguessr', { ...opts, openOnly: true }), { code: 'INVALID_URL' }, '/open never guesses a domain');
    assert.equal(resolveInput('GOOGLE', { ...opts, openOnly: true }).kind, 'site');
    assert.throws(() => resolveInput('', opts), { code: 'INVALID_URL' });
    assert.throws(() => resolveInput('x'.repeat(5000), opts), { code: 'INVALID_URL' });
    assert.throws(() => resolveInput(42, opts), { code: 'INVALID_URL' });
    // forced search never opens anything
    assert.deepEqual(resolveInput('google', { ...opts, forceSearch: true }), { kind: 'search', query: 'google' });
    assert.deepEqual(resolveInput('https://site.test/', { ...opts, forceSearch: true }), { kind: 'search', query: 'https://site.test/' });
    assert.equal(resolveInput('word '.repeat(100), opts).query.length <= MAX_QUERY_LENGTH, true);
    // without a directory, single words are searches
    assert.deepEqual(resolveInput('google', { policy }), { kind: 'search', query: 'google' });
  });
});

describe('shortcuts through the app', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp({
      env: {
        ...ADMIN_ENV,
        PROXY_BLACKLIST: 'cdn.test|Testing',
        PROXY_SITES:
          'google=http://site.test/|Google|Google Search,landing=http://site.test/landing|Landing,!off=http://site.test/landing|Off,cdn=http://cdn.test/asset|CDN,out=https://outside.example/|Outside,evil=http://evil.test/|Evil,bounce=http://site.test/redirect/blocked|Bounce,wild=http://sub.wild.test/landing|Wild'
      }
    });
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });

  test('a known shortcut opens its destination through the proxy, whatever the case', async () => {
    for (const q of ['google', 'Google', 'GOOGLE', '%20gOoGlE%20']) {
      const res = await get(`/search?q=${q}`);
      assert.equal(res.statusCode, 302, q);
      assert.equal(res.headers.location, '/p/http/site.test/', q);
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    const open = await get('/open?url=landing');
    assert.equal(open.statusCode, 302);
    assert.equal(open.headers.location, '/p/http/site.test/landing');
    // The address bar stays on the proxy: following the redirect serves the page from here.
    const page = await get(open.headers.location);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /landed/);
    assert.equal(ctx.mock.last().host, 'site.test');
  });

  test('full URLs and bare domains still work from the same box', async () => {
    let res = await get('/search?q=https%3A%2F%2Fsite.test%2Fpage');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/page');
    res = await get('/search?q=Site.test%2Fpage%3Fa%3D1');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/https/site.test/page?a=1');
    res = await get('/search?q=outside.example');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    res = await get('/search?q=127.0.0.1');
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /IP addresses are not supported/);
    assert.match(res.body, /search-box has-error/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('an unknown word is a search, not an address; without a provider the page explains', async () => {
    const res = await get('/search?q=goog');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Web search isn.t set up yet/);
    assert.match(res.body, /“goog”/);
    assert.match(res.body, /href="\/search\?q=google"/, 'shortcuts offered as a way out');
    assert.doesNotMatch(res.body, /outside\.example|href="\/search\?q=cdn"/, 'unusable shortcuts are not offered');
    const phrase = await get('/search?q=best%20hockey%20drills');
    assert.equal(phrase.statusCode, 200);
    assert.match(phrase.body, /value="best hockey drills"/, 'the box keeps the query');
    assert.equal((await get('/search?q=')).statusCode, 302);
    assert.equal((await get('/search')).headers.location, '/');
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('a disabled shortcut is not resolved', async () => {
    const res = await get('/search?q=off');
    assert.equal(res.statusCode, 200, 'search page, not a redirect');
    assert.match(res.body, /Web search isn.t set up yet/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('a shortcut to a blacklisted destination is refused and never fetched', async () => {
    for (const url of ['/search?q=cdn', '/search?q=CDN', '/open?url=cdn']) {
      const res = await get(url);
      assert.equal(res.statusCode, 403, url);
      assert.match(res.body, /Website unavailable/);
      assert.match(res.body, /The administrator has blocked this website\./);
      assert.doesNotMatch(res.body, /Testing/, 'the reason is not disclosed');
    }
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('a shortcut pointing outside the authorized scope is refused and never fetched', async () => {
    const res = await get('/search?q=out');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.match(res.body, /outside\.example/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('SSRF: a shortcut whose host resolves to a private address is stopped at connection time', async () => {
    const res = await get('/search?q=evil');
    assert.equal(res.statusCode, 302, 'scope + blacklist pass; the address check happens on connect');
    assert.equal(res.headers.location, '/p/http/evil.test/');
    const fetched = await get(res.headers.location);
    assert.equal(fetched.statusCode, 403);
    assert.match(fetched.body, /Website not reachable/);
    assert.doesNotMatch(fetched.body, /10\.0\.0\.5/, 'the resolved address is never disclosed');
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('a redirect from a shortcut destination to an unauthorized domain is stopped', async () => {
    const res = await get('/search?q=bounce');
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/p/http/site.test/redirect/blocked');
    const followed = await get(res.headers.location);
    assert.equal(followed.statusCode, 403);
    assert.match(followed.body, /Website not authorized/);
    assert.match(followed.body, /blocked\.example\/secret/);
    assert.equal(followed.headers.location, undefined);
    assert.equal(ctx.mock.requests.length, 1, 'only the authorized hop was fetched');
  });

  test('the homepage lists usable shortcuts and the about page explains them', async () => {
    const home = await get('/');
    assert.match(home.body, /<nav class="quick-links[^"]*" aria-label="Shortcuts">/);
    assert.match(home.body, /<a class="chip chip-link" href="\/search\?q=google" title="Google Search">Google<\/a>/);
    assert.match(home.body, /href="\/search\?q=wild"/);
    assert.doesNotMatch(home.body, /href="\/search\?q=(off|cdn|out)"/, 'disabled, blacklisted and unauthorized shortcuts are hidden');
    assert.match(home.body, /Try a shortcut like <code>google<\/code>/);
    const about = await get('/about');
    assert.match(about.body, /Shortcuts/);
    assert.match(about.body, /href="\/search\?q=landing"/);
  });

  test('autocomplete only exposes usable, administrator-configured shortcuts', async () => {
    let res = await get('/suggest?q=goo');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    let body = JSON.parse(res.body);
    assert.deepEqual(body, { query: 'goo', sites: [{ name: 'Google', shortcut: 'google', host: 'site.test', description: 'Google Search' }], search: false });
    body = JSON.parse((await get('/suggest?q=GOO')).body);
    assert.equal(body.sites[0].shortcut, 'google', 'case-insensitive');
    body = JSON.parse((await get('/suggest?q=l')).body);
    assert.deepEqual(
      body.sites.map((s) => s.shortcut),
      ['landing'],
      'no disabled/blacklisted/unauthorized entries'
    );
    for (const q of ['off', 'cdn', 'out', 'outside', 'zzz', '']) {
      assert.deepEqual(JSON.parse((await get(`/suggest?q=${q}`)).body).sites, [], q);
    }
    // In scope and not blacklisted: suggested — its private address is only detectable at connection time.
    assert.deepEqual(JSON.parse((await get('/suggest?q=evil')).body).sites.map((s) => s.shortcut), ['evil']);
    assert.equal((await get(`/suggest?q=${'x'.repeat(101)}`)).statusCode, 400);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('the referer fallback does not swallow the proxy routes', async () => {
    const res = await get('/search?q=google', { referer: 'http://localhost:80/p/http/site.test/' });
    assert.equal(res.headers.location, '/p/http/site.test/');
  });
});

describe('site directory administration', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp({ env: { ...ADMIN_ENV, PROXY_SITES: 'google=http://site.test/|Google', PROXY_BLACKLIST: 'cdn.test' } });
  });
  after(() => ctx.close());

  const get = (url, headers = {}) => ctx.app.inject({ method: 'GET', url, headers });
  const form = (url, cookie, payload) => ctx.app.inject({ method: 'POST', url, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload });

  async function login() {
    const res = await ctx.app.inject({ method: 'POST', url: '/admin/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `username=root&password=${encodeURIComponent(ADMIN_PASSWORD)}` });
    assert.equal(res.statusCode, 303);
    const cookie = cookieHeader(res);
    const page = await get('/admin/sites', { cookie });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)[1];
    return { cookie, csrf };
  }

  test('the Sites page requires authentication and is linked from the admin navigation', async () => {
    const anon = await get('/admin/sites');
    assert.equal(anon.statusCode, 302);
    assert.equal(anon.headers.location, '/admin/login');
    const { cookie } = await login();
    const dash = await get('/admin', { cookie });
    assert.match(dash.body, /href="\/admin\/sites"/);
    assert.match(dash.body, /Site shortcut/);
    const page = await get('/admin/sites', { cookie });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.match(page.body, /Add a site/);
    assert.match(page.body, /name="destination"/);
    assert.match(page.body, /<code class="domain">google<\/code>/);
    assert.match(page.body, /environment/);
    assert.match(page.body, /locked/);
    assert.match(page.body, /PROXY_SITES/);
    assert.match(page.body, /aria-label="PROXY_SITES value">google=http:\/\/site\.test\/<\/textarea>/, 'export value (default name omitted)');
    assert.match(page.body, /id="confirm-dialog"/);
  });

  test('HTML forms: add, duplicate, invalid destinations, edit, toggle, delete, search filter', async () => {
    const { cookie, csrf } = await login();
    let res = await form('/admin/sites', cookie, `_csrf=${csrf}&name=Wild+Thing&shortcut=Wild&destination=sub.wild.test%2Fstart&description=A+wild+site&enabled=on`);
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin/sites');
    let page = await get('/admin/sites', { cookie });
    assert.match(page.body, /Shortcut &quot;wild&quot; now opens sub\.wild\.test/);
    assert.match(page.body, /<strong>Wild Thing<\/strong>/);
    assert.match(page.body, /A wild site/);
    assert.match(page.body, /title="https:\/\/sub\.wild\.test\/start"/);
    assert.match(page.body, /tag tag-ok">Enabled</);
    assert.equal(ctx.app.sites.resolve('wild').destination, 'https://sub.wild.test/start');
    assert.equal((await get('/search?q=WILD')).headers.location, '/p/https/sub.wild.test/start', 'usable immediately');

    // duplicate (case-insensitive) keeps the form values
    res = await form('/admin/sites', cookie, `_csrf=${csrf}&name=Other&shortcut=WILD&destination=site.test`);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /already used by Wild Thing/);
    assert.match(res.body, /value="WILD"/);
    // invalid destinations never bypass the security controls
    for (const [dest, message] of [
      ['http://127.0.0.1', 'IP addresses are not supported'],
      ['http://localhost', 'IP addresses are not supported'],
      ['http://10.0.0.1/', 'IP addresses are not supported'],
      ['http://site.test:8080/', 'custom port'],
      ['https://outside.example/', 'outside the authorized scope'],
      ['https://cdn.test/', 'is blacklisted'],
      ['ftp://site.test/', 'Only http:// and https://']
    ]) {
      res = await form('/admin/sites', cookie, `_csrf=${csrf}&name=Bad&shortcut=bad&destination=${encodeURIComponent(dest)}`);
      assert.equal(res.statusCode, 400, dest);
      assert.match(res.body, new RegExp(message), dest);
      assert.equal(ctx.app.sites.resolve('bad'), null, dest);
    }
    res = await form('/admin/sites', cookie, `_csrf=${csrf}&name=Bad&shortcut=bad+one&destination=site.test`);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /A shortcut is 1–32 characters/);

    // edit page + update
    const id = ctx.app.sites.resolve('wild').id;
    page = await get(`/admin/sites/${id}/edit`, { cookie });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Edit “Wild Thing”/);
    assert.match(page.body, /value="https:\/\/sub\.wild\.test\/start"/);
    assert.match(page.body, /name="enabled" value="on" checked/);
    res = await form(`/admin/sites/${id}`, cookie, `_csrf=${csrf}&name=Wilder&shortcut=wilder&destination=https%3A%2F%2Fsub.wild.test%2F&description=`);
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.sites.resolve('wild'), null);
    const wilder = ctx.app.sites.resolve('wilder');
    assert.equal(wilder, null, 'checkbox absent = disabled');
    assert.equal(ctx.app.sites.getById(ctx.app.sites.list().find((e) => e.shortcut === 'wilder').id).enabled, false);
    page = await get('/admin/sites', { cookie });
    assert.match(page.body, /was updated/);
    assert.match(page.body, /Disabled/);
    const wid = ctx.app.sites.list().find((e) => e.shortcut === 'wilder').id;
    res = await form(`/admin/sites/${wid}`, cookie, `_csrf=${csrf}&name=Wilder&shortcut=google&destination=https%3A%2F%2Fsub.wild.test%2F&enabled=on`);
    assert.equal(res.statusCode, 409, 'rename clash re-renders the edit page');
    assert.match(res.body, /already used by Google/);
    res = await form(`/admin/sites/${wid}`, cookie, `_csrf=${csrf}&name=Wilder&shortcut=wilder&destination=https%3A%2F%2Foutside.example%2F&enabled=on`);
    assert.equal(res.statusCode, 400);
    assert.match(res.body, /outside the authorized scope/);

    // toggle
    res = await form(`/admin/sites/${wid}/toggle`, cookie, `_csrf=${csrf}&enabled=1`);
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.sites.has('wilder'), true);
    page = await get('/admin/sites', { cookie });
    assert.match(page.body, /is now enabled/);
    assert.equal((await form(`/admin/sites/${wid}/toggle`, cookie, `_csrf=${csrf}&enabled=0`)).statusCode, 303);
    assert.equal(ctx.app.sites.has('wilder'), false);

    // env entries are locked everywhere
    const gid = entryId('google');
    res = await get(`/admin/sites/${gid}/edit`, { cookie });
    assert.equal(res.statusCode, 303);
    assert.equal((await form(`/admin/sites/${gid}/toggle`, cookie, `_csrf=${csrf}&enabled=0`)).statusCode, 303);
    assert.equal(ctx.app.sites.has('google'), true);
    assert.equal((await form(`/admin/sites/${gid}/delete`, cookie, `_csrf=${csrf}`)).statusCode, 303);
    assert.equal(ctx.app.sites.has('google'), true);
    page = await get('/admin/sites', { cookie });
    assert.match(page.body, /comes from PROXY_SITES/);

    // search filter
    page = await get('/admin/sites?q=wilder', { cookie });
    assert.match(page.body, /<strong>Wilder<\/strong>/);
    assert.doesNotMatch(page.body, /<strong>Google<\/strong>/);
    page = await get('/admin/sites?q=nothing-here', { cookie });
    assert.match(page.body, /No entries match/);

    // delete (form)
    res = await form(`/admin/sites/${wid}/delete`, cookie, `_csrf=${csrf}`);
    assert.equal(res.statusCode, 303);
    assert.equal(ctx.app.sites.list().some((e) => e.shortcut === 'wilder'), false);
    page = await get('/admin/sites', { cookie });
    assert.match(page.body, /was deleted/);
    // persisted to disk (file mode in tests)
    const file = JSON.parse(await fs.readFile(path.join(ctx.dataDir, 'sites.json'), 'utf8'));
    assert.deepEqual(file.entries, []);
    const dash = await get('/admin', { cookie });
    assert.match(dash.body, /Deleted shortcut/);
    assert.match(dash.body, /Added shortcut/);
  });

  test('JSON API: list, add, patch, enable/disable, delete, errors, locked env entries', async () => {
    const { cookie, csrf } = await login();
    const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    let res = await get('/admin/sites', { cookie, accept: 'application/json' });
    assert.equal(res.statusCode, 200);
    let body = JSON.parse(res.body);
    assert.equal(body.total, 1);
    assert.equal(body.entries[0].shortcut, 'google');
    assert.equal(body.entries[0].status, 'ok');
    assert.equal(body.persistent, true);

    res = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'Api', shortcut: 'API', destination: 'site.test/api', description: 'Added via API' } });
    assert.equal(res.statusCode, 201);
    const entry = JSON.parse(res.body).entry;
    assert.equal(entry.shortcut, 'api');
    assert.equal(entry.destination, 'https://site.test/api');
    assert.equal(entry.enabled, true);
    assert.match(entry.id, /^[0-9a-f]{16}$/);

    const dup = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'Api 2', shortcut: 'api', destination: 'site.test' } });
    assert.equal(dup.statusCode, 409);
    assert.equal(JSON.parse(dup.body).error.code, 'DUPLICATE');
    const invalid = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'x', shortcut: 'x', destination: 'http://192.168.0.1/' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(JSON.parse(invalid.body).error.code, 'INVALID_DESTINATION');
    const outside = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'x', shortcut: 'x', destination: 'https://outside.example/' } });
    assert.equal(outside.statusCode, 400);
    assert.equal(JSON.parse(outside.body).error.code, 'DESTINATION_NOT_AUTHORIZED');
    const blocked = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'x', shortcut: 'x', destination: 'https://cdn.test/' } });
    assert.equal(blocked.statusCode, 400);
    assert.equal(JSON.parse(blocked.body).error.code, 'DESTINATION_BLACKLISTED');
    const badShortcut = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'x', shortcut: 'x.y', destination: 'site.test' } });
    assert.equal(JSON.parse(badShortcut.body).error.code, 'INVALID_SHORTCUT');

    res = await ctx.app.inject({ method: 'PATCH', url: `/admin/sites/${entry.id}`, headers, payload: { enabled: false } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).entry.enabled, false);
    assert.equal(ctx.app.sites.has('api'), false);
    res = await ctx.app.inject({ method: 'PUT', url: `/admin/sites/${entry.id}`, headers, payload: { name: 'API v2', enabled: true, description: 'Renamed' } });
    assert.equal(res.statusCode, 200);
    body = JSON.parse(res.body).entry;
    assert.deepEqual([body.name, body.enabled, body.description, body.destination], ['API v2', true, 'Renamed', 'https://site.test/api']);
    res = await ctx.app.inject({ method: 'PATCH', url: `/admin/sites/${entry.id}`, headers, payload: { destination: 'https://cdn.test/' } });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, 'DESTINATION_BLACKLISTED');

    const notFound = await ctx.app.inject({ method: 'DELETE', url: '/admin/sites/0123456789abcdef', headers });
    assert.equal(notFound.statusCode, 404);
    const badId = await ctx.app.inject({ method: 'DELETE', url: '/admin/sites/not-an-id', headers });
    assert.equal(badId.statusCode, 400);
    const locked = await ctx.app.inject({ method: 'DELETE', url: `/admin/sites/${entryId('google')}`, headers });
    assert.equal(locked.statusCode, 403);
    assert.equal(JSON.parse(locked.body).error.code, 'LOCKED');
    const lockedPatch = await ctx.app.inject({ method: 'PATCH', url: `/admin/sites/${entryId('google')}`, headers, payload: { enabled: false } });
    assert.equal(lockedPatch.statusCode, 403);
    assert.equal(ctx.app.sites.has('google'), true);

    const del = await ctx.app.inject({ method: 'DELETE', url: `/admin/sites/${entry.id}`, headers });
    assert.equal(del.statusCode, 200);
    assert.equal(JSON.parse(del.body).entry.shortcut, 'api');
    assert.equal(ctx.app.sites.list().length, 1);
  });

  test('the directory shows when a destination becomes blacklisted or unauthorized', async () => {
    const { cookie, csrf } = await login();
    const headers = { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf };
    // authorize a new domain, create a shortcut for it, then blacklist / de-authorize it
    let res = await form('/admin/domains', cookie, `_csrf=${csrf}&domain=later.example`);
    assert.equal(res.statusCode, 303);
    res = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers, payload: { name: 'Later', shortcut: 'later', destination: 'https://later.example/' } });
    assert.equal(res.statusCode, 201);
    const id = JSON.parse(res.body).entry.id;
    assert.equal((await get('/search?q=later')).statusCode, 302);

    const bl = await ctx.app.inject({ method: 'POST', url: '/admin/blacklist', headers, payload: { domain: 'later.example', reason: 'test' } });
    assert.equal(bl.statusCode, 201);
    let page = await get('/admin/sites', { cookie });
    assert.match(page.body, /tag tag-danger" title="[^"]*">Blacklisted</);
    let blockedRes = await get('/search?q=later');
    assert.equal(blockedRes.statusCode, 403);
    assert.match(blockedRes.body, /Website unavailable/);
    assert.deepEqual(JSON.parse((await get('/suggest?q=lat')).body).sites, []);
    assert.doesNotMatch((await get('/')).body, /href="\/search\?q=later"/);
    await ctx.app.inject({ method: 'DELETE', url: `/admin/blacklist/${JSON.parse(bl.body).entry.id}`, headers });
    assert.equal((await get('/search?q=later')).statusCode, 302, 'usable again');

    res = await form('/admin/domains/remove', cookie, `_csrf=${csrf}&domain=later.example`);
    assert.equal(res.statusCode, 303);
    page = await get('/admin/sites', { cookie });
    assert.match(page.body, /tag tag-warn" title="[^"]*">Not authorized</);
    blockedRes = await get('/search?q=later');
    assert.equal(blockedRes.statusCode, 403);
    assert.match(blockedRes.body, /Website not authorized/);
    const json = JSON.parse((await get('/admin/sites', { cookie, accept: 'application/json' })).body);
    assert.equal(json.entries.find((e) => e.id === id).status, 'unauthorized');
    await ctx.app.inject({ method: 'DELETE', url: `/admin/sites/${id}`, headers });
  });

  test('authentication and CSRF are enforced on every state change', async () => {
    const anon = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers: { 'content-type': 'application/json' }, payload: { name: 'x', shortcut: 'anon', destination: 'site.test' } });
    assert.equal(anon.statusCode, 401);
    const { cookie } = await login();
    const noCsrf = await ctx.app.inject({ method: 'POST', url: '/admin/sites', headers: { cookie, 'content-type': 'application/json' }, payload: { name: 'x', shortcut: 'anon', destination: 'site.test' } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(JSON.parse(noCsrf.body).error.code, 'CSRF');
    const formNoCsrf = await form('/admin/sites', cookie, 'name=x&shortcut=anon&destination=site.test');
    assert.equal(formNoCsrf.statusCode, 403);
    assert.equal(ctx.app.sites.resolve('anon'), null);
    const off = await createTestApp({ withMock: false });
    try {
      assert.equal((await off.app.inject({ method: 'GET', url: '/admin/sites' })).statusCode, 404);
    } finally {
      await off.close();
    }
  });
});
