import { html, icons, raw } from './layout.js';

/**
 * The search box shared by the homepage and the results page: a combobox
 * (suggestions are filled in by /_/app.js from /suggest) that submits to
 * /search. Accepts a shortcut, a website address or a search query.
 * @param {object} opts
 * @param {string} [opts.value]
 * @param {string} [opts.error]
 * @param {boolean} [opts.searchEnabled] whether free-text web search is available
 * @param {boolean} [opts.compact] results-page variant
 * @param {boolean} [opts.autofocus]
 * @param {string|object} [opts.hint] text/markup shown under the box (defaults depend on `searchEnabled`)
 */
export function searchForm({ value = '', error = '', searchEnabled = false, compact = false, autofocus = true, hint = '' } = {}) {
  const placeholder = searchEnabled ? 'Search the web or open a configured site…' : 'Open a configured site or enter an address…';
  return html`
<form class="search${compact ? ' search-compact' : ' rise delay-1'}" method="get" action="/search" id="search-form" role="search" novalidate data-search-enabled="${searchEnabled ? '1' : '0'}">
  <label for="q" class="visually-hidden">Search the web or open a configured site</label>
  <div class="search-field">
    <div class="search-box${error ? ' has-error' : ''}">
      <span class="search-icon">${icons.search}</span>
      <input id="q" name="q" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggestions" aria-haspopup="listbox"
             autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"
             placeholder="${placeholder}" value="${value}" maxlength="4096"${autofocus ? raw(' autofocus') : ''}
             aria-describedby="${error ? 'form-error ' : ''}search-hint"${error ? raw(' aria-invalid="true"') : ''}>
      <button type="submit" class="btn btn-primary search-submit" id="search-button">
        <span class="btn-label">${searchEnabled ? 'Search' : 'Open'}</span>
        <span class="btn-icon">${icons.arrow}</span>
        <span class="spinner" aria-hidden="true"></span>
      </button>
    </div>
    <div class="suggestions hidden" id="suggestions" role="listbox" aria-label="Suggestions"></div>
  </div>
  <p class="form-error${error ? '' : ' hidden'}" id="form-error" role="alert">${error}</p>
  <p class="search-hint${compact ? ' visually-hidden' : ''}" id="search-hint">${hint || defaultHint(searchEnabled)}</p>
</form>`;
}

function defaultHint(searchEnabled) {
  return searchEnabled
    ? html`A configured shortcut opens that site; a website address such as <code>example.com</code> opens through the proxy; anything else searches the web.`
    : html`A configured shortcut opens that site; a website address such as <code>example.com</code> opens through the proxy — <code>https://</code> is optional.`;
}
