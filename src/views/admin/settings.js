import { html, icons } from '../layout.js';
import { adminShell, fmtDate } from './shell.js';

/**
 * @param {object} opts
 * @param {Array<{pattern: string, source: string, addedAt: string|null}>} opts.scope
 * @param {boolean} opts.persistent
 * @param {object} opts.settings read-only configuration values
 * @param {string} opts.csrfToken
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function settingsPage({ scope, persistent, settings, csrfToken, notice = '', error = '' }) {
  const body = html`
<section class="card" aria-labelledby="scope-title">
  <div class="card-head">
    <h2 id="scope-title">Authorized scope <span class="count">${scope.length}</span></h2>
  </div>
  <p class="muted">The websites visitors are allowed to open. Everything outside this scope is refused — the blacklist only narrows it further. <code>example.com</code> matches exactly that host; <code>*.example.com</code> matches its subdomains (list both for both); <code>*</code> alone authorizes every website. Entries from <code>PROXY_ALLOWED_DOMAINS</code> are locked.</p>
  <form method="post" action="/admin/domains" class="add-form">
    <input type="hidden" name="_csrf" value="${csrfToken}">
    <label class="field grow">
      <span>Domain or pattern</span>
      <input name="domain" type="text" placeholder="example.com or *.example.com" required maxlength="253" autocomplete="off" spellcheck="false">
    </label>
    <button type="submit" class="btn btn-primary">Authorize</button>
  </form>
  ${
    scope.length === 0
      ? html`<div class="empty"><div class="empty-icon">${icons.shield}</div><p>The authorized scope is empty.</p><p class="muted small">No website can be opened until a domain is authorized here or in <code>PROXY_ALLOWED_DOMAINS</code>.</p></div>`
      : html`<div class="table-wrap">
        <table class="table">
          <thead><tr><th scope="col">Pattern</th><th scope="col">Source</th><th scope="col">Added</th><th scope="col" class="right">Actions</th></tr></thead>
          <tbody>
            ${scope.map(
              (d) => html`<tr>
              <td data-label="Pattern"><code class="domain">${d.pattern}</code></td>
              <td data-label="Source">${d.source === 'env' ? html`<span class="tag">environment</span>` : html`<span class="tag tag-admin">admin</span>`}</td>
              <td data-label="Added">${d.source === 'env' ? 'at start-up' : fmtDate(d.addedAt)}</td>
              <td data-label="Actions" class="right">${
                d.source === 'env'
                  ? html`<span class="muted small">locked</span>`
                  : html`<form method="post" action="/admin/domains/remove" class="inline-form" data-confirm="Remove ${d.pattern} from the authorized scope? Visitors will no longer be able to open it.">
                      <input type="hidden" name="_csrf" value="${csrfToken}">
                      <input type="hidden" name="domain" value="${d.pattern}">
                      <button type="submit" class="btn btn-danger btn-sm">Remove</button>
                    </form>`
              }</td>
            </tr>`
            )}
          </tbody>
        </table>
      </div>`
  }
  ${persistent ? '' : html`<p class="muted small"><span class="tag tag-warn">memory only</span> Entries added here are lost on restart; put permanent ones in <code>PROXY_ALLOWED_DOMAINS</code>.</p>`}
</section>

<section class="card">
  <h2>Configuration</h2>
  <p class="muted">Read-only view of the running configuration. Change values through the environment variables of your hosting service.</p>
  <dl class="kv">
    ${settings.map(
      (s) => html`<div><dt>${s.label}</dt><dd>${s.value}${s.env ? html` <code class="env">${s.env}</code>` : ''}${s.href ? html` <a class="small" href="${s.href}">diagnostics</a>` : ''}</dd></div>`
    )}
  </dl>
</section>

<dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <form method="dialog">
    <h2 id="confirm-title">Are you sure?</h2>
    <p id="confirm-text"></p>
    <div class="dialog-actions">
      <button type="button" class="btn btn-ghost" data-dialog-cancel>Cancel</button>
      <button type="button" class="btn btn-danger" data-dialog-confirm>Remove</button>
    </div>
  </form>
</dialog>`;
  return adminShell({ title: 'Settings', subtitle: 'Authorized scope and running configuration.', active: 'settings', csrfToken, body, notice, error });
}
