import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAddressAllowed, isPublicIPv4, isPublicIPv6 } from '../src/security/address.js';

const BLOCKED = [
  // loopback
  '127.0.0.1',
  '127.0.0.2',
  '127.255.255.255',
  // "this" network / unspecified
  '0.0.0.0',
  '0.1.2.3',
  // private
  '10.0.0.1',
  '10.255.255.255',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.0.1',
  '192.168.255.255',
  // carrier-grade NAT
  '100.64.0.1',
  '100.127.255.255',
  // link-local + cloud metadata
  '169.254.169.254',
  '169.254.0.1',
  // special purpose
  '192.0.0.1',
  '192.0.2.10',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '192.88.99.1',
  // multicast + reserved + broadcast
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
  // IPv6 loopback / unspecified
  '::1',
  '::',
  // IPv4-mapped / compatible forms of private addresses
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:7f00:1',
  '::127.0.0.1',
  // NAT64 wrapping private addresses
  '64:ff9b::7f00:1',
  '64:ff9b::a00:1',
  '64:ff9b:1::1',
  // unique local, link-local, site-local, multicast
  'fc00::1',
  'fd12:3456:789a::1',
  'fe80::1',
  'fe80::1%eth0',
  'fec0::1',
  'ff02::1',
  // documentation / benchmarking / Teredo / 6to4 / ORCHID / discard
  '2001:db8::1',
  '2001:2::1',
  '2001::1',
  '2002:7f00:1::1',
  '2001:10::1',
  '2001:20::1',
  '100::1',
  '3fff::1',
  '5f00::1',
  // garbage
  '',
  'localhost',
  '999.1.1.1',
  '1.2.3',
  'example.com',
  '::ffff:999.1.1.1'
];

const ALLOWED = ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '11.0.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'];

test('blocked addresses are rejected', () => {
  for (const ip of BLOCKED) {
    assert.equal(isAddressAllowed(ip), false, `${ip} should be blocked`);
  }
});

test('public addresses are accepted', () => {
  for (const ip of ALLOWED) {
    assert.equal(isAddressAllowed(ip), true, `${ip} should be allowed`);
  }
});

test('non-string input is rejected', () => {
  assert.equal(isAddressAllowed(null), false);
  assert.equal(isAddressAllowed(undefined), false);
  assert.equal(isAddressAllowed(123), false);
  assert.equal(isAddressAllowed({}), false);
});

test('helpers reject the wrong family', () => {
  assert.equal(isPublicIPv4('::1'), false);
  assert.equal(isPublicIPv6('8.8.8.8'), false);
});
