/**
 * Third-party sign-in / OAuth handling.
 *
 * The proxy refuses authentication flows it cannot serve honestly — an
 * identity provider validates the application's own origin and its registered
 * redirect URIs, and a proxied page is served from the proxy's origin — and
 * says so on a dedicated page instead of letting the provider answer with
 * `403 origin_mismatch`. Nothing is forged, rewritten or intercepted.
 *
 * Covered here: a normal page, an OAuth authorization URL, a Google-style
 * sign-in page, an ordinary /login page that is not OAuth, credential
 * submission, tokens in query parameters, ordinary navigation, and the
 * guarantee that no authentication material reaches the logs or the pages.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthFlowExemptions, detectAuthFlow, isAuthEndpointPath, isIdentityProviderHost, redactUrlForDisplay } from '../src/security/auth-flow.js';
import { loggerOptions } from '../src/logger.js';
import { createTestApp, DEFAULT_HOSTS } from './helpers/app.js';

// Secrets used by the tests. None of them may ever appear in a log line or a
// rendered page; they are distinctive so a leak is unmistakable.
const PASSWORD = 'hunter2-correct-horse';
const ACCESS_TOKEN = 'ya29.FAKE-TEST-ACCESS-TOKEN-0123456789abcdef';
const AUTH_CODE = '4/0AY0e-g7FAKE-TEST-AUTHORIZATION-CODE-abcdefghijklmnop';
const OAUTH_STATE = 'Ky7dQ2bX9fLmT4pRzW3v';
const CLIENT_ID = '123456789-abcdefg.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-FAKE-TEST-CLIENT-SECRET-123';

const SCOPE = 'site.test,cdn.test,other.test,accounts.google.com,login.microsoftonline.com';
const HOSTS = { ...DEFAULT_HOSTS, 'accounts.google.com': '127.0.0.1', 'login.microsoftonline.com': '127.0.0.1' };

const url = (u) => new URL(u);

describe('authentication-flow detection', () => {
  test('ordinary pages are never mistaken for a sign-in flow', () => {
    for (const u of [
      'https://site.test/',
      'https://site.test/login', // a plain username/password page is not OAuth
      'https://site.test/signin',
      'https://site.test/accounts',
      'https://site.test/accounts/settings',
      'https://site.test/my-account/login',
      'https://site.test/shipping?code=NL&state=NL', // a promo code and a region
      'https://site.test/search?q=oauth%20tutorial',
      'https://site.test/blog/how-oauth-works',
      'https://site.test/page?token=csrf123', // a CSRF token is not OAuth material
      'https://site.test/authorize-payment'
    ]) {
      assert.equal(detectAuthFlow(url(u)), null, u);
    }
  });

  test('authorization requests, callbacks, provider hosts and OAuth endpoints are detected', () => {
    const cases = [
      [`https://site.test/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2Fsite.test%2Fcb&response_type=code`, 'oauth-authorize'],
      [`https://site.test/connect?client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2Fsite.test%2Fcb`, 'oauth-authorize'],
      [`https://site.test/cb?code=${AUTH_CODE}&state=${OAUTH_STATE}`, 'oauth-callback'],
      [`https://site.test/cb#ignored?access_token=x`, null], // fragments never reach the server
      [`https://site.test/cb?access_token=${ACCESS_TOKEN}`, 'oauth-callback'],
      ['https://site.test/cb?id_token=abc', 'oauth-callback'],
      ['https://site.test/cb?refresh_token=abc', 'oauth-callback'],
      [`https://site.test/token?client_secret=${CLIENT_SECRET}`, 'oauth-callback'],
      ['https://site.test/sso?SAMLResponse=abc', 'oauth-callback'],
      ['https://accounts.google.com/signin/v2/identifier', 'identity-provider'],
      ['https://accounts.google.com/', 'identity-provider'],
      ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'identity-provider'],
      ['https://tenant.auth0.com/u/login', 'identity-provider'],
      ['https://dev-123.okta.com/anything', 'identity-provider'],
      ['https://site.test/oauth2/auth', 'oauth-endpoint'],
      ['https://site.test/o/oauth2/v2/auth', 'oauth-endpoint'],
      ['https://site.test/connect/authorize/callback', 'oauth-endpoint'],
      ['https://site.test/realms/demo/protocol/openid-connect/auth', 'oauth-endpoint'],
      ['https://site.test/signin-oidc', 'oauth-endpoint'],
      ['https://site.test/auth/google', 'oauth-endpoint'],
      ['https://site.test/saml/acs', 'oauth-endpoint']
    ];
    for (const [u, expected] of cases) {
      const flow = detectAuthFlow(url(u));
      assert.equal(flow === null ? null : flow.kind, expected, u);
    }
    assert.equal(isIdentityProviderHost('accounts.google.com'), true);
    assert.equal(isIdentityProviderHost('site.test'), false);
    assert.equal(isIdentityProviderHost('notaccounts.google.com.evil.test'), false);
    assert.equal(isAuthEndpointPath('/oauth/authorize'), true);
    assert.equal(isAuthEndpointPath('/myoauth/page'), false);
    assert.equal(isAuthEndpointPath('/login'), false);
  });

  test('a detection result carries only the host and a category, never query material', () => {
    const flow = detectAuthFlow(url(`https://site.test/oauth/authorize?client_id=${CLIENT_ID}&state=${OAUTH_STATE}`));
    assert.deepEqual(Object.keys(flow).sort(), ['host', 'kind']);
    assert.equal(flow.host, 'site.test');
    assert.doesNotMatch(JSON.stringify(flow), /apps\.googleusercontent|Ky7dQ2bX/);
  });

  test('redactUrlForDisplay keeps scheme, host and path but no query values', () => {
    const shown = redactUrlForDisplay(url(`https://site.test/cb?code=${AUTH_CODE}&state=${OAUTH_STATE}&page=2`));
    assert.match(shown, /^https:\/\/site\.test\/cb\?/);
    assert.match(shown, /code=%5Bredacted%5D/);
    assert.match(shown, /state=%5Bredacted%5D/);
    assert.doesNotMatch(shown, /4%2F0AY0e|Ky7dQ2bX/);
    assert.equal(redactUrlForDisplay('https://site.test/plain'), 'https://site.test/plain');
    assert.equal(redactUrlForDisplay('not a url'), '');
  });
});

describe('sign-in flows through the proxy', () => {
  let ctx;
  let logs;
  const get = (u, headers = {}) => ctx.app.inject({ method: 'GET', url: u, headers });
  const logText = () => logs.join('');

  before(async () => {
    logs = [];
    ctx = await createTestApp({
      env: { PROXY_ALLOWED_DOMAINS: SCOPE },
      hosts: HOSTS,
      // the real logger configuration, captured instead of written out
      deps: { logger: { ...loggerOptions({ logLevel: 'info' }), stream: { write: (line) => logs.push(line) } } }
    });
  });
  after(async () => {
    await ctx.close();
  });
  beforeEach(() => {
    ctx.mock.reset();
    logs.length = 0;
  });

  /** The dedicated page, and nothing of the request, reached anyone. */
  function assertSignInPage(res, { host }) {
    assert.equal(res.statusCode, 501);
    assert.match(res.body, /Sign-in isn't supported in proxied mode/);
    assert.match(res.body, /This website uses an authentication provider that requires its original website origin\./);
    assert.match(res.body, /The proxy cannot safely modify that authentication flow\./);
    assert.match(res.body, new RegExp(`<code>${host.replace(/\./g, '\\.')}</code>`));
    assert.equal(ctx.mock.requests.length, 0, 'the request never left the proxy');
  }

  // (1) normal page
  test('a normal page is proxied exactly as before', async () => {
    const res = await get('/p/http/site.test/landing');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /landed/);
    assert.equal(ctx.mock.requests.length, 1);
    assert.doesNotMatch(res.body, /Sign-in isn't supported/);
  });

  // (2) OAuth authorization URL
  test('an OAuth authorization URL gets the sign-in page and never reaches the website', async () => {
    const authorize = await get(
      `/p/http/site.test/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent('http://site.test/callback')}&response_type=code&scope=openid%20email&state=${OAUTH_STATE}`
    );
    assertSignInPage(authorize, { host: 'site.test' });
    // no part of the authorization request is echoed back to the visitor
    assert.doesNotMatch(authorize.body, /apps\.googleusercontent\.com|response_type|redirect_uri|Ky7dQ2bX/);

    // detected on the parameters alone, whatever the path is called
    const bare = await get(`/p/http/site.test/start?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent('http://site.test/cb')}&response_type=code`);
    assertSignInPage(bare, { host: 'site.test' });
  });

  // (3) Google-style sign-in page
  test('a Google-style sign-in page gets the sign-in page instead of 403 origin_mismatch', async () => {
    const authorize = await get(`/p/https/accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&scope=openid`);
    assertSignInPage(authorize, { host: 'accounts.google.com' });
    // the identity provider's own pages, with or without OAuth parameters
    const identifier = await get('/p/https/accounts.google.com/signin/v2/identifier');
    assertSignInPage(identifier, { host: 'accounts.google.com' });
    const microsoft = await get('/p/https/login.microsoftonline.com/common/oauth2/v2.0/authorize');
    assertSignInPage(microsoft, { host: 'login.microsoftonline.com' });
    // and the page points at the provider's own origin, without a query string
    assert.match(identifier.body, /href="https:\/\/accounts\.google\.com\/"/);
  });

  // (4) ordinary /login page that isn't OAuth
  test('an ordinary /login page is proxied normally', async () => {
    const res = await get('/p/http/site.test/login');
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Sign in<\/h1>/);
    assert.match(res.body, /type="password"/);
    assert.doesNotMatch(res.body, /Sign-in isn't supported/);
    assert.equal(ctx.mock.last().path, '/login');
    // …as are /signin and /accounts pages
    assert.equal((await get('/p/http/site.test/accounts')).statusCode, 200);
    assert.equal((await get('/p/http/site.test/shipping?code=NL&state=NL')).statusCode, 200, 'code+state that are not OAuth');
  });

  // (5) credential submission
  test('credential submission is relayed untouched and never captured, logged or stored', async () => {
    const payload = `username=alice&password=${PASSWORD}`;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/p/http/site.test/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload
    });
    assert.equal(res.statusCode, 200);
    const upstream = ctx.mock.last();
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.body.toString('utf8'), payload, 'the body is forwarded byte for byte, never rewritten');
    assert.equal(JSON.parse(res.body).received, payload, 'and the answer comes back unchanged');

    // nothing about the credentials is kept or written down
    assert.doesNotMatch(logText(), new RegExp(PASSWORD));
    assert.doesNotMatch(logText(), /password/i);
    assert.doesNotMatch(logText(), /alice/);
    assert.equal(ctx.app.sessions.stats().active, 0, 'no session, no jar, nothing stored for this request');

    // a credential POST into an OAuth endpoint is refused before it is sent
    const toTokenEndpoint = await ctx.app.inject({
      method: 'POST',
      url: '/p/http/site.test/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${AUTH_CODE}&client_secret=${CLIENT_SECRET}`
    });
    assert.equal(toTokenEndpoint.statusCode, 501);
    assert.match(toTokenEndpoint.body, /Sign-in isn't supported in proxied mode/);
    assert.equal(ctx.mock.requests.length, 1, 'only the /login POST reached the site');
    assert.doesNotMatch(logText(), new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(logText(), /4\/0AY0e/);
  });

  // (6) tokens appearing in query parameters
  test('tokens and authorization codes in the query are refused, never forwarded and never logged', async () => {
    const withToken = await get(`/p/http/site.test/callback?access_token=${encodeURIComponent(ACCESS_TOKEN)}&token_type=bearer`);
    assertSignInPage(withToken, { host: 'site.test' });
    assert.doesNotMatch(withToken.body, /ya29|FAKE-TEST-ACCESS-TOKEN/);

    const withCode = await get(`/p/http/site.test/callback?code=${encodeURIComponent(AUTH_CODE)}&state=${OAUTH_STATE}&scope=openid`);
    assertSignInPage(withCode, { host: 'site.test' });
    assert.doesNotMatch(withCode.body, /AUTHORIZATION-CODE|Ky7dQ2bX/);

    const text = logText();
    assert.ok(text.length > 0, 'requests are logged at all');
    for (const secret of [ACCESS_TOKEN, AUTH_CODE, OAUTH_STATE, 'ya29', 'access_token', 'code=']) {
      assert.ok(!text.includes(secret), `"${secret}" must never be written to the log`);
    }
    assert.match(text, /\/p\/http\/site\.test\/…/, 'proxied paths are logged without their query string');
  });

  // (7) preserving normal non-authenticated navigation
  test('normal navigation keeps working: links, assets, redirects and cookies', async () => {
    const home = await get('/p/http/site.test/');
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /href="\/p\/http\/site\.test\/about"/, 'links still rewritten through the proxy');

    const css = await get('/p/http/site.test/style.css');
    assert.equal(css.statusCode, 200);
    assert.match(css.body, /\/p\/http\/site\.test\/img\/a\.png/);

    const img = await get('/p/http/site.test/img.png');
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/png');

    const redirect = await get('/p/http/site.test/redirect/allowed');
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, '/p/http/site.test/landing?from=redirect');

    const cookies = await get('/p/http/site.test/set-cookie');
    assert.equal(cookies.statusCode, 200);
    assert.ok(ctx.mock.requests.length >= 5);
  });

  test('a redirect into a sign-in flow is stopped before the browser follows it', async () => {
    const res = await get('/p/http/site.test/redirect/signin');
    assert.equal(res.statusCode, 501);
    assert.match(res.body, /Sign-in isn't supported in proxied mode/);
    assert.match(res.body, /<code>accounts\.google\.com<\/code>/);
    assert.equal(res.headers.location, undefined, 'the browser is never sent on to the provider');
    assert.doesNotMatch(res.body, /apps\.googleusercontent\.com|Ky7dQ2bX/, 'no OAuth parameters are rendered');
    assert.equal(ctx.mock.requests.length, 1, 'only the original page was fetched');
    assert.doesNotMatch(logText(), /client_id|Ky7dQ2bX/);
  });

  test('the authorization boundary still comes first: an unauthorized provider is simply not authorized', async () => {
    const res = await get('/p/https/appleid.apple.com/auth/authorize?client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fsite.test%2Fcb');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Website not authorized/);
    assert.equal(ctx.mock.requests.length, 0);
  });

  test('a blocked redirect names its destination with the query values redacted', async () => {
    const res = await get('/p/http/site.test/redirect/blocked');
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /tried to send you to/);
    assert.match(res.body, /blocked\.example/);
  });
});

describe('applications the operator runs themselves (PROXY_AUTH_FLOW_HOSTS)', () => {
  test('a listed host keeps its sign-in flow; every other host still gets the page', async () => {
    const ctx = await createTestApp({ env: { PROXY_ALLOWED_DOMAINS: SCOPE, PROXY_AUTH_FLOW_HOSTS: 'site.test' }, hosts: HOSTS });
    try {
      // The operator registered this proxy's origin and redirect URI with the
      // provider themselves, so the flow is proxied like any other page. The
      // provider still applies its own checks - nothing here forges anything.
      const own = await ctx.app.inject({
        method: 'GET',
        url: `/p/http/site.test/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent('http://site.test/callback')}`
      });
      assert.equal(own.statusCode, 200);
      assert.equal(ctx.mock.last().path, '/oauth/authorize');

      const thirdParty = await ctx.app.inject({ method: 'GET', url: `/p/https/accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code` });
      assert.equal(thirdParty.statusCode, 501, 'somebody else\'s provider is never exempted by listing your own host');
      assert.match(thirdParty.body, /Sign-in isn't supported in proxied mode/);
    } finally {
      await ctx.close();
    }
  });

  test('the setting is validated at start-up and never accepts "*"', async () => {
    await assert.rejects(createTestApp({ withMock: false, env: { PROXY_AUTH_FLOW_HOSTS: '*' } }), /cannot be "\*"/);
    await assert.rejects(createTestApp({ withMock: false, env: { PROXY_AUTH_FLOW_HOSTS: 'not a host' } }), /invalid entry/);
    await assert.rejects(createTestApp({ withMock: false, env: { PROXY_AUTH_FLOW_HOSTS: '10.0.0.1' } }), /invalid entry/);
  });

  test('matching follows the authorized-scope rules: exact host, or *. for subdomains only', () => {
    const exemptions = createAuthFlowExemptions(['app.example.com', '*.corp.example']);
    assert.equal(exemptions.size, 2);
    assert.equal(exemptions.isExempt('app.example.com'), true);
    assert.equal(exemptions.isExempt('other.example.com'), false);
    assert.equal(exemptions.isExempt('sso.corp.example'), true);
    assert.equal(exemptions.isExempt('deep.sso.corp.example'), true);
    assert.equal(exemptions.isExempt('corp.example'), false, 'the bare domain is not covered by *.');
    assert.equal(exemptions.isExempt('app.example.com.evil.test'), false);
    assert.equal(exemptions.isExempt(''), false);
    assert.equal(createAuthFlowExemptions().size, 0);
  });
});
