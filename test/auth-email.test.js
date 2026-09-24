/**
 * Email ("magic code") sign-in through the proxy.
 *
 * This is the site's OWN first-party flow: the site's JavaScript POSTs the
 * email address to the site's OWN backend, which emails a verification code.
 * There is no third-party identity provider and no OAuth origin check, so
 * `detectAuthFlow` leaves it alone and it can legitimately be proxied — as long
 * as the request the site built is forwarded intact.
 *
 * These tests assert the proxy forwards the site's own security headers
 * (X-Requested-With, the CSRF token) to the same site, presents the site's own
 * Origin, and relays the backend's accept/reject response unchanged — without
 * ever capturing or logging the email or the token.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createTestApp } from './helpers/app.js';

describe('email code sign-in (first-party API)', () => {
  let ctx;
  before(async () => {
    ctx = await createTestApp();
  });
  after(() => ctx.close());
  beforeEach(() => ctx.mock.reset());

  const sendCode = (headerOverrides) =>
    ctx.app.inject({
      method: 'POST',
      url: '/p/http/site.test/api/auth/email/send-code',
      headers: headerOverrides ?? {
        'content-type': 'application/json',
        // headers the site's own JS attaches to its own fetch()
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': 'site-csrf-value',
        // the browser sends the proxy's origin; the proxy must present the site's
        origin: 'http://anonview.test'
      },
      payload: JSON.stringify({ email: 'someone@example.com' })
    });

  test("the site's own CSRF and X-Requested-With headers reach its backend", async () => {
    const res = await sendCode();
    assert.equal(res.statusCode, 200);
    const seen = JSON.parse(res.body);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.sawRequestedWith, 'XMLHttpRequest');
    assert.equal(seen.sawCsrf, true);
    assert.equal(seen.hasBody, true);
    assert.equal(seen.sawContentType, 'application/json');
    // the proxy presents the site's own origin, so the backend's Origin check passes
    assert.equal(seen.origin, 'http://site.test');
    assert.equal(seen.next, 'enter-code');
  });

  test('a backend rejection is relayed to the caller, not swallowed', async () => {
    // No CSRF token at all: the backend rejects it, and the proxy passes the
    // 403 back so the site's JS can show a real error instead of doing nothing.
    const res = await sendCode({
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'http://anonview.test'
    });
    assert.equal(res.statusCode, 403);
    const seen = JSON.parse(res.body);
    assert.equal(seen.ok, false);
    assert.equal(seen.next, 'rejected');
  });
});

describe('email code sign-in does not log authentication material', () => {
  let ctx;
  let logged;
  before(async () => {
    logged = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logged += chunk.toString();
        cb();
      }
    });
    // Capture everything the app might emit, at the most verbose level.
    ctx = await createTestApp({ deps: { logger: { level: 'trace', stream } } });
  });
  after(() => ctx.close());

  test('the email address and CSRF token never reach the logs', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/p/http/site.test/api/auth/email/send-code',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'x-csrf-token': 'CSRF-canary-6f21',
        origin: 'http://anonview.test'
      },
      payload: JSON.stringify({ email: 'EMAIL-canary-9b7d@example.com' })
    });
    assert.equal(res.statusCode, 200);
    assert.ok(logged.length > 0, 'the logger did capture something at trace level');
    assert.doesNotMatch(logged, /EMAIL-canary-9b7d/, 'the email address must not be logged');
    assert.doesNotMatch(logged, /CSRF-canary-6f21/, 'the CSRF token must not be logged');
  });
});
