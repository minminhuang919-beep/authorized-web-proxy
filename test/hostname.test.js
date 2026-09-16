import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpecialUseHostname, normalizeHostname, parseAllowlistPattern } from '../src/security/hostname.js';
import { Allowlist } from '../src/allowlist.js';

test('normalizeHostname accepts ordinary hostnames', () => {
  assert.equal(normalizeHostname('Example.COM'), 'example.com');
  assert.equal(normalizeHostname('example.com.'), 'example.com');
  assert.equal(normalizeHostname('a-b.c-d.example'), 'a-b.c-d.example');
  assert.equal(normalizeHostname('xn--bcher-kva.example'), 'xn--bcher-kva.example');
});

test('normalizeHostname rejects IP literals and malformed names', () => {
  for (const bad of ['127.0.0.1', '[::1]', '::1', '10.0.0.1', 'localhost', '', ' ', 'exa mple.com', '-bad.com', 'bad-.com', 'a..b', '1.2.3.4.5', 'host.123', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`]) {
    assert.equal(normalizeHostname(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('special-use hostnames are flagged', () => {
  for (const h of ['foo.localhost', 'printer.local', 'db.internal', 'x.lan', 'x.home', 'x.corp', 'x.onion', '1.0.0.127.in-addr.arpa', 'x.invalid']) {
    assert.equal(isSpecialUseHostname(h), true, h);
  }
  assert.equal(isSpecialUseHostname('example.com'), false);
});

test('allowlist patterns parse and match strictly', () => {
  assert.deepEqual(parseAllowlistPattern(' Example.com '), { pattern: 'example.com', wildcard: false, host: 'example.com' });
  assert.deepEqual(parseAllowlistPattern('*.example.com'), { pattern: '*.example.com', wildcard: true, host: 'example.com' });
  assert.deepEqual(parseAllowlistPattern('https://example.com/path'), { pattern: 'example.com', wildcard: false, host: 'example.com' });
  assert.equal(parseAllowlistPattern('1.2.3.4'), null);
  assert.equal(parseAllowlistPattern('*.*.com'), null);
  assert.equal(parseAllowlistPattern('example.com:8080'), null);
  assert.equal(parseAllowlistPattern('*'), null);

  const list = new Allowlist({ envDomains: ['example.com', '*.wild.example'] });
  assert.equal(list.isAllowed('example.com'), true);
  assert.equal(list.isAllowed('EXAMPLE.com'), true);
  assert.equal(list.isAllowed('www.example.com'), false, 'exact entries do not cover subdomains');
  assert.equal(list.isAllowed('notexample.com'), false);
  assert.equal(list.isAllowed('example.com.evil.net'), false);
  assert.equal(list.isAllowed('a.wild.example'), true);
  assert.equal(list.isAllowed('a.b.wild.example'), true);
  assert.equal(list.isAllowed('wild.example'), false, 'wildcard does not cover the bare domain');
  assert.equal(list.isAllowed('xwild.example'), false);
});

test('Allowlist rejects invalid environment entries', () => {
  assert.throws(() => new Allowlist({ envDomains: ['127.0.0.1'] }), /invalid entry/);
});
