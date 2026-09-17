import { html, icons, raw } from '../layout.js';
import { adminShell, fmtDate } from './shell.js';

const STATUS_TAGS = {
  blacklisted: { cls: 'tag-danger', label: 'Blacklisted', title: 'The destination is on the blacklist — the shortcut is refused until it is removed' },
  unauthorized: { cls: 'tag-warn', label: 'Not authorized', title: 'The destination is outside the authorized scope — the shortcut is refused until it is authorized' }
};

/**
 * Add / edit form for a shortcut.
 * @param {object} opts
 * @param {string} opts.action
 * @param {string} opts.csrfToken
 * @param {{ name?: string, shortcut?: string, destination?: string, description?: string, enabled?: boolean }} [opts.form]
 * @param {string} opts.submitLabel
 * @param {string|null} [opts.cancelHref]
 */
function siteForm({ action, csrfToken, form = {}, submitLabel, cancelHref = null }) {
  const enabled = form.enabled === undefined ? true : Boolean(form.enabled);
  return html`
<form method="post" action="${action}" class="site-form" id="site-form">
  <input type="hidden" name="_csrf" value="${csrfToken}">
  <div class="form-grid">
    <label class="field">
      <span>Name</span>
      <input name="name" type="text" placeholder="Google" required maxlength="60" autocomplete="off" value="${form.name || ''}">
    </label>
    <label class="field">
      <span>Shortcut</span>
      <input name="shortcut" type="text" placeholder="google" required maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false" value="${form.shortcut || ''}">
      <small class="muted">Letters, digits, <code>-</code> or <code>_</code>; matched case-insensitively.</small>
    </label>
    <label class="field span-2">
      <span>Destination</span>
      <input name="destination" type="text" inputmode="url" placeholder="https://google.com" required maxlength="2048" autocomplete="off" spellcheck="false" value="${form.destination || ''}">
      <small class="muted">Validated like a typed address: http(s) only, a domain name inside the authorized scope, not blacklisted.</small>
    </label>
    <label class="field span-2">
      <span>Description <span class="muted">(optional)</span></span>
      <input name="description" type="text" placeholder="Google Search" maxlength="120" autocomplete="off" value="${form.description || ''}">
    </label>
  </div>
  <div class="form-actions">
    <label class="check"><input type="checkbox" name="enabled" value="on"${enabled ? raw(' checked') : ''}> <span>Enabled</span></label>
    <span class="spacer"></span>
    ${cancelHref ? html`<a class="btn btn-ghost" href="${cancelHref}">Cancel</a>` : ''}
    <button type="submit" class="btn btn-primary">${submitLabel}</button>
  </div>
</form>`;
}

function destinationLabel(e) {
  const url = new URL(e.destination);
  const tail = `${url.pathname}${url.search}`;
  return tail === '/' ? e.host : `${e.host}${tail}`;
}

/**
 * @param {object} opts
 * @param {Array} opts.entries   directory entries (already filtered by q, with `status`)
 * @param {number} opts.total
 * @param {number} opts.enabled  number of enabled entries
 * @param {string} opts.q
 * @param {boolean} opts.persistent
 * @param {string} opts.exportValue value for PROXY_SITES
 * @param {string} opts.csrfToken
 * @param {object} [opts.form] previous input on error
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function sitesPage({ entries, total, enabled, q, persistent, exportValue, csrfToken, form = {}, notice = '', error = '' }) {
  const body = html`
<section class="card" aria-labelledby="add-title">
  <h2 id="add-title">Add a site</h2>
  <p class="muted">Visitors can type the shortcut instead of the address — <code>google</code> opens the configured destination through the proxy. A shortcut never widens access: its destination must already be inside the authorized scope and is checked again on every use (scope, blacklist, then the network checks).</p>
  ${siteForm({ action: '/admin/sites', csrfToken, form, submitLabel: 'Add shortcut' })}
</section>

<section class="card" aria-labelledby="dir-title">
  <div class="card-head">
    <h2 id="dir-title">Site directory <span class="count">${total}</span>${enabled < total ? html` <span class="muted small">${enabled} enabled</span>` : ''}</h2>
    <form method="get" action="/admin/sites" class="search-inline" role="search">
      <span class="search-icon">${icons.search}</span>
      <label for="q" class="visually-hidden">Search the directory</label>
      <input id="q" name="q" type="search" placeholder="Search name, shortcut or domain…" value="${q}" data-filter="#sites-table" autocomplete="off">
    </form>
  </div>
  ${
    total === 0
      ? html`<div class="empty">
          <div class="empty-icon">${icons.bolt}</div>
          <p>No shortcuts yet.</p>
          <p class="muted small">Add one above, or define permanent ones in <code>PROXY_SITES</code>. Visitors can still type full addresses.</p>
        </div>`
      : html`<div class="table-wrap">
        <table class="table" id="sites-table">
          <thead><tr><th scope="col">Site</th><th scope="col">Shortcut</th><th scope="col">Destination</th><th scope="col">Status</th><th scope="col">Added</th><th scope="col" class="right">Actions</th></tr></thead>
          <tbody>
            ${
              entries.length === 0
                ? html`<tr class="no-match"><td colspan="6" class="muted">No entries match “${q}”.</td></tr>`
                : entries.map((e) => siteRow(e, csrfToken))
            }
            <tr class="no-match hidden" data-no-match><td colspan="6" class="muted">No entries match your search.</td></tr>
          </tbody>
        </table>
      </div>`
  }
</section>

<section class="card">
  <h2>Persistence</h2>
  ${
    persistent
      ? html`<p class="muted">Shortcuts added here are saved to the data directory and survive restarts.</p>`
      : html`<p><span class="tag tag-warn">memory only</span> This deployment has no persistent disk: shortcuts added here are <strong>lost when the service restarts or redeploys</strong>. To keep them, copy the value below into the <code>PROXY_SITES</code> environment variable of your hosting service (Render → Environment).</p>`
  }
  <details class="export">
    <summary>Export as <code>PROXY_SITES</code> value</summary>
    <div class="export-body">
      <textarea readonly rows="3" data-copy-source aria-label="PROXY_SITES value">${exportValue}</textarea>
      <button type="button" class="btn btn-ghost btn-sm" data-copy>Copy</button>
    </div>
    <p class="muted tiny">Format: comma separated <code>shortcut=destination|Name|Description</code>; a leading <code>!</code> marks a disabled shortcut.</p>
  </details>
</section>

<dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <form method="dialog">
    <h2 id="confirm-title">Delete shortcut?</h2>
    <p id="confirm-text"></p>
    <div class="dialog-actions">
      <button type="button" class="btn btn-ghost" value="cancel" data-dialog-cancel>Cancel</button>
      <button type="button" class="btn btn-danger" data-dialog-confirm>Delete</button>
    </div>
  </form>
</dialog>`;
  return adminShell({ title: 'Sites', subtitle: 'Shortcuts visitors can type instead of a full address.', active: 'sites', csrfToken, body, notice, error });
}

function siteRow(e, csrfToken) {
  const status = STATUS_TAGS[e.status];
  const usable = e.enabled && e.status === 'ok';
  return html`<tr data-search="${`${e.name} ${e.shortcut} ${e.host} ${e.description}`.toLowerCase()}" class="${e.enabled ? '' : 'is-disabled'}">
  <td data-label="Site"><div class="cell-stack"><strong>${e.name}</strong>${e.description ? html`<span class="muted small">${e.description}</span>` : ''}</div></td>
  <td data-label="Shortcut"><code class="domain">${e.shortcut}</code>${e.source === 'env' ? html` <span class="tag" title="Defined in PROXY_SITES">environment</span>` : ''}</td>
  <td data-label="Destination">${
    usable
      ? html`<a class="dest" href="/search?q=${e.shortcut}" title="${e.destination}" target="_blank" rel="noopener">${destinationLabel(e)}</a>`
      : html`<span class="dest muted" title="${e.destination}">${destinationLabel(e)}</span>`
  }</td>
  <td data-label="Status"><span class="status-tags"><span class="tag ${e.enabled ? 'tag-ok' : ''}">${e.enabled ? 'Enabled' : 'Disabled'}</span>${status ? html` <span class="tag ${status.cls}" title="${status.title}">${status.label}</span>` : ''}</span></td>
  <td data-label="Added"><time datetime="${e.addedAt || ''}">${e.source === 'env' ? 'at start-up' : fmtDate(e.addedAt)}</time></td>
  <td data-label="Actions" class="right">${
    e.source === 'env'
      ? html`<span class="muted small">locked</span>`
      : html`<div class="row-actions">
          <form method="post" action="/admin/sites/${e.id}/toggle" class="inline-form">
            <input type="hidden" name="_csrf" value="${csrfToken}">
            <input type="hidden" name="enabled" value="${e.enabled ? '0' : '1'}">
            <button type="submit" class="btn btn-ghost btn-sm">${e.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          <a class="btn btn-ghost btn-sm" href="/admin/sites/${e.id}/edit">Edit</a>
          <form method="post" action="/admin/sites/${e.id}/delete" class="inline-form" data-confirm="Delete the shortcut “${e.shortcut}” (${e.name})? Visitors will no longer be able to use it." data-api-url="/admin/sites/${e.id}">
            <input type="hidden" name="_csrf" value="${csrfToken}">
            <button type="submit" class="btn btn-danger btn-sm">Delete</button>
          </form>
        </div>`
  }</td>
</tr>`;
}

/**
 * Edit page for one admin-created shortcut.
 * @param {object} opts
 * @param {object} opts.entry
 * @param {string} opts.csrfToken
 * @param {object} [opts.form] previous (invalid) input
 * @param {string} [opts.error]
 */
export function siteEditPage({ entry, csrfToken, form = null, error = '' }) {
  const status = STATUS_TAGS[entry.status];
  const body = html`
<section class="card" aria-labelledby="edit-title">
  <div class="card-head">
    <h2 id="edit-title">Edit “${entry.name}”</h2>
    <span class="status-tags"><span class="tag ${entry.enabled ? 'tag-ok' : ''}">${entry.enabled ? 'Enabled' : 'Disabled'}</span>${status ? html` <span class="tag ${status.cls}" title="${status.title}">${status.label}</span>` : ''}</span>
  </div>
  ${status ? html`<div class="flash flash-error" role="alert">${status.title}.</div>` : ''}
  ${siteForm({
    action: `/admin/sites/${entry.id}`,
    csrfToken,
    form: form || { name: entry.name, shortcut: entry.shortcut, destination: entry.destination, description: entry.description, enabled: entry.enabled },
    submitLabel: 'Save changes',
    cancelHref: '/admin/sites'
  })}
  <p class="muted tiny">Added ${fmtDate(entry.addedAt)}${entry.updatedAt && entry.updatedAt !== entry.addedAt ? ` · updated ${fmtDate(entry.updatedAt)}` : ''}</p>
</section>`;
  return adminShell({ title: 'Edit shortcut', subtitle: 'Changes take effect immediately.', active: 'sites', csrfToken, body, error });
}
