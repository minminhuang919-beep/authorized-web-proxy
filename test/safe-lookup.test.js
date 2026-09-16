import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafeLookup } from '../src/security/safe-lookup.js';
import { fakeLookup } from './helpers/app.js';

const hosts = {
  'public.test': '93.184.216.34',
  'private.test': '10.1.2.3',
  'mixed.test': ['93.184.216.34', '127.0.0.1'],
  'v6.test': ['2606:4700:4700::1111'],
  'v6loop.test': '::1',
  'empty.test': []
};

function call(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (err, ...rest) => (err ? reject(err) : resolve(rest)));
  });
}

test('public results pass through in both callback shapes', async () => {
  const lookup = createSafeLookup({ lookup: fakeLookup(hosts) });
  assert.deepEqual(await call(lookup, 'public.test', { all: true }), [[{ address: '93.184.216.34', family: 4 }]]);
  assert.deepEqual(await call(lookup, 'public.test', {}), ['93.184.216.34', 4]);
  assert.deepEqual(await call(lookup, 'v6.test', { all: true }), [[{ address: '2606:4700:4700::1111', family: 6 }]]);
});

test('private results are refused before any connection', async () => {
  const blocked = [];
  const lookup = createSafeLookup({ lookup: fakeLookup(hosts), onBlocked: (h, a) => blocked.push([h, a]) });
  await assert.rejects(call(lookup, 'private.test', { all: true }), { code: 'EBLOCKED' });
  await assert.rejects(call(lookup, 'v6loop.test', {}), { code: 'EBLOCKED' });
  assert.deepEqual(blocked, [
    ['private.test', '10.1.2.3'],
    ['v6loop.test', '::1']
  ]);
});

test('a mixed public/private answer is refused entirely (rebinding defence)', async () => {
  const lookup = createSafeLookup({ lookup: fakeLookup(hosts) });
  await assert.rejects(call(lookup, 'mixed.test', { all: true }), { code: 'EBLOCKED' });
});

test('resolver errors and empty answers propagate as errors', async () => {
  const lookup = createSafeLookup({ lookup: fakeLookup(hosts) });
  await assert.rejects(call(lookup, 'missing.test', { all: true }), { code: 'ENOTFOUND' });
  await assert.rejects(call(lookup, 'empty.test', { all: true }), { code: 'ENOTFOUND' });
});

test('the underlying resolver is consulted on every call (no caching)', async () => {
  let calls = 0;
  const flipping = (hostname, options, cb) => {
    calls++;
    const address = calls === 1 ? '93.184.216.34' : '127.0.0.1';
    cb(null, options.all ? [{ address, family: 4 }] : address, 4);
  };
  const lookup = createSafeLookup({ lookup: flipping });
  await call(lookup, 'rebind.test', { all: true });
  await assert.rejects(call(lookup, 'rebind.test', { all: true }), { code: 'EBLOCKED' });
  assert.equal(calls, 2);
});
