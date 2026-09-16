/**
 * CSS rewriting: `url(...)` tokens and `@import "..."` strings are resolved
 * and routed through the proxy. Everything else is preserved byte-for-byte.
 */

// url( <optional quote> <anything but the closing quote/paren> <quote> )
const URL_FN_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')\s][^)\s]*))\s*\)/gi;
// @import "..." / @import '...' (the url() form is handled by URL_FN_RE)
const IMPORT_RE = /(@import\s+)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gi;

function unescapeCss(s) {
  return s.replace(/\\(.)/g, '$1');
}

function quote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @param {string} css
 * @param {URL} base URL the stylesheet was loaded from (upstream form)
 * @param {{ rewrite: (value: string, base: URL) => string }} urlRewriter
 */
export function rewriteCss(css, base, urlRewriter) {
  if (typeof css !== 'string' || css.length === 0) return css;
  let out = css.replace(URL_FN_RE, (match, dq, sq, bare) => {
    const raw = dq !== undefined ? unescapeCss(dq) : sq !== undefined ? unescapeCss(sq) : bare;
    const rewritten = urlRewriter.rewrite(raw, base);
    if (rewritten === raw) return match;
    return `url(${quote(rewritten)})`;
  });
  out = out.replace(IMPORT_RE, (match, prefix, dq, sq) => {
    const raw = unescapeCss(dq !== undefined ? dq : sq);
    const rewritten = urlRewriter.rewrite(raw, base);
    if (rewritten === raw) return match;
    return `${prefix}${quote(rewritten)}`;
  });
  return out;
}
