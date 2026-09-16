/**
 * URL rewriting rules shared by the HTML and CSS rewriters.
 *
 *  - relative and root-relative URLs → resolved against the page URL and
 *    turned into `/p/<scheme>/<host>/…` (the page host is always allowed,
 *    otherwise the page would not be proxied in the first place);
 *  - absolute URLs to allowlisted hosts → `/p/<scheme>/<host>/…`;
 *  - absolute URLs to other hosts → left absolute (`direct` mode, default)
 *    or routed through the proxy (`proxy` mode, where they will be blocked
 *    with a clear message);
 *  - non-http(s) URLs (`javascript:`, `data:`, `mailto:`, `#fragment`, …) are
 *    never touched.
 */
import { isSpecialUseHostname, normalizeHostname } from '../security/hostname.js';
import { toProxyPath } from '../security/target.js';

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {object} opts
 * @param {import('../allowlist.js').Allowlist} opts.allowlist
 * @param {'direct'|'proxy'} [opts.mode]
 */
export function createUrlRewriter({ allowlist, mode = 'direct' }) {
  /**
   * @param {string} value attribute value as found in the document
   * @param {URL} base document base URL (upstream form)
   * @returns {string}
   */
  function rewrite(value, base) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return value;
    const schemeMatch = SCHEME_RE.exec(trimmed);
    if (schemeMatch) {
      const scheme = schemeMatch[0].slice(0, -1).toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') return value;
    }
    let url;
    try {
      url = new URL(trimmed, base);
    } catch {
      return value;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    if (url.username || url.password || url.port !== '') return url.href;
    const host = normalizeHostname(url.hostname);
    if (!host) return url.href;
    const allowed = !isSpecialUseHostname(host) && allowlist.isAllowed(host);
    if (allowed || mode === 'proxy') return toProxyPath(url);
    return url.href;
  }

  /**
   * Rewrite an HTML `srcset` attribute (comma separated candidates, each a URL
   * optionally followed by a width/density descriptor).
   */
  function rewriteSrcset(value, base) {
    if (typeof value !== 'string' || !value.trim()) return value;
    const out = [];
    let i = 0;
    const s = value;
    while (i < s.length) {
      // skip whitespace and commas
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let trailingCommas = 0;
      while (url.endsWith(',')) {
        url = url.slice(0, -1);
        trailingCommas++;
      }
      let descriptor = '';
      if (trailingCommas === 0) {
        // descriptors run until the next comma
        start = i;
        while (i < s.length && s[i] !== ',') i++;
        descriptor = s.slice(start, i).trim();
        if (s[i] === ',') i++;
      }
      if (url) out.push(descriptor ? `${rewrite(url, base)} ${descriptor}` : rewrite(url, base));
    }
    return out.join(', ');
  }

  return { rewrite, rewriteSrcset, mode };
}
