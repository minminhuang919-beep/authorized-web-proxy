import { html, icons } from '../layout.js';
import { adminShell, fmtBytes, fmtDate, fmtDuration } from './shell.js';

const ACTION_LABELS = {
  'blacklist.add': 'Blacklisted',
  'blacklist.remove': 'Removed from blacklist',
  'scope.add': 'Authorized',
  'scope.remove': 'Removed from scope',
  'admin.login': 'Signed in'
};

/**
 * @param {object} opts
 * @param {object} opts.health   healthSnapshot()
 * @param {Array} opts.changes   recent audit entries
 * @param {string} opts.csrfToken
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function dashboardPage({ health, changes, csrfToken, notice = '', error = '' }) {
  const healthy = health.status === 'ok';
  const body = html`
<section class="stat-grid" aria-label="Overview">
  <a class="stat" href="/admin/blacklist">
    <span class="stat-icon">${icons.block}</span>
    <span class="stat-value">${health.blacklist.size}</span>
    <span class="stat-label">Blacklisted domain${health.blacklist.size === 1 ? '' : 's'}</span>
  </a>
  <a class="stat" href="/admin/settings">
    <span class="stat-icon">${icons.shield}</span>
    <span class="stat-value">${health.allowlist.size}</span>
    <span class="stat-label">Authorized scope entr${health.allowlist.size === 1 ? 'y' : 'ies'}</span>
  </a>
  <div class="stat">
    <span class="stat-icon ${healthy ? 'ok' : 'warn'}">${healthy ? icons.check : icons.alert}</span>
    <span class="stat-value"><span class="dot ${healthy ? 'ok' : 'warn'}"></span>${healthy ? 'Healthy' : 'Degraded'}</span>
    <span class="stat-label">Proxy status · <a href="/health"><code>/health</code></a></span>
  </div>
  <div class="stat">
    <span class="stat-icon">${icons.clock}</span>
    <span class="stat-value">${fmtDuration(health.uptimeSeconds)}</span>
    <span class="stat-label">Uptime</span>
  </div>
</section>

<section class="cards-2">
  <div class="card">
    <h2>Recent configuration changes</h2>
    ${
      changes.length === 0
        ? html`<div class="empty"><p>No changes since the service started.</p><p class="muted small">Additions and removals made here will be listed.</p></div>`
        : html`<ol class="timeline">
          ${changes.map(
            (c) => html`<li>
            <span class="timeline-time">${fmtDate(c.at)}</span>
            <span class="timeline-body"><strong>${ACTION_LABELS[c.action] || c.action}</strong> <code>${c.target}</code>${c.detail ? html` <span class="muted">— ${c.detail}</span>` : ''}${c.actor ? html` <span class="muted tiny">by ${c.actor}</span>` : ''}</span>
          </li>`
          )}
        </ol>`
    }
  </div>
  <div class="card">
    <h2>Service</h2>
    <dl class="kv">
      <div><dt>Version</dt><dd>${health.version}</dd></div>
      <div><dt>Runtime</dt><dd>Node ${health.node} · ${health.platform}</dd></div>
      <div><dt>Memory (RSS)</dt><dd>${fmtBytes(health.memory.rss)}</dd></div>
      <div><dt>Active sessions</dt><dd>${health.sessions.active}</dd></div>
      <div><dt>Upstream in flight</dt><dd>${health.upstream.inFlight}</dd></div>
      <div><dt>Upstream requests</dt><dd>${health.upstream.total} <span class="muted">(${health.upstream.errors} errors, ${health.upstream.timeouts} timeouts)</span></dd></div>
      <div><dt>Blocked addresses</dt><dd>${health.upstream.blockedAddresses}</dd></div>
      <div><dt>Admin data</dt><dd>${health.blacklist.persistent ? 'persisted to disk' : html`<span class="tag tag-warn">memory only</span> lost on restart`}</dd></div>
    </dl>
  </div>
</section>`;
  return adminShell({ title: 'Dashboard', subtitle: 'Overview of the proxy and its configuration.', active: 'dashboard', csrfToken, body, notice, error });
}
