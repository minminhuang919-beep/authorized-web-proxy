/**
 * Tiny HTML templating helpers. Everything interpolated into markup goes
 * through `esc()` unless it is explicitly marked as trusted HTML via `raw()`.
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

function render(value) {
  if (value instanceof Raw) return value.html;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return esc(value);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Raw|string} opts.body
 * @param {string} [opts.description]
 * @param {boolean} [opts.admin] show admin navigation
 * @param {string|null} [opts.csrfToken] when set, an admin is logged in and a logout form is rendered
 */
export function layout({ title, body, description = 'A privacy-friendly viewer for authorized websites.', admin = false, csrfToken = null }) {
  const adminNav = csrfToken
    ? `<a href="/admin">Dashboard</a><form method="post" action="/admin/logout" class="inline-form"><input type="hidden" name="_csrf" value="${esc(csrfToken)}"><button type="submit" class="link-button">Log out</button></form>`
    : '<a href="/admin">Admin</a>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · AnonView</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site-header">
  <a class="brand" href="/" aria-label="AnonView home">
    <span class="brand-mark" aria-hidden="true">◎</span>
    <span class="brand-name">AnonView</span>
  </a>
  <nav class="site-nav">
    ${admin || csrfToken ? adminNav : '<a href="/admin">Admin</a>'}
  </nav>
</header>
<main class="site-main">
${render(body)}
</main>
<footer class="site-footer">
  <p>AnonView relays only explicitly authorized websites. It is not an open proxy and does not bypass logins, CAPTCHAs or filters.</p>
</footer>
<script src="/static/app.js" defer></script>
</body>
</html>`;
}
