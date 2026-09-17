import { html, layout } from '../layout.js';

export function fmtBytes(n) {
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

export function fmtDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

/** `2026-09-16T10:20:30.000Z` → `2026-09-16 10:20 UTC` */
export function fmtDate(iso) {
  if (!iso) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Admin page shell: page header + flash messages inside the admin layout.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.active  dashboard | blacklist | settings
 * @param {string} opts.csrfToken
 * @param {import('../layout.js').raw extends (...a: any) => infer R ? R : never} opts.body
 * @param {string} [opts.subtitle]
 * @param {string} [opts.notice]
 * @param {string} [opts.error]
 */
export function adminShell({ title, active, csrfToken, body, subtitle = '', notice = '', error = '' }) {
  const content = html`
<div class="admin">
  <header class="page-header">
    <div>
      <p class="eyebrow">Administration</p>
      <h1>${title}</h1>
      ${subtitle ? html`<p class="muted">${subtitle}</p>` : ''}
    </div>
  </header>
  ${notice ? html`<div class="flash flash-ok" role="status">${notice}</div>` : ''}
  ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  ${body}
</div>`;
  return layout({ title, body: content, nav: 'admin', active, adminLoggedIn: true, csrfToken, bodyClass: 'page-admin' });
}
