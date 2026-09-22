import { esc, html, icons, layout } from './layout.js';

const TITLES = {
  INVALID_URL: 'Invalid address',
  UNSUPPORTED_PROTOCOL: 'Unsupported address',
  DOMAIN_NOT_ALLOWED: 'Website not authorized',
  DOMAIN_BLACKLISTED: 'Website unavailable',
  AUTH_FLOW_UNSUPPORTED: 'Sign-in required',
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

/** A hand-off link is only ever a plain http(s) origin (+ path) — never a query. */
function safeHandoffUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  // Defence in depth: whatever built this, refuse to render a query or a
  // fragment, so an authorization code or token cannot end up in an href.
  if (url.search || url.hash || url.username || url.password) return '';
  return url.href;
}

/**
 * The sign-in hand-off page.
 *
 * A third-party identity provider validates the origin the application is
 * served from and the redirect URIs registered for its OAuth client; a proxied
 * page is served from this proxy's origin, so the provider refuses it. Making
 * it succeed would mean forging that origin or rewriting the OAuth parameters,
 * which this proxy will not do — so the request is stopped before the provider
 * is contacted, and the visitor is sent to sign in the normal way instead.
 *
 * "Continue to sign in" is an ordinary link to the provider's (or the
 * application's) own origin, opened outside the proxy with `rel="noopener
 * noreferrer"` so nothing about the proxy session travels with it. It carries
 * no OAuth parameters: `extra` holds only the hostname, a category and those
 * bare links — no query string, code, token, `state`, `nonce` or cookie — and
 * `safeHandoffUrl` refuses to render anything that has a query at all.
 *
 * The HTTP status stays 501 (the proxy genuinely will not implement this hop),
 * but it is not displayed: this is a hand-off, not a failure.
 */
function authFlowPage({ status, title, extra, requestId }) {
  const host = extra.hostname ? String(extra.hostname) : '';
  const origin = typeof extra.origin === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(extra.origin) ? extra.origin : '';
  const signInUrl = safeHandoffUrl(extra.signInUrl) || safeHandoffUrl(origin ? `${origin}/` : '');
  const returnUrl = safeHandoffUrl(extra.returnUrl);
  const returnHost = extra.returnHost ? String(extra.returnHost) : '';
  const body = html`
<section class="error-card rise" aria-labelledby="error-title">
  <div class="error-icon">${icons.shield}</div>
  <h1 id="error-title">Sign-in required</h1>
  <p class="error-message">This website uses a third-party sign-in provider that must run on the provider's original website.</p>
  <p class="actions">
    ${
      signInUrl
        ? html`<a class="btn btn-primary btn-lg" href="${signInUrl}" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer">Continue to sign in ${icons.external}</a>`
        : ''
    }
    <button type="button" class="btn btn-ghost" data-back>Go back</button>
  </p>
  ${
    signInUrl
      ? html`<p class="muted small">Opens <code>${host}</code> directly in your browser, outside the proxy, so the provider sees its own website exactly as it expects. Sign in there, then return here.</p>`
      : ''
  }
  ${
    returnUrl
      ? html`<p class="muted small">You were using <a href="${returnUrl}" target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer"><code>${returnHost}</code></a> — open it directly to sign in and carry on there.</p>`
      : ''
  }
  <ul class="auth-steps">
    <li>${icons.shield}<span>The request was stopped here. Nothing was sent to the provider, and no password, authorization code, access token, <code>state</code>, <code>nonce</code> or authentication cookie was read, logged, stored or forwarded.</span></li>
    <li>${icons.globe}<span>The rest of the website keeps working through AnonView — only the sign-in step is handed over to your browser.</span></li>
    <li>${icons.arrow}<span>Administrators: if you run this application and its OAuth client, register this proxy's origin and redirect URI with the provider yourself, then list the host in <code>PROXY_AUTH_FLOW_HOSTS</code> (see the README). AnonView never alters anyone else's OAuth configuration.</span></li>
  </ul>
  <p class="actions"><a class="btn btn-ghost" href="/">Back to start</a></p>
  ${requestId ? html`<p class="muted tiny">Reference: <code>${requestId}</code> · ${status}</p>` : ''}
</section>`;
  return layout({ title, body, bodyClass: 'page-error' });
}

/** JSON body for API-style clients. */
export function errorJson({ status, code, message, requestId = '' }) {
  return { error: { status, code, message, requestId } };
}

export { esc };
