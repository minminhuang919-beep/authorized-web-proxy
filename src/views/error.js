import { esc, html, layout } from './layout.js';

const TITLES = {
  INVALID_URL: 'Invalid address',
  UNSUPPORTED_PROTOCOL: 'Unsupported address',
  DOMAIN_NOT_ALLOWED: 'Website not authorized',
  BLOCKED_ADDRESS: 'Website not reachable',
  UPSTREAM_ERROR: 'Website unavailable',
  UPSTREAM_TIMEOUT: 'Website timed out',
  RESPONSE_TOO_LARGE: 'Response too large',
  REQUEST_TOO_LARGE: 'Request too large',
  RATE_LIMITED: 'Too many requests',
  BUSY: 'Proxy busy',
  NOT_FOUND: 'Page not found',
  INTERNAL: 'Something went wrong'
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
  const body = html`
<section class="error-card">
  <p class="error-status">${status}</p>
  <h1>${title}</h1>
  <p class="error-message">${message}</p>
  ${extra.redirectTarget ? html`<p class="muted">The website tried to send you to <code>${extra.redirectTarget}</code>, which is not on the allowlist, so the redirect was stopped.</p>` : ''}
  ${extra.hostname && code === 'DOMAIN_NOT_ALLOWED' ? html`<p class="muted">Ask the administrator to add <code>${extra.hostname}</code> if it should be available.</p>` : ''}
  <p class="actions"><a class="button" href="/">Back to start</a></p>
  ${requestId ? html`<p class="muted small">Reference: <code>${requestId}</code></p>` : ''}
</section>`;
  return layout({ title, body });
}

/** JSON body for API-style clients. */
export function errorJson({ status, code, message, requestId = '' }) {
  return { error: { status, code, message, requestId } };
}

export { esc };
