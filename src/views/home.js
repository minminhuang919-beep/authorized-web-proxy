import { html, icons, layout } from './layout.js';

/**
 * Search-engine style homepage.
 * @param {object} opts
 * @param {string} [opts.error] message to show under the search box
 * @param {string} [opts.value] previous input value
 * @param {boolean} [opts.adminLoggedIn]
 */
export function homePage({ error = '', value = '', adminLoggedIn = false } = {}) {
  const body = html`
<section class="hero" aria-labelledby="hero-title">
  <div class="logo rise">
    ${icons.mark}
    <h1 id="hero-title" class="wordmark">AnonView</h1>
  </div>
  <form class="search rise delay-1" method="get" action="/open" id="open-form" novalidate>
    <label for="url" class="visually-hidden">Website or URL</label>
    <div class="search-box${error ? ' has-error' : ''}">
      <span class="search-icon">${icons.search}</span>
      <input id="url" name="url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="Enter a website or URL…" value="${value}" required maxlength="4096" autofocus
             aria-describedby="${error ? 'form-error ' : ''}search-hint" ${error ? 'aria-invalid="true"' : ''}>
      <button type="submit" class="btn btn-primary search-submit" id="open-button">
        <span class="btn-label">Open</span>
        <span class="btn-icon">${icons.arrow}</span>
        <span class="spinner" aria-hidden="true"></span>
      </button>
    </div>
    <p class="form-error${error ? '' : ' hidden'}" id="form-error" role="alert">${error}</p>
    <p class="search-hint" id="search-hint">Type a domain such as <code>example.com</code> — <code>https://</code> is optional.</p>
  </form>
  <p class="tagline rise delay-2">Fast private browsing for authorized websites.</p>
  <ul class="perks rise delay-3" aria-label="Highlights">
    <li>${icons.shield}<span>Your address stays hidden</span></li>
    <li>${icons.block}<span>Only authorized sites</span></li>
    <li>${icons.clock}<span>Nothing is stored</span></li>
  </ul>
</section>`;
  return layout({ title: 'Private browsing', body, active: 'home', adminLoggedIn, bodyClass: 'page-home' });
}
