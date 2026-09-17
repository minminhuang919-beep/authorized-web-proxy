import { esc, html, icons, layout } from './layout.js';

const TITLES = {
  INVALID_URL: 'Invalid address',
  UNSUPPORTED_PROTOCOL: 'Unsupported address',
  DOMAIN_NOT_ALLOWED: 'Website not authorized',
  DOMAIN_BLACKLISTED: 'Website unavailable',
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

/** JSON body for API-style clients. */
export function errorJson({ status, code, message, requestId = '' }) {
  return { error: { status, code, message, requestId } };
}

export { esc };
