/**
 * "Sign in with Google" on a proxied page.
 *
 * WHAT THE SITE DOES. GeoGuessr loads Google Identity Services at runtime
 * (`document.createElement('script').src = 'https://accounts.google.com/gsi/client'`)
 * and, once it has loaded, calls `google.accounts.id.renderButton()` into an
 * empty `<div id="googleSignIn">`. That is the credential (ID token) flow, and
 * its UX is a popup Google itself opens from inside its own iframe — nothing
 * navigates. Apple is different: GeoGuessr signs in with Apple by navigating
 * the whole page to `appleid.apple.com`, which the server hand-off handles.
 *
 * WHY IT CANNOT RUN HERE. Before GIS renders a button or opens anything, it
 * asks `accounts.google.com/gsi/status` whether `window.location.origin` is an
 * Authorized JavaScript origin of the site's OAuth client. Measured against
 * GeoGuessr's own public client id: `https://www.geoguessr.com` gets HTTP 200,
 * `https://anonview-proxy.onrender.com` gets HTTP 403. Neither forging that
 * origin nor editing a third party's OAuth client is acceptable, so the answer
 * is no and no popup can exist.
 *
 * WHAT THE PROXY DOES ABOUT IT. Two paths, and only two:
 *
 *   * `PROXY_AUTH_FLOW_HOSTS` names the host (the operator runs the app and
 *     registered this origin with the provider): the SDK is left completely
 *     alone, loads from Google unproxied, and Google's own popup UX runs with
 *     the site's own client id, state and nonce. The parent page stays open.
 *     A provider window the site opens itself is passed through untouched and
 *     watched for blocking and for closing.
 *
 *   * Anyone else's site: the SDK is never fetched, the control says
 *     "Google sign-in isn't available inside this proxy", and *nothing is
 *     opened* — no provider window, and no second copy of the site the visitor
 *     is already on. The page they are on stays exactly where it is.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { identitySdkProvider, requestDestination } from '../src/security/auth-flow.js';
import { createDom } from './helpers/dom.js';
import { createTestApp } from './helpers/app.js';

const SCOPE = 'site.test,cdn.test,other.test,accounts.google.com,appleid.apple.com';
const HOSTS = { 'site.test': '127.0.0.1', 'cdn.test': '127.0.0.1', 'accounts.google.com': '127.0.0.1', 'appleid.apple.com': '127.0.0.1' };

/** GeoGuessr's own loader, reproduced literally. */
function loadGisLikeGeoGuessr(dom) {
  const d = dom.document;
  const container = d.createElement('div');
  container.setAttribute('id', 'googleSignIn');
  container.setAttribute('style', 'position:absolute;opacity:0');
  d.body.appendChild(container);

  let loaded = false;
  const script = d.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.addEventListener('load', () => {
    loaded = true;
  });
  d.body.appendChild(script);
  script.dispatch('load'); // an empty data: script loads immediately
  return { container, script, didLoad: () => loaded };
}

const findButton = (node, text) => node.all().find((n) => n.tagName === 'BUTTON' && new RegExp(text).test(n.textContent));

describe('the Google sign-in button on a proxied page', () => {
  // (8) missing Google JavaScript — the regression test for the actual bug
  test('the GIS script is never fetched, yet the page\'s load bookkeeping still runs', () => {
    const dom = createDom();
    const { container, script, didLoad } = loadGisLikeGeoGuessr(dom);

    assert.equal(script.src, 'data:text/javascript,', 'nothing is requested from Google, and nothing is proxied');
    assert.doesNotMatch(script.src, /accounts\.google\.com/);
    assert.doesNotMatch(script.src, /\/p\//, 'and it is not turned into a proxy URL that would answer with HTML');
    assert.equal(didLoad(), true, "the site's own onload still fires, so it goes on to call renderButton()");
    assert.equal(typeof dom.window.google.accounts.id.renderButton, 'function');

    // renderButton now produces a real, clickable control instead of nothing
    dom.window.google.accounts.id.initialize({ client_id: 'x.apps.googleusercontent.com', callback: () => assert.fail('the site callback must never be invoked') });
    dom.window.google.accounts.id.renderButton(dom.document.getElementById('googleSignIn'), { type: 'standard', text: 'signin_with' });
    const button = container.childNodes[0];
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.textContent, 'Continue with Google');
    assert.equal(button.getAttribute('data-pxy-ignore'), '1', 'the proxy never rewrites its own control');
    // rendering twice (React re-render) must not stack duplicate buttons
    dom.window.google.accounts.id.renderButton(container, {});
    assert.equal(container.childNodes.length, 1);
  });

  // (1) Click Google sign-in, (2) the parent stays put, (3) no second tab
  test('clicking it keeps the proxied page open and opens nothing at all', () => {
    const dom = createDom();
    loadGisLikeGeoGuessr(dom);
    const container = dom.document.getElementById('googleSignIn');
    const before = dom.window.location.href;
    dom.window.google.accounts.id.renderButton(container, {});

    assert.equal(dom.panel(), null, 'nothing on screen until the visitor asks for it');
    container.childNodes[0].click();

    const panel = dom.panel();
    assert.ok(panel, 'the explanation appears on the page the visitor is already on');
    assert.match(panel.text(), /Google sign-in isn't available inside this proxy/);
    assert.match(panel.text(), /only accepts a sign-in that starts from www\.geoguessr\.com's own web address/);
    assert.match(panel.text(), /You stay on this page, and stay signed out on it/);

    // (3) nothing is opened: no provider window, and above all no second copy
    // of the site the visitor is already looking at
    assert.deepEqual(dom.opened, [], 'no window of any kind');
    assert.equal(
      panel.all().some((n) => n.tagName === 'A'),
      false,
      'not even a link that would take them off this page'
    );
    // (2) the parent page is untouched
    assert.equal(dom.window.location.href, before);

    const labels = panel.all().filter((n) => n.tagName === 'BUTTON').map((n) => n.textContent);
    assert.deepEqual(labels, ['Try again', 'Close'], 'a retry, and a way out');
  });

  test('Try again shows a loading state and then the same honest answer', () => {
    const dom = createDom();
    dom.auth.sdkBlocked('Google');
    dom.auth.unavailable('Google');
    findButton(dom.panel(), 'Try again').click();

    assert.match(dom.panel().text(), /Checking…/, 'a loading state on the parent page');
    assert.match(dom.panel().text(), /Asking Google whether this address may start a sign-in/);
    dom.runTimers();
    assert.match(dom.panel().text(), /Google sign-in isn't available inside this proxy/);
    assert.deepEqual(dom.opened, [], 'retrying still opens nothing');

    findButton(dom.panel(), 'Close').click();
    assert.equal(dom.panel(), null);
  });

  // (4) the legitimate popup, only where the origin is actually registered
  test('where the operator registered this origin, the provider SDK is left alone', () => {
    const dom = createDom({ authFlowHost: true });
    const script = dom.document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    assert.equal(script.src, 'https://accounts.google.com/gsi/client', 'loaded from Google, unproxied and unmodified');
    assert.equal(dom.window.google, undefined, 'no stand-in is installed: the real library runs');
    assert.equal(dom.auth.supported, true);
  });

  test("a provider sign-in window is the provider's own, never a proxied copy", () => {
    const popup = { closed: false, focused: 0, focus() { this.focused++; }, close() { this.closed = true; } };
    const dom = createDom({ authFlowHost: true, popup });
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=SITE-OWN-CLIENT&response_type=code&state=SITE-OWN-STATE&nonce=SITE-OWN-NONCE';
    dom.window.open(url);

    assert.equal(dom.opened.length, 1);
    assert.equal(dom.opened[0].url, url, 'the URL is passed through byte for byte: client id, state and nonce untouched');
    assert.doesNotMatch(dom.opened[0].url, /\/p\//, 'never a proxied copy of the provider');
    assert.match(dom.opened[0].features, /popup=1/, 'a popup, not a tab');
    assert.equal(popup.focused, 1, 'the popup is focused');
    assert.match(dom.panel().text(), /Waiting for Google…/, 'and the parent page shows a loading state');
    assert.match(dom.panel().text(), /This page stays open/);
  });

  // (6) popup closed
  test('a popup that closes without a session says so instead of guessing', () => {
    const popup = { closed: false, focus() {}, close() { this.closed = true; } };
    const dom = createDom({ authFlowHost: true, popup });
    dom.window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');
    assert.equal(dom.intervalCount, 1, 'the popup is being watched');

    dom.tick();
    assert.match(dom.panel().text(), /Waiting for Google/, 'still open, still waiting');

    popup.closed = true;
    dom.tick();
    assert.match(dom.panel().text(), /Sign-in window was closed/);
    assert.match(dom.panel().text(), /before this page reported a signed-in session/);
    assert.equal(dom.intervalCount, 0, 'the watcher stops');
    assert.ok(findButton(dom.panel(), 'Try again'));
    assert.equal(dom.opened.length, 1, 'and nothing was reopened on its own');
  });

  // (5) popup blocked
  test('a blocked popup says so and offers a retry, and never opens a site tab', () => {
    const dom = createDom({ authFlowHost: true, popup: null });
    dom.window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=x');

    const panel = dom.panel();
    assert.match(panel.text(), /Sign-in window was blocked/);
    assert.match(panel.text(), /Allow pop-ups for this page/);
    assert.ok(findButton(panel, 'Try again'));
    assert.equal(
      panel.all().some((n) => n.tagName === 'A'),
      false,
      'no link that would open the website instead'
    );
    assert.equal(dom.opened.length, 1, 'one attempt; the proxy does not retry by itself');

    findButton(dom.panel(), 'Try again').click();
    assert.equal(dom.opened.length, 2, 'a retry is the visitor asking, once');
    assert.match(dom.panel().text(), /Sign-in window was blocked/);
  });

  // (7) OAuth failure behaviour on a site whose client does not know this origin
  test('on somebody else\'s site a provider window is refused with the explanation, not opened', () => {
    const dom = createDom({ authFlowHost: false });
    const result = dom.window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code');

    assert.equal(result, null);
    assert.deepEqual(dom.opened, [], 'no provider window, because it could only show an origin error');
    assert.match(dom.panel().text(), /Google sign-in isn't available inside this proxy/);
  });

  test('the token and code clients report the same thing instead of failing silently', () => {
    const dom = createDom();
    dom.auth.sdkBlocked('Google');
    dom.window.google.accounts.oauth2.initTokenClient({ client_id: 'x', scope: 'openid' }).requestAccessToken();
    assert.match(dom.panel().text(), /isn't available inside this proxy/);
    assert.deepEqual(dom.opened, []);
    assert.equal(dom.window.google.accounts.oauth2.hasGrantedAllScopes(), false);
  });

  // (8) nothing sensitive is ever written down on the client side either
  test('no OAuth parameter reaches the panel, and no window is opened carrying one', () => {
    const dom = createDom({
      proxyUrl: 'http://proxy.test/p/https/www.geoguessr.com/signin?state=SECRET-STATE&code=SECRET-CODE',
      pageUrl: 'https://www.geoguessr.com/signin?state=SECRET-STATE&code=SECRET-CODE'
    });
    dom.auth.sdkBlocked('Google');
    dom.auth.unavailable('Google');
    const text = dom.panel().text() + JSON.stringify(dom.opened);
    for (const secret of ['SECRET-STATE', 'SECRET-CODE', 'client_id', 'apps.googleusercontent']) {
      assert.ok(!text.includes(secret), `"${secret}" must never appear`);
    }
  });

  // ordinary pages are unaffected
  test('ordinary scripts and pages are untouched by any of this', () => {
    const dom = createDom();
    const ordinary = dom.document.createElement('script');
    ordinary.src = 'https://cdn.example.com/app.js';
    assert.equal(ordinary.src, '/p/https/cdn.example.com/app.js', 'still proxied exactly as before');

    const relative = dom.document.createElement('script');
    relative.src = '/_next/static/chunk.js';
    assert.equal(relative.src, '/p/https/www.geoguessr.com/_next/static/chunk.js');

    const img = dom.document.createElement('img');
    img.src = 'https://cdn.example.com/a.png';
    assert.equal(img.src, '/p/https/cdn.example.com/a.png');

    assert.equal(dom.panel(), null, 'no sign-in UI appears on an ordinary page');
    assert.equal(dom.opened.length, 0);
  });

  // Apple behaviour on the client side
  test("Apple's SDK is intercepted the same way, and its redirect flow is left to the server", () => {
    const dom = createDom();
    const appleSdk = dom.document.createElement('script');
    appleSdk.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
    assert.equal(appleSdk.src, 'data:text/javascript,');
    assert.equal(dom.auth.blocked.Apple, true);
    // Apple's own sign-in is a whole-page navigation, which is not a script at
    // all: the shim leaves it alone and the server renders the hand-off page.
    const link = dom.document.createElement('a');
    link.href = 'https://appleid.apple.com/auth/authorize?client_id=x&response_type=code';
    assert.equal(link.href, '/p/https/appleid.apple.com/auth/authorize?client_id=x&response_type=code');
  });

  // (5) OAuth URL / SDK detection
  test('SDK detection is exact: a host alone is never enough', () => {
    const dom = createDom();
    const srcOf = (u) => {
      const s = dom.document.createElement('script');
      s.src = u;
      return s.src;
    };
    // intercepted
    for (const u of [
      'https://accounts.google.com/gsi/client',
      'https://apis.google.com/js/platform.js',
      'https://apis.google.com/js/api.js',
      'https://connect.facebook.net/en_US/sdk.js',
      '/p/https/accounts.google.com/gsi/client'
    ]) {
      assert.equal(srcOf(u), 'data:text/javascript,', u);
    }
    // not an SDK: proxied as usual
    assert.equal(srcOf('https://accounts.google.com/other/thing.js'), '/p/https/accounts.google.com/other/thing.js');
    assert.equal(srcOf('https://apis.google.com/js/analytics.js'), '/p/https/apis.google.com/js/analytics.js');
    assert.equal(srcOf('https://connect.facebook.net/en_US/other.js'), '/p/https/connect.facebook.net/en_US/other.js');
    // and the server's copy of the list agrees
    assert.equal(identitySdkProvider(new URL('https://accounts.google.com/gsi/client')), 'Google');
    assert.equal(identitySdkProvider(new URL('https://appleid.cdn-apple.com/appleauth/static/jsapi/x.js')), 'Apple');
    assert.equal(identitySdkProvider(new URL('https://accounts.google.com/o/oauth2/v2/auth')), '');
    assert.equal(identitySdkProvider('not a url'), '');
  });
});

describe('the proxy answers a sign-in request with the right kind of thing', () => {
  const app = () => createTestApp({ env: { PROXY_ALLOWED_DOMAINS: SCOPE }, hosts: HOSTS });

  // (9) the CSP / content-type failure that actually broke the button
  test('a <script> request gets JavaScript, never an HTML page', async () => {
    const ctx = await app();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/p/https/accounts.google.com/gsi/client',
        headers: { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors' }
      });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /application\/javascript/);
      assert.doesNotMatch(res.body, /<!DOCTYPE html>|<html/i, 'HTML here is what killed the button');
      assert.match(res.body, /__PXY_AUTH__/, 'it hands the control to the shim');
      assert.match(res.body, /"Google"/, 'and says which provider it stood in for');
      assert.equal(ctx.mock.requests.length, 0, 'nothing is fetched from the provider');
      // the served stub is valid JavaScript
      assert.doesNotThrow(() => new Function(res.body));
    } finally {
      await ctx.close();
    }
  });

  test('a fetch/XHR or iframe request gets JSON, never an HTML page', async () => {
    const ctx = await app();
    try {
      for (const dest of ['empty', 'iframe', 'image']) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/p/https/accounts.google.com/gsi/status',
          headers: { 'sec-fetch-dest': dest, accept: 'application/json' }
        });
        assert.equal(res.statusCode, 501, dest);
        assert.match(res.headers['content-type'], /application\/json/, dest);
        assert.doesNotMatch(res.body, /<!DOCTYPE html>|<html/i, dest);
        assert.equal(JSON.parse(res.body).error.code, 'AUTH_FLOW_UNSUPPORTED');
      }
    } finally {
      await ctx.close();
    }
  });

  test('a navigation still gets the full hand-off page', async () => {
    const ctx = await app();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/p/https/accounts.google.com/o/oauth2/v2/auth?client_id=x&response_type=code',
        headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' }
      });
      assert.equal(res.statusCode, 501);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.match(res.body, /<h1 id="error-title">Sign-in required<\/h1>/);
      assert.match(res.body, /Continue to sign in/);
    } finally {
      await ctx.close();
    }
  });

  // (9) the proxy must not be imposing a CSP that would block its own shim
  test('proxied pages carry no CSP of their own, so nothing blocks the shim', async () => {
    const ctx = await app();
    try {
      const res = await ctx.app.inject({ method: 'GET', url: '/p/http/site.test/', headers: { 'sec-fetch-dest': 'document' } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-security-policy'], undefined);
      assert.equal(res.headers['content-security-policy-report-only'], undefined);
      assert.match(res.body, /\/_\/shim\.js/, 'the shim is injected');
    } finally {
      await ctx.close();
    }
  });

  // (9) nothing sensitive is written down along the way
  test('no OAuth parameter from a sign-in request reaches the response or the path log', async () => {
    const ctx = await app();
    try {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/p/https/accounts.google.com/gsi/client?client_id=SECRET-CLIENT&state=SECRET-STATE&nonce=SECRET-NONCE',
        headers: { 'sec-fetch-dest': 'script' }
      });
      assert.equal(res.statusCode, 200);
      for (const secret of ['SECRET-CLIENT', 'SECRET-STATE', 'SECRET-NONCE', 'client_id', 'state=', 'nonce']) {
        assert.ok(!res.body.includes(secret), `"${secret}" must not appear in the served script`);
      }
    } finally {
      await ctx.close();
    }
  });

  test('requestDestination falls back sensibly when Sec-Fetch-Dest is missing', () => {
    assert.equal(requestDestination({ 'sec-fetch-dest': 'script' }), 'script');
    assert.equal(requestDestination({ 'sec-fetch-dest': 'worker' }), 'script');
    assert.equal(requestDestination({ 'sec-fetch-dest': 'document' }), 'document');
    assert.equal(requestDestination({ 'sec-fetch-dest': 'iframe' }), 'other');
    assert.equal(requestDestination({ 'sec-fetch-mode': 'navigate' }), 'document');
    assert.equal(requestDestination({ accept: 'text/html,application/xhtml+xml' }), 'document');
    assert.equal(requestDestination({ accept: 'application/json' }), 'other');
    assert.equal(requestDestination({}), 'document', 'a bare client is treated as a visitor');
  });
});
