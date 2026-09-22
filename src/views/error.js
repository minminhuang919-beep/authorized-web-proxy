import { esc, html, icons, layout } from './layout.js';

const TITLES = {
  INVALID_URL: 'Invalid address',
  UNSUPPORTED_PROTOCOL: 'Unsupported address',
  DOMAIN_NOT_ALLOWED: 'Website not authorized',
  DOMAIN_BLACKLISTED: 'Website unavailable',
  AUTH_FLOW_UNSUPPORTED: "Sign-in isn't supported in proxied mode",
  BLOCKED_ADDRESS: 'Website not reachable',
  UPSTREAM_ERROR: 'Website unavailable',
  UPSTREAM_TIMEOUT: 'Website timed out',
  RESPONSE_TOO_LARGE: 'Response too large',
  REQUEST_TOO_LARGE: 'Request too large',
  RATE_LIMITED: 'Too many requests',
  BUSY: 'Proxy busy',
  SEARCH_UNAVAILABLE: 'Search unavailable',
  SEARCH_TIMEOUT: 'Search timed out',
  NOT_FOUND: 'Page not found',
  CSRF: 'Form expired',
  INTERNAL: 'Something went wrong'
};

const ICONS = {
  DOMAIN_NOT_ALLOWED: icons.shield,
  AUTH_FLOW_UNSUPPORTED: icons.shield,
  DOMAIN_BLACKLISTED: icons.block,
  NOT_FOUND: icons.search,
  UPSTREAM_TIMEOUT: icons.clock,
  RATE_LIMITED: icons.clock
};

/**
 * @param {object} opts
 * @param {number} opts.status
 * @param {string} opts.code
 * @param {string} opts.message user-safe message
 * @param {object} [opts.extra]
 * @param {string} [opts.requestId]
 */
export function errorPage({ status, code, message, extra = {}, requestId = '' }) {
  const title = TITLES[code] || `Error ${status}`;
  if (code === 'AUTH_FLOW_UNSUPPORTED') return authFlowPage({ status, title, extra, requestId });
  const blacklisted = code === 'DOMAIN_BLACKLISTED';
  const body = html`
<section class="error-card rise" aria-labelledby="error-title">
  <div class="error-icon${blacklisted ? ' is-block' : ''}">${ICONS[code] || icons.alert}</div>
  <p class="error-status">${status}</p>
  <h1 id="error-title">${title}</h1>
  <p class="error-message">${message}</p>
  ${
    extra.redirectTarget
      ? html`<p class="muted small">The website tried to send you to <code>${extra.redirectTarget}</code>, so the redirect was stopped.</p>`
      : ''
  }
  ${extra.hostname && code === 'DOMAIN_NOT_ALLOWED' ? html`<p class="muted small">Ask the administrator to authorize <code>${extra.hostname}</code> if it should be available.</p>` : ''}
  <p class="actions"><a class="btn btn-primary" href="/">Back to start</a>${code === 'RATE_LIMITED' || code === 'BUSY' || code === 'UPSTREAM_TIMEOUT' ? html` <button type="button" class="btn btn-ghost" data-back>Go back</button>` : ''}</p>
  ${requestId ? html`<p class="muted tiny">Reference: <code>${requestId}</code></p>` : ''}
</section>`;
  return layout({ title, body, bodyClass: 'page-error' });
}

/**
 * The sign-in page. A third-party identity provider validates the origin the
 * application is served from and the redirect URIs registered for its OAuth
 * client; a proxied page is served from this proxy's origin, so the provider
 * refuses it. Making it succeed would mean forging that origin or rewriting
 * the OAuth parameters, which this proxy will not do - so the request is
 * stopped before the provider is contacted, and explained here.
 *
 * Nothing sensitive reaches this page: `extra` holds only the hostname, its
 * origin and a category. No query string, code, token or cookie.
 */
function authFlowPage({ status, title, extra, requestId }) {
  const host = extra.hostname ? String(extra.hostname) : '';
  const origin = typeof extra.origin === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(extra.origin) ? extra.origin : '';
  const body = html`
<section class="error-card rise" aria-labelledby="error-title">
  <div class="error-icon">${icons.shield}</div>
  <p class="error-status">${status}</p>
  <h1 id="error-title">Sign-in isn't supported in proxied mode</h1>
  <p class="error-message">This website uses an authentication provider that requires its original website origin. The proxy cannot safely modify that authentication flow.</p>
  ${
    host
      ? html`<p class="muted small">The request to <code>${host}</code> was stopped here. Nothing was sent to the provider, and no password, authorization code, access token or authentication cookie was read, stored or forwarded.</p>`
      : ''
  }
  <ul class="auth-steps">
    <li>${icons.arrow}<span>To sign in, open ${origin ? html`<a href="${origin}/" rel="noopener noreferrer nofollow">${host}</a>` : 'the website'} directly in your browser, outside the proxy.</span></li>
    <li>${icons.globe}<span>The rest of the website keeps working through AnonView — only the sign-in step is refused.</span></li>
    <li>${icons.shield}<span>Administrators: if you run this application and its OAuth client, you can register this proxy's origin and redirect URI with the provider yourself (see the README). AnonView never alters anyone else's OAuth configuration.</span></li>
  </ul>
  <p class="actions"><a class="btn btn-primary" href="/">Back to start</a><button type="button" class="btn btn-ghost" data-back>Go back</button></p>
  ${requestId ? html`<p class="muted tiny">Reference: <code>${requestId}</code></p>` : ''}
</section>`;
  return layout({ title, body, bodyClass: 'page-error' });
}

/** JSON body for API-style clients. */
export function errorJson({ status, code, message, requestId = '' }) {
  return { error: { status, code, message, requestId } };
}

export { esc };
