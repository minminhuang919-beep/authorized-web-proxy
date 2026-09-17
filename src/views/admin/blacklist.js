import { html, icons } from '../layout.js';
import { adminShell, fmtDate } from './shell.js';

/**
 * @param {object} opts
 * @param {Array} opts.entries   blacklist entries (already filtered by q)
 * @param {number} opts.total    total number of entries
 * @param {string} opts.q        current filter
 * @param {boolean} opts.persistent
 * @param {string} opts.exportValue value for PROXY_BLACKLIST
 * @param {string} opts.csrfToken
 * @param {{ domain?: string, reason?: string }} [opts.form] previous input on error
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function blacklistPage({ entries, total, q, persistent, exportValue, csrfToken, form = {}, notice = '', error = '' }) {
  const body = html`
<section class="card" aria-labelledby="add-title">
  <h2 id="add-title">Add a domain</h2>
  <p class="muted">Blocks the domain <strong>and all of its subdomains</strong> (<code>example.com</code> also blocks <code>www.example.com</code>, but not <code>notexample.com</code>). Blocking only restricts the authorized scope — it never authorizes anything.</p>
  <form method="post" action="/admin/blacklist" class="add-form" id="blacklist-add">
    <input type="hidden" name="_csrf" value="${csrfToken}">
    <label class="field grow">
      <span>Domain</span>
      <input name="domain" type="text" placeholder="example.com" required maxlength="260" autocomplete="off" spellcheck="false" value="${form.domain || ''}">
    </label>
    <label class="field grow">
      <span>Reason <span class="muted">(optional)</span></span>
      <input name="reason" type="text" placeholder="Why it is blocked" maxlength="120" autocomplete="off" value="${form.reason || ''}">
    </label>
    <button type="submit" class="btn btn-primary">Add to blacklist</button>
  </form>
</section>

<section class="card" aria-labelledby="list-title">
  <div class="card-head">
    <h2 id="list-title">Blacklisted domains <span class="count">${total}</span></h2>
    <form method="get" action="/admin/blacklist" class="search-inline" role="search">
      <span class="search-icon">${icons.search}</span>
      <label for="q" class="visually-hidden">Search the blacklist</label>
      <input id="q" name="q" type="search" placeholder="Search domain or reason…" value="${q}" data-filter="#blacklist-table" autocomplete="off">
    </form>
  </div>
  ${
    total === 0
      ? html`<div class="empty">
          <div class="empty-icon">${icons.block}</div>
          <p>Nothing is blacklisted.</p>
          <p class="muted small">Every website inside the authorized scope can currently be opened. Add a domain above to block it.</p>
        </div>`
      : html`<div class="table-wrap">
        <table class="table" id="blacklist-table">
          <thead><tr><th scope="col">Domain</th><th scope="col">Reason</th><th scope="col">Added</th><th scope="col" class="right">Actions</th></tr></thead>
          <tbody>
            ${
              entries.length === 0
                ? html`<tr class="no-match"><td colspan="4" class="muted">No entries match “${q}”.</td></tr>`
                : entries.map(
                    (e) => html`<tr data-search="${`${e.domain} ${e.reason}`.toLowerCase()}">
              <td data-label="Domain"><code class="domain">${e.domain}</code>${e.source === 'env' ? html` <span class="tag" title="Defined in PROXY_BLACKLIST">environment</span>` : ''}</td>
              <td data-label="Reason">${e.reason ? e.reason : html`<span class="muted">—</span>`}</td>
              <td data-label="Added"><time datetime="${e.addedAt || ''}">${e.source === 'env' ? 'at start-up' : fmtDate(e.addedAt)}</time></td>
              <td data-label="Actions" class="right">
                ${
                  e.source === 'env'
                    ? html`<span class="muted small">locked</span>`
                    : html`<form method="post" action="/admin/blacklist/${e.id}/delete" class="inline-form" data-confirm="Remove ${e.domain} from the blacklist? Visitors will be able to open it again." data-entry-id="${e.id}">
                      <input type="hidden" name="_csrf" value="${csrfToken}">
                      <button type="submit" class="btn btn-danger btn-sm">Delete</button>
                    </form>`
                }
              </td>
            </tr>`
                  )
            }
            <tr class="no-match hidden" data-no-match><td colspan="4" class="muted">No entries match your search.</td></tr>
          </tbody>
        </table>
      </div>`
  }
</section>

<section class="card">
  <h2>Persistence</h2>
  ${
    persistent
      ? html`<p class="muted">Entries added here are saved to the data directory and survive restarts.</p>`
      : html`<p><span class="tag tag-warn">memory only</span> This deployment has no persistent disk: entries added here are <strong>lost when the service restarts or redeploys</strong>. To keep them, copy the value below into the <code>PROXY_BLACKLIST</code> environment variable of your hosting service (Render → Environment).</p>`
  }
  <details class="export">
    <summary>Export as <code>PROXY_BLACKLIST</code> value</summary>
    <div class="export-body">
      <textarea readonly rows="3" data-copy-source aria-label="PROXY_BLACKLIST value">${exportValue}</textarea>
      <button type="button" class="btn btn-ghost btn-sm" data-copy>Copy</button>
    </div>
    <p class="muted tiny">Format: comma separated domains, optionally followed by <code>|reason</code>.</p>
  </details>
</section>

<dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <form method="dialog">
    <h2 id="confirm-title">Remove from blacklist?</h2>
    <p id="confirm-text"></p>
    <div class="dialog-actions">
      <button type="button" class="btn btn-ghost" value="cancel" data-dialog-cancel>Cancel</button>
      <button type="button" class="btn btn-danger" data-dialog-confirm>Delete</button>
    </div>
  </form>
</dialog>`;
  return adminShell({ title: 'Blacklist', subtitle: 'Websites inside the authorized scope that visitors may not open.', active: 'blacklist', csrfToken, body, notice, error });
}
