import { html } from '../layout.js';
import { adminShell } from './shell.js';

/**
 * Administrator-only search diagnostics.
 *
 * Everything on this page is derived from the running configuration and from
 * one real query sent to the backend. It deliberately shows only whether a
 * value is *present* — never the value itself — so an API key, a private
 * backend URL or the provider's own error text can never appear here.
 *
 * @param {object} opts
 * @param {{ kind: string, label: string, configured: boolean, reason: string, mode: string, defaultEndpoint: string }} opts.provider
 * @param {{ ok: boolean, configured: boolean, ms: number, results: number, error: string }} opts.check
 * @param {boolean} opts.urlRequired does this provider need SEARCH_PROVIDER_URL?
 * @param {boolean} opts.urlConfigured
 * @param {boolean} opts.keyRequired
 * @param {boolean} opts.keyConfigured
 * @param {string} opts.csrfToken
 */
export function searchDiagnosticsPage({ provider, check, urlRequired, urlConfigured, keyRequired, keyConfigured, csrfToken }) {
  const off = provider.kind === 'none';
  const configOk = !off && provider.configured;
  const body = html`
<section class="card" aria-labelledby="diag-title">
  <div class="card-head">
    <h2 id="diag-title">Status</h2>
  </div>
  <div class="table-wrap">
    <table class="table">
      <tbody>
        <tr>
          <td data-label="Check"><strong>Search provider</strong></td>
          <td data-label="Value">${off ? 'none' : provider.label || provider.kind}</td>
          <td data-label="State" class="right">${off ? state(false, 'not configured') : state(true, 'configured')}</td>
        </tr>
        <tr>
          <td data-label="Check"><strong>Configuration</strong></td>
          <td data-label="Value">${off ? html`<code>SEARCH_PROVIDER</code> is not set` : configOk ? 'every required setting is present' : provider.reason}</td>
          <td data-label="State" class="right">${state(configOk, configOk ? 'OK' : 'incomplete')}</td>
        </tr>
        <tr>
          <td data-label="Check"><strong>Provider URL</strong></td>
          <td data-label="Value">${providerUrlText({ off, urlRequired, urlConfigured, defaultEndpoint: provider.defaultEndpoint })}</td>
          <td data-label="State" class="right">${off ? state(false, 'n/a') : state(urlConfigured || !urlRequired, urlConfigured ? 'configured' : urlRequired ? 'not configured' : 'built in')}</td>
        </tr>
        ${
          keyRequired
            ? html`<tr>
          <td data-label="Check"><strong>API key</strong></td>
          <td data-label="Value">${keyConfigured ? html`set in <code>SEARCH_API_KEY</code> (never displayed)` : html`<code>SEARCH_API_KEY</code> is empty`}</td>
          <td data-label="State" class="right">${state(keyConfigured, keyConfigured ? 'configured' : 'not configured')}</td>
        </tr>`
            : ''
        }
        <tr>
          <td data-label="Check"><strong>Provider connectivity</strong></td>
          <td data-label="Value">${connectivityText({ off, check })}</td>
          <td data-label="State" class="right">${off ? state(false, 'not tested') : state(check.ok, check.ok ? 'OK' : 'FAILED')}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="actions">
    <a class="btn btn-primary" href="/admin/search">Test again</a>
    <a class="btn btn-ghost" href="/health/search">JSON</a>
  </p>
  <p class="muted small">The connectivity test sends one real query to the backend. Credentials and backend URLs are never shown on this page or in <code>/health/search</code>.</p>
</section>

<section class="card">
  <h2>Backends</h2>
  <p class="muted">Set <code>SEARCH_PROVIDER</code> in your hosting service's environment, then redeploy.</p>
  <div class="table-wrap">
    <table class="table">
      <thead><tr><th scope="col">SEARCH_PROVIDER</th><th scope="col">Needs</th><th scope="col">Notes</th></tr></thead>
      <tbody>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>bing</code>${provider.kind === 'bing' ? html` <span class="tag tag-ok">in use</span>` : ''}</td>
          <td data-label="Needs">nothing</td>
          <td data-label="Notes">Bing's RSS result feed. No account, no API key, nothing to host — the default for the free deployment.</td>
        </tr>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>searxng</code>${provider.kind === 'searxng' ? html` <span class="tag tag-ok">in use</span>` : ''}</td>
          <td data-label="Needs"><code>SEARCH_PROVIDER_URL</code></td>
          <td data-label="Notes">A SearXNG instance you host, with <code>json</code> in its <code>search.formats</code>.</td>
        </tr>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>brave</code>${provider.kind === 'brave' ? html` <span class="tag tag-ok">in use</span>` : ''}</td>
          <td data-label="Needs"><code>SEARCH_API_KEY</code></td>
          <td data-label="Notes">Brave Search API.</td>
        </tr>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>google</code>${provider.kind === 'google' ? html` <span class="tag tag-ok">in use</span>` : ''}</td>
          <td data-label="Needs"><code>SEARCH_API_KEY</code>, <code>SEARCH_ENGINE_ID</code></td>
          <td data-label="Notes">Google Programmable Search JSON API.</td>
        </tr>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>proxy</code>${provider.kind === 'proxy' ? html` <span class="tag tag-ok">in use</span>` : ''}</td>
          <td data-label="Needs"><code>SEARCH_PROVIDER_URL</code> with <code>{q}</code></td>
          <td data-label="Notes">No results page: the query is opened on a search website through the proxy. Its host must be inside the authorized scope.</td>
        </tr>
        <tr>
          <td data-label="SEARCH_PROVIDER"><code>none</code>${off ? html` <span class="tag">in use</span>` : ''}</td>
          <td data-label="Needs">—</td>
          <td data-label="Notes">Web search off. Shortcuts and website addresses still work.</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section class="card">
  <h2>Result safety</h2>
  <p class="muted">A search backend never widens what this proxy will open. Every result on the results page links to <code>/open?url=…</code>, which runs the same chain as a typed address: authorized scope → blacklist → URL validation → SSRF address checks at connection time → redirect validation. Results outside the scope are shown with a <span class="tag tag-warn">not authorized</span> badge and refused when clicked.</p>
</section>`;
  return adminShell({ title: 'Search diagnostics', active: 'search', csrfToken, body, subtitle: 'Whether the configured web-search backend is reachable.' });
}

function state(ok, label) {
  return html`<span class="tag ${ok ? 'tag-ok' : 'tag-danger'}">${label}</span>`;
}

// The value itself is never printed: an operator-supplied backend may be an
// internal host, so it is reported only as present or absent. The built-in
// endpoint is a constant in the source and safe to name.
function providerUrlText({ off, urlRequired, urlConfigured, defaultEndpoint }) {
  if (off) return '—';
  if (urlConfigured) return html`set in <code>SEARCH_PROVIDER_URL</code> (never displayed)`;
  if (urlRequired) return html`<code>SEARCH_PROVIDER_URL</code> is not set`;
  return defaultEndpoint ? html`built-in endpoint <code class="domain">${defaultEndpoint}</code>` : 'not needed';
}

function connectivityText({ off, check }) {
  if (off) return 'no provider to test';
  if (check.ok) return `answered with ${check.results} result${check.results === 1 ? '' : 's'} in ${check.ms} ms`;
  return check.error || 'the backend did not answer';
}
