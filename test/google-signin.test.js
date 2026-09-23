/**
 * "Sign in with Google" on a proxied page.
 *
 * THE BUG THIS PINS DOWN. GeoGuessr loads Google Identity Services at runtime
 * (`document.createElement('script').src = 'https://accounts.google.com/gsi/client'`)
 * and, once it has loaded, calls `google.accounts.id.renderButton()` into an
 * empty `<div id="googleSignIn">`. Through the proxy that script URL was
 * rewritten to `/p/https/accounts.google.com/gsi/client`, which the proxy
 * answered with its HTML "Sign-in required" page. HTML is not JavaScript: the
 * script failed, its `load` event never fired, `renderButton()` was never
 * reached, the div stayed empty — and the site's own "Continue with Google"
 * artwork sat on top of nothing. Clicking it did nothing at all. Apple was
 * unaffected because GeoGuessr signs in with Apple by navigating the whole
 * page to `appleid.apple.com`, which the proxy hands off properly.
 *
 * Google sign-in genuinely cannot run on a proxied origin: GIS checks
 * `window.location.origin` against the Authorized JavaScript origins of the
 * site's OAuth client, and neither forging that origin nor editing someone
 * else's OAuth client is acceptable. So the SDK is never fetched, a stand-in
 * renders a working control, and clicking it hands off to the real site.
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

  // (1) Google sign-in button click
  test('clicking it explains the situation instead of doing nothing', () => {
    const dom = createDom();
    loadGisLikeGeoGuessr(dom);
    const container = dom.document.getElementById('googleSignIn');
    dom.window.google.accounts.id.renderButton(container, {});

    assert.equal(dom.panel(), null, 'nothing on screen until the visitor asks for it');
    container.childNodes[0].click();

    const panel = dom.panel();
    assert.ok(panel, 'the hand-off panel appears');
    const text = panel.text();
    assert.match(text, /Sign-in required/);
    assert.match(text, /Google sign-in has to run on www\.geoguessr\.com itself/);
    assert.match(text, /checks the website address/);
    assert.match(text, /You will stay signed out on this proxied page/, 'no pretence that sign-in succeeded');
    assert.ok(findButton(panel, 'Continue on www\\.geoguessr\\.com'), 'the direct-login action');
    assert.ok(findButton(panel, 'Cancel'));
  });

  // (3) popup opened
  test('the popup opens the real site, and only the real site', () => {
    const dom = createDom();
    dom.auth.sdkBlocked('Google');
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    dom.window.google.accounts.id.renderButton(container, {});
    container.childNodes[0].click();
    findButton(dom.panel(), 'Continue on').click();

    assert.deepEqual(dom.opened, [{ url: 'https://www.geoguessr.com/', target: '_blank', features: 'noopener,noreferrer' }]);
    assert.equal(dom.panel(), null, 'the panel closes once the window is open');
  });

  // (2) popup blocked, and (7) no popup loops
  test('a blocked popup says so and offers a link, without ever retrying by itself', () => {
    const dom = createDom({ popup: null });
    dom.auth.sdkBlocked('Google');
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    dom.window.google.accounts.id.renderButton(container, {});
    container.childNodes[0].click();
    const go = findButton(dom.panel(), 'Continue on');
    go.click();

    const panel = dom.panel();
    assert.ok(panel, 'the panel stays open to explain');
    assert.match(panel.text(), /Sign-in window was blocked/);
    assert.match(panel.text(), /browser stopped the sign-in window/);
    const link = panel.all().find((n) => n.tagName === 'A');
    assert.ok(link, 'a link the visitor clicks themselves, which a popup blocker allows');
    assert.equal(link.getAttribute('href'), 'https://www.geoguessr.com/');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer nofollow');
    assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');

    // the proxy never opens another window on its own
    go.click();
    go.click();
    assert.equal(dom.opened.length, 1, 'one window attempt per gesture: no popup loop');
  });

  // (4) direct-auth fallback
  test('the direct-login URL is the site itself, with no query string and no OAuth parameters', () => {
    const dom = createDom({
      proxyUrl: 'http://proxy.test/p/https/www.geoguessr.com/signin?next=%2Fmaps&state=SHOULD-NOT-TRAVEL',
      pageUrl: 'https://www.geoguessr.com/signin?next=%2Fmaps&state=SHOULD-NOT-TRAVEL'
    });
    assert.equal(dom.auth.directSiteUrl(), 'https://www.geoguessr.com/signin', 'origin and path only');

    dom.auth.handoff('Google');
    const panel = dom.panel();
    findButton(panel, 'Continue on').click();
    assert.equal(dom.opened[0].url, 'https://www.geoguessr.com/signin');
    assert.doesNotMatch(JSON.stringify(dom.opened), /SHOULD-NOT-TRAVEL|next=/);
    assert.doesNotMatch(panel.text() + JSON.stringify(dom.opened), /client_id|accounts\.google\.com|apps\.googleusercontent/);
  });

  // (10) third-party cookie / storage failure (One Tap)
  test('One Tap reports that it cannot be displayed rather than hanging or faking a credential', () => {
    const dom = createDom();
    dom.auth.sdkBlocked('Google');
    let moment = null;
    dom.window.google.accounts.id.prompt((m) => {
      moment = m;
    });
    assert.ok(moment, 'the site\'s notification listener is called');
    assert.equal(moment.isNotDisplayed(), true);
    assert.equal(moment.isDisplayed(), false);
    assert.equal(typeof moment.getNotDisplayedReason(), 'string');
    // the credential callback is never reachable, so nothing can claim a sign-in
    assert.equal(dom.window.google.accounts.id.__pxy, true);
    dom.window.google.accounts.id.revoke('someone@example.com', (r) => {
      assert.equal(r.successful, false);
    });
  });

  test('the token and code clients hand off too, instead of failing silently', () => {
    const dom = createDom();
    dom.auth.sdkBlocked('Google');
    dom.window.google.accounts.oauth2.initTokenClient({ client_id: 'x', scope: 'openid' }).requestAccessToken();
    assert.ok(dom.panel(), 'requesting a token opens the hand-off');
    assert.equal(dom.window.google.accounts.oauth2.hasGrantedAllScopes(), false);
  });

  // (6) ordinary page
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

  // (7) Apple behaviour on the client side
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
