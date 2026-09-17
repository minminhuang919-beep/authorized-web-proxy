import { html, icons, layout } from './layout.js';

/**
 * @param {object} opts
 * @param {string[]} opts.scope authorized domain patterns (may be empty)
 * @param {boolean} opts.showScope whether to list them
 * @param {boolean} [opts.adminLoggedIn]
 */
export function aboutPage({ scope, showScope, adminLoggedIn = false }) {
  const body = html`
<article class="prose">
  <header class="prose-header">
    <h1>About AnonView</h1>
    <p class="lead">AnonView opens websites on your behalf. The site sees the proxy's address instead of yours, and the page is streamed back to you with every link, image and stylesheet routed through the proxy.</p>
  </header>

  <section class="steps" aria-label="How it works">
    <div class="step"><span class="step-n">1</span><h2>Type an address</h2><p>Enter a website or URL on the start page. <code>https://</code> is optional; only <code>http</code> and <code>https</code> addresses are accepted.</p></div>
    <div class="step"><span class="step-n">2</span><h2>We check it</h2><p>The destination must be inside the authorized scope, must not be blocked by the administrator, and must pass the network safety checks.</p></div>
    <div class="step"><span class="step-n">3</span><h2>We fetch and render it</h2><p>The page is fetched server-side and rewritten so that browsing continues through AnonView. Site cookies stay in a short-lived server session and never reach your browser.</p></div>
  </section>

  <section class="cards-2">
    <div class="card">
      <h2>${icons.shield} Authorized scope</h2>
      <p>Only websites an administrator has authorized can be opened. Anything else shows a “Website not authorized” page — AnonView is not an open proxy.</p>
      ${
        showScope
          ? scope.length
            ? html`<ul class="chip-list" aria-label="Authorized websites">${scope.map((p) => html`<li>${p.startsWith('*.') ? html`<span class="chip">${p}</span>` : html`<a class="chip" href="/open?url=${encodeURIComponent(`https://${p}/`)}">${p}</a>`}</li>`)}</ul>`
            : html`<p class="muted">No websites have been authorized yet.</p>`
          : ''
      }
    </div>
    <div class="card">
      <h2>${icons.block} Blocked websites</h2>
      <p>Administrators can additionally block individual websites inside the scope. Those show a “Website unavailable” page. Blocking a domain also blocks all of its subdomains.</p>
    </div>
  </section>

  <section class="card">
    <h2>What AnonView does not do</h2>
    <p>It does not defeat logins, CAPTCHAs, bot protection or content filters, and it does not support WebSockets or service workers. Some heavily scripted pages may not work perfectly.</p>
  </section>
</article>`;
  return layout({ title: 'About', body, active: 'about', adminLoggedIn });
}
