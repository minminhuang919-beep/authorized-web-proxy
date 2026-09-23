/**
 * Detection of third-party sign-in / OAuth flows, and the hand-off to the
 * visitor's own browser.
 *
 * WHY THEY CANNOT BE PROXIED. An OAuth 2.0 / OIDC authorization request is
 * bound to the application's own origin and to redirect URIs registered with
 * the identity provider. A proxied page is served from the proxy's origin, so
 * the provider refuses the request — Google answers `403 origin_mismatch`.
 * The only ways to make the provider accept it would be to forge the origin or
 * to rewrite the OAuth parameters, i.e. to defeat a control that exists to
 * protect the visitor's account. This proxy does neither.
 *
 * WHAT IT DOES INSTEAD. It stops *before* contacting the provider and hands
 * the visitor off to the normal browser flow: `AuthFlowUnsupportedError`
 * → the "Sign-in required" page, whose *Continue to sign in* button is an
 * ordinary link to the provider's (or the application's) real origin, opened
 * outside the proxy. Nothing about the flow is captured, logged, modified or
 * stored: no passwords, authorization codes, access/refresh tokens, client
 * secrets, authentication cookies, `state` or `nonce`.
 *
 * THE HAND-OFF LINK NEVER CARRIES OAUTH PARAMETERS. `buildSignInHandoff()`
 * only ever produces a scheme + host (+ path) URL with the query string and
 * fragment removed. It does not copy `client_id`, `redirect_uri`, `state`,
 * `nonce`, `code` or a token into the page, and it does not construct an
 * authorization request of its own: a flow that was interrupted here has to be
 * started again by the application in the browser, which is also the only way
 * it can work — the application's session cookie lives in this proxy's
 * server-side jar, not in the visitor's browser.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE — an ordinary page must not be
 * mistaken for a sign-in flow. A bare `/login`, `/signin` or `/accounts` path
 * on a normal website is proxied as usual; those words alone prove nothing.
 * A request is treated as an authentication flow only when one of these holds:
 *
 *   1. it carries OAuth/OIDC/SAML response material in the query
 *      (`access_token`, `id_token`, `refresh_token`, `SAMLResponse`, or a
 *      `code` + `state` pair that actually looks like OAuth);
 *   2. it looks like an authorization request: `client_id` together with
 *      `response_type`, `redirect_uri`, `scope` or `code_challenge`;
 *   3. its host is a dedicated identity provider (accounts.google.com,
 *      login.microsoftonline.com, an Auth0/Okta tenant, …), where every path
 *      is part of signing in;
 *   4. its path is an unmistakable OAuth/OIDC/SAML endpoint (`/oauth/…`,
 *      `/o/oauth2/…`, `/connect/authorize`, `/protocol/openid-connect/…`,
 *      `/signin-oidc`, `/saml/…`, `/auth/google`, …).
 */
import { ConfigError } from '../config.js';
import { ALL_WEBSITES, parseAllowlistPattern } from './hostname.js';

/**
 * OWNED APPLICATIONS. An administrator who runs the destination application
 * *and* its OAuth client can register this proxy's origin and redirect URI
 * with the provider themselves, and then list those hosts in
 * PROXY_AUTH_FLOW_HOSTS so their sign-in pages are proxied like any other
 * page. That changes nothing about what is sent: the provider still applies
 * its own origin and redirect-URI checks, and the proxy still forges nothing.
 * It only stops the proxy from pre-empting a flow the owner has arranged.
 */

/** Hosts that exist to authenticate people: every path on them is sign-in. */
const IDENTITY_PROVIDER_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'oauth2.googleapis.com',
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'login.windows.net',
  'appleid.apple.com',
  'idmsa.apple.com',
  'login.yahoo.com',
  'auth.atlassian.com',
  'id.atlassian.com',
  'signin.aws.amazon.com',
  'oauth.telegram.org',
  'id.twitch.tv',
  'accounts.spotify.com',
  'auth.openai.com',
  'login.salesforce.com',
  'secure.login.gov'
]);

/** Per-tenant identity providers, matched on the registrable suffix. */
const IDENTITY_PROVIDER_SUFFIXES = ['.auth0.com', '.okta.com', '.oktapreview.com', '.b2clogin.com', '.ciamlogin.com', '.onelogin.com', '.duosecurity.com'];

/** Unmistakable OAuth/OIDC/SAML endpoints, matched on whole path segments. */
const AUTH_ENDPOINT_RE = /(^|\/)(oauth2?|o\/oauth2|connect\/authorize|protocol\/openid-connect|signin-oidc|signin-google|saml2?|sso\/saml)(\/|$)/;

/** Provider-named sign-in routes such as Passport's `/auth/google`. */
const PROVIDER_ROUTE_RE = /(^|\/)auth\/(google|github|gitlab|facebook|apple|microsoft|azuread|twitter|linkedin|discord|slack|okta|auth0|oidc|openid|saml)(\/|$)/;

/** Query parameters that always mean "authentication material is present". */
const SECRET_PARAMS = ['access_token', 'id_token', 'refresh_token', 'authorization_code', 'client_secret', 'samlresponse', 'samlrequest', 'assertion'];

/**
 * Parameters worth hiding wherever a URL is shown or logged. Wider than the
 * detection list on purpose: redaction is free, leaking is not.
 */
const SENSITIVE_PARAMS = new Set([
  ...SECRET_PARAMS,
  'code',
  'code_verifier',
  'code_challenge',
  'state',
  'token',
  'id_token_hint',
  'session_state',
  'nonce',
  'login_hint',
  'password',
  'passwd',
  'pwd',
  'secret',
  'api_key',
  'apikey',
  'auth',
  'session',
  'sig',
  'signature'
]);

const has = (params, name) => params.has(name) || params.has(name.toUpperCase());

function getParam(params, name) {
  const value = params.get(name) ?? params.get(name.toUpperCase());
  return typeof value === 'string' ? value : '';
}

/** `true` when any parameter is unambiguously authentication material. */
function hasSecretParams(params) {
  for (const key of params.keys()) {
    if (SECRET_PARAMS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * An OAuth redirect coming back with an authorization code. `code` and
 * `state` are both ordinary words (a promo code, a US state), so they only
 * count together *and* when they look like OAuth: an opaque code or state, or
 * an authentication endpoint path.
 */
function looksLikeOAuthCallback(params, path) {
  if (!has(params, 'code') || !has(params, 'state')) return false;
  const code = getParam(params, 'code');
  const state = getParam(params, 'state');
  return code.length >= 20 || state.length >= 16 || isAuthEndpointPath(path);
}

/** An OAuth 2.0 / OIDC authorization request. */
function looksLikeAuthorizeRequest(params) {
  if (!has(params, 'client_id')) return false;
  return has(params, 'response_type') || has(params, 'redirect_uri') || has(params, 'scope') || has(params, 'code_challenge');
}

/** @param {string} hostname already normalised (lower case, no port) */
export function isIdentityProviderHost(hostname) {
  if (typeof hostname !== 'string' || !hostname) return false;
  const host = hostname.toLowerCase();
  if (IDENTITY_PROVIDER_HOSTS.has(host)) return true;
  return IDENTITY_PROVIDER_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** @param {string} pathname */
export function isAuthEndpointPath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return false;
  const path = pathname.toLowerCase();
  return AUTH_ENDPOINT_RE.test(path) || PROVIDER_ROUTE_RE.test(path);
}

/**
 * Classify a proxy target. Returns null for ordinary pages — including plain
 * `/login`, `/signin` and `/accounts` pages, which keep working as usual.
 *
 * The result never contains anything from the query string: only the host and
 * a category, both safe to log and to show.
 *
 * @param {URL} url validated upstream target
 * @returns {{ kind: 'oauth-callback'|'oauth-authorize'|'identity-provider'|'oauth-endpoint', host: string }|null}
 */
export function detectAuthFlow(url) {
  if (!url || typeof url.hostname !== 'string') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const params = url.searchParams;

  if (hasSecretParams(params) || looksLikeOAuthCallback(params, path)) return { kind: 'oauth-callback', host };
  if (looksLikeAuthorizeRequest(params)) return { kind: 'oauth-authorize', host };
  if (isIdentityProviderHost(host)) return { kind: 'identity-provider', host };
  if (isAuthEndpointPath(path)) return { kind: 'oauth-endpoint', host };
  return null;
}

/**
 * Reduce a URL to the part that is safe to put in a link: scheme, host and
 * (optionally) path. The query string and the fragment are dropped outright,
 * so an authorization code, token, `state` or `nonce` can never travel in a
 * hand-off link. Returns '' for anything that is not http(s).
 * @param {URL} url
 * @param {{ keepPath?: boolean }} [opts]
 */
function bareUrl(url, { keepPath = false } = {}) {
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return '';
  const path = keepPath && url.pathname && url.pathname !== '/' ? url.pathname : '/';
  return `${url.origin}${path}`;
}

/**
 * Where to send the visitor so they can sign in normally, in their own
 * browser, outside the proxy.
 *
 * Nothing is invented and nothing is copied: the result is only ever an origin
 * (plus, for an application's own sign-in route, that route's path). No OAuth
 * parameter is carried over, no redirect URI is constructed, and the provider
 * is never asked to send anyone back to this proxy.
 *
 *   identity-provider  the provider's own front door (appleid.apple.com/)
 *   oauth-endpoint     the application's sign-in route (site/auth/google),
 *                      which is exactly what starts the flow normally
 *   oauth-authorize    the application's / provider's origin. The authorization
 *   oauth-callback     request cannot be replayed — the application's session
 *                      lives in this proxy's cookie jar — so the flow has to be
 *                      started again from the site itself.
 *
 * `returnTo` is the page the visitor was on when the flow started. It is kept
 * only as a plain origin+path link so they can pick up where they left off;
 * it is never turned into a redirect URI or handed to the provider.
 *
 * @param {URL} url the stopped authentication target
 * @param {{ kind?: string, returnTo?: URL|string|null }} [opts]
 * @returns {{ signInUrl: string, signInHost: string, returnUrl: string, returnHost: string }}
 */
export function buildSignInHandoff(url, { kind = '', returnTo = null } = {}) {
  const empty = { signInUrl: '', signInHost: '', returnUrl: '', returnHost: '' };
  if (!(url instanceof URL)) return empty;
  const signInUrl = bareUrl(url, { keepPath: kind === 'oauth-endpoint' });
  if (!signInUrl) return empty;

  let back = null;
  if (returnTo) {
    try {
      back = returnTo instanceof URL ? new URL(returnTo.href) : new URL(String(returnTo));
    } catch {
      back = null;
    }
  }
  // A return link to the very page that was stopped would send the visitor
  // straight back into the same flow, so only a different page is offered.
  const returnUrl = back ? bareUrl(back, { keepPath: true }) : '';
  return {
    signInUrl,
    signInHost: url.hostname,
    returnUrl: returnUrl && returnUrl !== signInUrl ? returnUrl : '',
    returnHost: returnUrl && returnUrl !== signInUrl ? back.hostname : ''
  };
}

/**
 * What kind of request is this? A sign-in flow is only ever *explained* to a
 * human on a page they navigated to; anything else is a sub-resource, and
 * answering a `<script>`, `fetch()` or `<iframe>` with an HTML page is how the
 * hand-off used to break sites silently (a "Sign in with Google" SDK script
 * would receive HTML, fail to parse, and the site's button would go dead).
 *
 * `Sec-Fetch-Dest` is sent by every current browser. Without it, an `Accept`
 * header asking for HTML is treated as a navigation and everything else as a
 * sub-resource.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {'document'|'script'|'other'}
 */
export function requestDestination(headers = {}) {
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest === 'script' || dest === 'serviceworker' || dest === 'worker' || dest === 'sharedworker') return 'script';
  if (dest === 'document') return 'document';
  if (dest) return 'other';
  const mode = String(headers['sec-fetch-mode'] || '').toLowerCase();
  if (mode === 'navigate') return 'document';
  const accept = String(headers.accept || '');
  if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) return 'document';
  if (!accept || accept === '*/*') return 'document';
  return 'other';
}

/**
 * Third-party sign-in SDKs, matched by URL. These are ordinary public
 * JavaScript files, but they are not ordinary scripts: each one refuses to
 * work unless `window.location.origin` is an origin registered with the
 * provider for that site's OAuth client, which a proxied page can never be
 * without forging it. Loading one through the proxy is therefore pointless,
 * and — because the proxy answered the request with an HTML page — used to
 * break the site's sign-in button outright.
 *
 * The client shim intercepts these before they are ever fetched (see
 * `src/public/shim.js`); this list is the server's copy, used to answer a
 * script request with a script instead of a page.
 *
 * Conservative on purpose: a host plus a specific path, never a bare host.
 * @param {URL} url
 * @returns {string} the provider's name, or '' when this is not a sign-in SDK
 */
export function identitySdkProvider(url) {
  if (!(url instanceof URL)) return '';
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'accounts.google.com' && path.startsWith('/gsi/')) return 'Google';
  if (host === 'apis.google.com' && (path.startsWith('/js/platform') || path.startsWith('/js/api'))) return 'Google';
  if (host === 'appleid.cdn-apple.com' && path.startsWith('/appleauth/static/jsapi')) return 'Apple';
  if (host === 'connect.facebook.net' && /\/sdk\.js$/.test(path)) return 'Facebook';
  return '';
}

/**
 * Hosts whose authentication flows the administrator has taken responsibility
 * for (PROXY_AUTH_FLOW_HOSTS). Same matching as the authorized scope:
 * `app.example.com` exactly, `*.example.com` for subdomains only. `*` is
 * refused - exempting every website would defeat the purpose.
 * @param {string[]} patterns
 * @returns {{ size: number, isExempt(hostname: string): boolean }}
 */
export function createAuthFlowExemptions(patterns = []) {
  const exact = new Set();
  const suffixes = new Set();
  for (const raw of patterns) {
    if (String(raw).trim() === ALL_WEBSITES) {
      throw new ConfigError('PROXY_AUTH_FLOW_HOSTS cannot be "*": list only the hosts of applications you run yourself');
    }
    const parsed = parseAllowlistPattern(raw);
    if (!parsed) throw new ConfigError(`PROXY_AUTH_FLOW_HOSTS contains an invalid entry: "${raw}" (use example.com or *.example.com)`);
    if (parsed.wildcard) suffixes.add(parsed.host);
    else exact.add(parsed.host);
  }
  return {
    size: exact.size + suffixes.size,
    isExempt(hostname) {
      if (typeof hostname !== 'string' || !hostname) return false;
      const host = hostname.toLowerCase();
      if (exact.has(host)) return true;
      let idx = host.indexOf('.');
      while (idx !== -1) {
        if (suffixes.has(host.slice(idx + 1))) return true;
        idx = host.indexOf('.', idx + 1);
      }
      return false;
    }
  };
}

/**
 * A URL reduced to what is safe to display or log: scheme, host and path,
 * with every query value replaced. Used wherever a destination has to be
 * named (blocked redirects, error pages) so an authorization code or token
 * in the query is never rendered back to the visitor.
 * @param {URL|string} value
 * @returns {string}
 */
export function redactUrlForDisplay(value) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(String(value));
  } catch {
    return '';
  }
  url.hash = '';
  if (url.search) {
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, SENSITIVE_PARAMS.has(key.toLowerCase()) ? '[redacted]' : '…');
    }
  }
  url.username = '';
  url.password = '';
  return url.href;
}
