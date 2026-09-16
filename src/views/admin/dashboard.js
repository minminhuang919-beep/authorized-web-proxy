import { html, layout } from '../layout.js';

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

/**
 * @param {object} opts
 * @param {Array<{pattern: string, source: string, addedAt: string|null}>} opts.domains
 * @param {object} opts.health output of the health snapshot
 * @param {string} opts.csrfToken
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function dashboardPage({ domains, health, csrfToken, notice = '', error = '' }) {
  const body = html`
<section class="card">
  <h1>Allowlist</h1>
  <p class="muted">Domains that visitors are allowed to open through the proxy. Entries from the environment
  (<code>PROXY_ALLOWED_DOMAINS</code>) are locked; entries added here are stored in the data directory and survive restarts.</p>
  <p class="form-notice${notice ? '' : ' hidden'}" role="status">${notice}</p>
  <p class="form-error${error ? '' : ' hidden'}" role="alert">${error}</p>
  <form method="post" action="/admin/domains" class="open-row">
    <input type="hidden" name="_csrf" value="${csrfToken}">
    <label for="domain" class="visually-hidden">Domain to add</label>
    <input id="domain" name="domain" type="text" placeholder="example.com or *.example.com" required maxlength="253" autocomplete="off" spellcheck="false">
    <button type="submit">Add domain</button>
  </form>
  <table class="domains">
    <thead><tr><th>Domain</th><th>Source</th><th>Added</th><th></th></tr></thead>
    <tbody>
      ${domains.length === 0 ? html`<tr><td colspan="4" class="muted">No domains yet.</td></tr>` : ''}
      ${domains.map(
        (d) => html`<tr>
        <td><code>${d.pattern}</code></td>
        <td>${d.source === 'env' ? html`<span class="tag">environment</span>` : html`<span class="tag tag-admin">admin</span>`}</td>
        <td>${d.addedAt ? d.addedAt.slice(0, 19).replace('T', ' ') : '—'}</td>
        <td class="right">${
          d.source === 'env'
            ? html`<span class="muted small">locked</span>`
            : html`<form method="post" action="/admin/domains/remove" class="inline-form">
                <input type="hidden" name="_csrf" value="${csrfToken}">
                <input type="hidden" name="domain" value="${d.pattern}">
                <button type="submit" class="danger small">Remove</button>
              </form>`
        }</td>
      </tr>`
      )}
    </tbody>
  </table>
</section>
<section class="card">
  <h2>Status</h2>
  <dl class="stats">
    <div><dt>Status</dt><dd>${health.status}</dd></div>
    <div><dt>Version</dt><dd>${health.version}</dd></div>
    <div><dt>Uptime</dt><dd>${fmtDuration(health.uptimeSeconds)}</dd></div>
    <div><dt>Node.js</dt><dd>${health.node}</dd></div>
    <div><dt>Platform</dt><dd>${health.platform}</dd></div>
    <div><dt>Memory (RSS)</dt><dd>${fmtBytes(health.memory.rss)}</dd></div>
    <div><dt>Heap used</dt><dd>${fmtBytes(health.memory.heapUsed)}</dd></div>
    <div><dt>Allowed domains</dt><dd>${health.allowlist.size}</dd></div>
    <div><dt>Active sessions</dt><dd>${health.sessions.active}</dd></div>
    <div><dt>Upstream in flight</dt><dd>${health.upstream.inFlight}</dd></div>
    <div><dt>Upstream requests</dt><dd>${health.upstream.total}</dd></div>
    <div><dt>Upstream errors</dt><dd>${health.upstream.errors}</dd></div>
    <div><dt>Upstream timeouts</dt><dd>${health.upstream.timeouts}</dd></div>
    <div><dt>Blocked addresses</dt><dd>${health.upstream.blockedAddresses}</dd></div>
  </dl>
  <p class="muted small">Machine-readable health: <a href="/health"><code>/health</code></a></p>
</section>`;
  return layout({ title: 'Admin', body, admin: true, csrfToken });
}
