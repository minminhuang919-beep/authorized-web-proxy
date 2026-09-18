import { html, icons, layout } from './layout.js';

/**
 * @param {object} opts
 * @param {string[]} opts.scope authorized domain patterns (may be empty)
 * @param {boolean} opts.showScope whether to list them
 * @param {Array<{ name: string, shortcut: string, host: string, description: string }>} [opts.shortcuts]
 * @param {boolean} [opts.searchEnabled]
 * @param {string} [opts.searchLabel]
 * @param {boolean} [opts.adminLoggedIn]
 */
export function aboutPage({ scope, showScope, shortcuts = [], searchEnabled = false, searchLabel = '', adminLoggedIn = false }) {
  const body = html`
<article class="prose">
  <header class="prose-header">
    <h1>About AnonView</h1>
    <p class="lead">AnonView opens websites on your behalf. The site sees the proxy's address instead of yours, and the page is streamed back to you with every link, image and stylesheet routed through the proxy.</p>
  </header>

  <section class="steps" aria-label="How it works">
    <div class="step"><span class="step-n">1</span><h2>Type something</h2><p>A shortcut such as <code>${shortcuts[0]?.shortcut || 'google'}</code>, a website such as <code>example.com</code> (<code>https://</code> is optional)${searchEnabled ? ', or a few words to search the web' : ''}. Only <code>http</code> and <code>https</code> addresses are accepted.</p></div>
    <div class="step"><span class="step-n">2</span><h2>We check it</h2><p>The destination — whether typed or behind a shortcut — must be inside the authorized scope, must not be blocked by the administrator, and must pass the network safety checks.</p></div>
    <div class="step"><span class="step-n">3</span><h2>We fetch and render it</h2><p>The page is fetched server-side and rewritten so that browsing continues through AnonView. Site cookies stay in a short-lived server session and never reach your browser.</p></div>
  </section>

  <section class="cards-2">
    <div class="card">
      <h2>${icons.bolt} Shortcuts</h2>
      <p>The administrator can define short names for websites inside the scope. Type the name on the start page — matching ignores case — and the site opens through the proxy.</p>
      ${
        shortcuts.length
          ? html`<ul class="chip-list" aria-label="Shortcuts">${shortcuts.map((s) => html`<li><a class="chip" href="/search?q=${s.shortcut}" title="${s.description || s.host}">${s.name} <span class="muted">· ${s.shortcut}</span></a></li>`)}</ul>`
          : html`<p class="muted">No shortcuts have been configured yet.</p>`
      }
    </div>
    <div class="card">
      <h2>${icons.search} Web search</h2>
      ${
        searchEnabled
          ? html`<p>Anything that is not a shortcut or an address is searched with <strong>${searchLabel}</strong>, the provider chosen by the administrator. Results inside the authorized scope open through the proxy; others are marked.</p>`
          : html`<p>Web search is not enabled on this proxy. The administrator can connect a search provider; until then, enter website addresses or shortcuts.</p>`
      }
    </div>
  </section>

  <section class="cards-2">
    <div class="card">
      <h2>${icons.shield} Authorized scope</h2>
      <p>Only websites an administrator has authorized can be opened. Anything else shows a “Website not authorized” page — AnonView is not an open proxy.</p>
      ${
        showScope
          ? scope.includes('*')
            ? html`<p>Every website is authorized. The administrator's blacklist and the network safety checks still apply.</p>`
            : scope.length
            ? html`<ul class="chip-list" aria-label="Authorized websites">${scope.map((p) => html`<li>${p.startsWith('*.') ? html`<span class="chip">${p}</span>` : html`<a class="chip" href="/open?url=${encodeURIComponent(`https://${p}/`)}">${p}</a>`}</li>`)}</ul>`
            : html`<p class="muted">No websites have been authorized yet.</p>`
          : ''
      }
    </div>
    <div class="card">
      <h2>${icons.block} Blocked websites</h2>
      <p>Administrators can additionally block individual websites inside the scope. Those show a “Website unavailable” page. Blocking a domain also blocks all of its subdomains and disables any shortcut pointing at it.</p>
    </div>
  </section>

  <section class="card">
    <h2>What AnonView does not do</h2>
    <p>It does not defeat logins, CAPTCHAs, bot protection or content filters, and it does not support WebSockets or service workers. Some heavily scripted pages may not work perfectly.</p>
  </section>
</article>`;
  return layout({ title: 'About', body, active: 'about', adminLoggedIn });
}
