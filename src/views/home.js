import { html, icons, layout } from './layout.js';
import { searchForm } from './search-form.js';

/**
 * Search-engine style homepage: one centred box that takes a shortcut, a
 * website address or a search query, with the configured shortcuts beneath.
 * @param {object} opts
 * @param {string} [opts.error] message to show under the search box
 * @param {string} [opts.value] previous input value
 * @param {boolean} [opts.adminLoggedIn]
 * @param {Array<{ name: string, shortcut: string, host: string, description: string }>} [opts.quickLinks]
 * @param {boolean} [opts.searchEnabled] whether a web search provider is configured
 */
export function homePage({ error = '', value = '', adminLoggedIn = false, quickLinks = [], searchEnabled = false } = {}) {
  const example = quickLinks[0]?.shortcut || 'google';
  const hint = searchEnabled
    ? html`Try a shortcut like <code>${example}</code>, a website such as <code>example.com</code>, or anything else to search the web.`
    : html`Try a shortcut like <code>${example}</code> or a website such as <code>example.com</code> — <code>https://</code> is optional.`;
  const body = html`
<section class="hero" aria-labelledby="hero-title">
  <div class="logo rise">
    ${icons.mark}
    <h1 id="hero-title" class="wordmark">AnonView</h1>
  </div>
  ${searchForm({ value, error, searchEnabled, hint: quickLinks.length ? hint : '' })}
  ${
    quickLinks.length
      ? html`<nav class="quick-links rise delay-2" aria-label="Shortcuts">
    ${quickLinks.map((s) => html`<a class="chip chip-link" href="/search?q=${s.shortcut}" title="${s.description || s.host}">${s.name}</a>`)}
  </nav>`
      : ''
  }
  <p class="tagline rise delay-3">${searchEnabled ? 'Search the web or open a configured site.' : 'Open a configured site or any authorized website.'}</p>
  <ul class="perks rise delay-3" aria-label="Highlights">
    <li>${icons.shield}<span>Your address stays hidden</span></li>
    <li>${icons.block}<span>Only authorized sites</span></li>
    <li>${icons.clock}<span>Nothing is stored</span></li>
  </ul>
</section>`;
  return layout({ title: 'Private browsing', body, active: 'home', adminLoggedIn, bodyClass: 'page-home' });
}
