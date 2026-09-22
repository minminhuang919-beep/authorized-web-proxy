import { html, icons, layout } from './layout.js';
import { searchForm } from './search-form.js';

const BADGES = {
  proxied: { cls: 'tag-ok', label: 'via proxy', title: 'Inside the authorized scope: opens through AnonView' },
  unauthorized: { cls: 'tag-warn', label: 'not authorized', title: 'Outside the authorized scope: opening it shows the "Website not authorized" page' },
  blocked: { cls: 'tag-danger', label: 'blocked', title: 'The administrator has blocked this website' },
  unsupported: { cls: '', label: 'unsupported address', title: 'This address uses a port, credentials or a scheme the proxy does not support' }
};

function fmtCount(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

function searchHref(query, { page = 1, mode = 'search' } = {}) {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set('page', String(page));
  if (mode) params.set('mode', mode);
  return `/search?${params.toString()}`;
}

/**
 * Search results page.
 * @param {object} opts
 * @param {string} opts.query
 * @param {'results'|'empty'|'error'|'unconfigured'} opts.state
 * @param {Array} [opts.results] annotated results ({ title, url, domain, snippet, state, href })
 * @param {number} [opts.page]
 * @param {boolean} [opts.hasNext]
 * @param {number|null} [opts.total]
 * @param {string} [opts.provider] provider label
 * @param {string[]} [opts.related]
 * @param {string} [opts.message] error message
 * @param {Array} [opts.quickLinks]
 * @param {boolean} [opts.searchEnabled]
 * @param {boolean} [opts.adminLoggedIn]
 * @param {string} [opts.searchReason] why search is unconfigured (shown to admins only)
 */
export function searchPage({ query, state, results = [], page = 1, hasNext = false, total = null, provider = '', related = [], message = '', quickLinks = [], searchEnabled = false, adminLoggedIn = false, searchReason = '' }) {
  const body = html`
<section class="results-page" aria-labelledby="results-title">
  ${searchForm({ value: query, searchEnabled, compact: true, autofocus: false })}
  <h1 id="results-title" class="visually-hidden">Search results for ${query}</h1>
  ${state === 'results' ? resultsBlock({ query, results, page, hasNext, total, provider, related }) : ''}
  ${state === 'empty' ? emptyBlock({ query, provider, page, quickLinks }) : ''}
  ${state === 'error' ? errorBlock({ query, page, message, adminLoggedIn, searchReason }) : ''}
  ${state === 'unconfigured' ? unconfiguredBlock({ query, quickLinks, adminLoggedIn, searchReason }) : ''}
</section>`;
  return layout({ title: state === 'unconfigured' ? 'Search' : `${query} – Search`, body, active: 'home', adminLoggedIn, bodyClass: 'page-search' });
}

function resultsBlock({ query, results, page, hasNext, total, provider, related }) {
  return html`
<p class="results-meta">${total ? `About ${fmtCount(total)} results` : `${results.length} result${results.length === 1 ? '' : 's'}`}${page > 1 ? ` · page ${page}` : ''} · via ${provider}</p>
<ol class="results" aria-label="Results">
  ${results.map((r, i) => resultItem(r, { top: page === 1 && i === 0 }))}
</ol>
${
  related.length
    ? html`<section class="related" aria-labelledby="related-title">
  <h2 id="related-title">Related searches</h2>
  <ul class="chip-list">${related.map((s) => html`<li><a class="chip" href="${searchHref(s)}">${s}</a></li>`)}</ul>
</section>`
    : ''
}
<nav class="pager" aria-label="Pagination">
  ${page > 1 ? html`<a class="btn btn-ghost" href="${searchHref(query, { page: page - 1 })}" rel="prev">${icons.arrowLeft} Previous</a>` : html`<span></span>`}
  <span class="pager-page">Page ${page}</span>
  ${hasNext ? html`<a class="btn btn-ghost" href="${searchHref(query, { page: page + 1 })}" rel="next">Next ${icons.arrow}</a>` : html`<span></span>`}
</nav>`;
}

function resultItem(r, { top = false } = {}) {
  const badge = BADGES[r.state] || BADGES.unauthorized;
  // Every result opens through /open, which runs the full authorization chain
  // and shows the secure "not authorized" page for anything outside the scope.
  return html`<li class="result is-${r.state}${top ? ' is-top' : ''}">
    ${top ? html`<span class="result-kicker">Top result</span>` : ''}
    <div class="result-source"><span class="result-host">${r.domain}</span> <span class="tag ${badge.cls}" title="${badge.title}">${badge.label}</span></div>
    <h2 class="result-title"><a href="${r.href}">${r.title}</a></h2>
    ${r.snippet ? html`<p class="result-snippet">${r.snippet}</p>` : ''}
  </li>`;
}

function emptyBlock({ query, provider, page, quickLinks }) {
  return html`
<div class="state-card rise" role="status">
  <div class="state-icon">${icons.search}</div>
  <h2>${page > 1 ? 'No more results' : 'No results'} for “${query}”</h2>
  <p class="muted">${page > 1 ? html`<a href="${searchHref(query)}">Back to the first page</a>.` : `${provider} found nothing for that. Try different words, or enter a website address or a shortcut.`}</p>
  ${quickLinksBlock(quickLinks)}
</div>`;
}

function errorBlock({ query, page, message, adminLoggedIn = false, searchReason = '' }) {
  return html`
<div class="state-card rise" role="alert">
  <div class="state-icon is-warn">${icons.alert}</div>
  <h2>Search is temporarily unavailable</h2>
  <p class="muted">${message}</p>
  <p class="actions"><a class="btn btn-primary" href="${searchHref(query, { page })}">Try again</a><a class="btn btn-ghost" href="/">Back to start</a></p>
  ${
    adminLoggedIn && searchReason
      ? html`<p class="muted small">Administrators: ${searchReason} — see <a href="/admin/search">Search diagnostics</a>.</p>`
      : ''
  }
</div>`;
}

function unconfiguredBlock({ query, quickLinks, adminLoggedIn, searchReason = '' }) {
  return html`
<div class="state-card rise" role="status">
  <div class="state-icon">${icons.search}</div>
  <h2>Web search isn't set up yet</h2>
  <p class="muted">“${query}” is not a shortcut or a website address, and this proxy has no search provider configured. You can open any website inside the authorized scope by typing its address${quickLinks.length ? ', or use one of the shortcuts below' : ''}.</p>
  ${quickLinksBlock(quickLinks)}
  ${
    adminLoggedIn
      ? html`<p class="muted small">Administrators: set <code>SEARCH_PROVIDER=bing</code> to switch web search on — it needs no account and no API key. Other backends are listed on the <a href="/admin/search">Search diagnostics</a> page.${searchReason ? html` Currently: ${searchReason}` : ''}</p>`
      : ''
  }
</div>`;
}

function quickLinksBlock(quickLinks) {
  if (!quickLinks.length) return '';
  return html`<nav class="quick-links" aria-label="Shortcuts">${quickLinks.map((s) => html`<a class="chip chip-link" href="/search?q=${s.shortcut}" title="${s.description || s.host}">${s.name}</a>`)}</nav>`;
}
