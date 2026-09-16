import { html, layout } from './layout.js';

/**
 * @param {object} opts
 * @param {string[]} opts.allowedPatterns
 * @param {boolean} opts.showAllowlist
 * @param {string} [opts.error] message to show above the form
 * @param {string} [opts.value] previous input value
 */
export function homePage({ allowedPatterns, showAllowlist, error = '', value = '' }) {
  const body = html`
<section class="hero">
  <h1>Browse authorized sites, privately.</h1>
  <p class="lead">
    AnonView fetches the page on the server and shows it to you, so the website
    sees the proxy's address instead of yours. Only websites on this proxy's
    allowlist can be opened.
  </p>
  <form class="open-form" method="get" action="/open" id="open-form" novalidate>
    <label for="url" class="visually-hidden">Web address</label>
    <div class="open-row">
      <input id="url" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="https://example.com/" value="${value}" required maxlength="4096" autofocus>
      <button type="submit" id="open-button">
        <span class="button-label">Open</span>
        <span class="spinner" aria-hidden="true"></span>
      </button>
    </div>
    <p class="form-error${error ? '' : ' hidden'}" id="form-error" role="alert">${error}</p>
    <p class="form-hint">Tip: you can type a domain without <code>https://</code>.</p>
  </form>
</section>
${showAllowlist ? allowlistSection(allowedPatterns) : ''}
<section class="info-grid">
  <article>
    <h2>Only authorized websites</h2>
    <p>Requests to any domain that is not explicitly allowlisted are refused. IP addresses, custom ports, local and private networks are always blocked.</p>
  </article>
  <article>
    <h2>Nothing is stored</h2>
    <p>Site cookies are kept in a short-lived server-side session so they never reach your browser, and they are discarded after a period of inactivity.</p>
  </article>
  <article>
    <h2>Not a bypass tool</h2>
    <p>The proxy does not defeat logins, CAPTCHAs, bot protection or content filters. Some pages that rely on heavy client-side scripting may not work perfectly.</p>
  </article>
</section>`;
  return layout({ title: 'Anonymous View', body });
}

function allowlistSection(patterns) {
  if (patterns.length === 0) {
    return html`<section class="allowlist"><h2>Allowed websites</h2><p class="muted">No websites have been authorized yet. An administrator can add domains in the admin area.</p></section>`;
  }
  return html`<section class="allowlist">
  <h2>Allowed websites</h2>
  <ul class="chip-list">
    ${patterns.map((p) => html`<li>${p.startsWith('*.') ? html`<span class="chip">${p}</span>` : html`<a class="chip" href="/open?url=${encodeURIComponent(`https://${p}/`)}">${p}</a>`}</li>`)}
  </ul>
</section>`;
}
