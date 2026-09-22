/**
 * Tiny HTML templating helpers + the page shell. Everything interpolated into
 * markup goes through `esc()` unless it is explicitly marked as trusted HTML
 * via `raw()` / the `html` tag.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

class Raw {
  constructor(html) {
    this.html = html;
  }
  toString() {
    return this.html;
  }
}

/** Mark a string as already-safe HTML. */
export function raw(html) {
  return new Raw(html);
}

/** Tagged template that escapes interpolations (arrays are joined). */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export function render(value) {
  if (value instanceof Raw) return value.html;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/** Inline SVG icons (no external assets, CSP friendly). */
export const icons = {
  mark: raw(
    '<svg class="mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle cx="32" cy="32" r="22" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="32" cy="32" r="8" fill="currentColor"/></svg>'
  ),
  search: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  ),
  arrow: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  ),
  arrowLeft: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  ),
  globe: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  ),
  bolt: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  ),
  sun: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  ),
  moon: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
  ),
  shield: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l8 3v6c0 4.6-3.2 8.2-8 9-4.8-.8-8-4.4-8-9V6l8-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  ),
  block: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  ),
  alert: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3l10 18H2L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5M12 18h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  ),
  check: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  ),
  clock: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  ),
  external: raw(
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 4h6v6M20 4l-8.5 8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  )
};

/**
 * Page shell.
 * @param {object} opts
 * @param {string} opts.title
 * @param {Raw|string} opts.body
 * @param {string} [opts.description]
 * @param {'site'|'admin'} [opts.nav]   which navigation to show
 * @param {string} [opts.active]        active nav item (`home`, `about`, `dashboard`, `sites`, `blacklist`, `search`, `settings`)
 * @param {boolean} [opts.adminLoggedIn] show the Admin link / logout
 * @param {string|null} [opts.csrfToken] renders the logout form when set
 * @param {string} [opts.bodyClass]
 */
export function layout({ title, body, description = 'Fast private browsing for authorized websites.', nav = 'site', active = '', adminLoggedIn = false, csrfToken = null, bodyClass = '' }) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page" class="is-active"' : ''}>${esc(label)}</a>`;
  const siteLinks = [link('/', 'Home', 'home'), link('/about', 'About', 'about'), adminLoggedIn ? link('/admin', 'Admin', 'admin') : ''].join('');
  const adminLinks = [
    link('/admin', 'Dashboard', 'dashboard'),
    link('/admin/sites', 'Sites', 'sites'),
    link('/admin/blacklist', 'Blacklist', 'blacklist'),
    link('/admin/search', 'Search', 'search'),
    link('/admin/settings', 'Settings', 'settings'),
    link('/', 'Site', 'site')
  ].join('');
  const logout = csrfToken
    ? `<form method="post" action="/admin/logout" class="inline-form"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="btn btn-ghost btn-sm">Log out</button></form>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · AnonView</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/_/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/_/style.css">
<script src="/_/theme.js"></script>
</head>
<body class="${esc(bodyClass)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="topbar">
  <a class="brand" href="/" aria-label="AnonView home">${icons.mark}<span>AnonView</span></a>
  <nav class="nav" aria-label="${nav === 'admin' ? 'Admin' : 'Main'}">
    ${nav === 'admin' ? adminLinks : siteLinks}
    ${logout}
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle dark mode" title="Toggle dark mode">${icons.sun}${icons.moon}</button>
  </nav>
</header>
<main id="main" class="main">
${render(body)}
</main>
<footer class="footer">
  <p>AnonView relays only websites inside its authorized scope. It is not an open proxy and does not bypass logins, CAPTCHAs or filters.</p>
</footer>
<script src="/_/app.js" defer></script>
${nav === 'admin' ? '<script src="/_/admin.js" defer></script>' : ''}
</body>
</html>`;
}
