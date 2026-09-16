/**
 * Streaming HTML rewriter built on parse5's RewritingStream.
 *
 * Input: a stream of *strings* (see `DecodeStream`). Output: UTF-8 strings.
 * Unmodified markup is passed through byte-for-byte; only tags whose
 * attributes need rewriting are re-serialised.
 */
import { RewritingStream } from 'parse5-html-rewriting-stream';
import { rewriteCss } from './css.js';

/** Attributes (any element) whose value is a single URL. */
const URL_ATTRS = new Set(['href', 'src', 'poster', 'action', 'formaction', 'cite', 'background', 'longdesc', 'xlink:href', 'codebase', 'usemap']);
/** Attributes whose value is a srcset list. */
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
/** Attributes removed outright. */
const DROP_ATTRS = new Set(['ping', 'integrity', 'crossorigin', 'manifest']);
/** <link rel=…> types that only make sense against the original origin. */
const DROPPED_LINK_RELS = new Set(['preconnect', 'dns-prefetch']);

const META_REFRESH_RE = /^(\s*[\d.]+\s*[;,]?\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2\s*$/i;
const FRAGMENT_ATTR_RE = /\b(href|src|srcset|action|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Serialise a config object for an inline <script> without allowing a
 * `</script>` (or a line terminator) to break out of the block.
 */
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);
export function safeJsonForScript(value) {
  return JSON.stringify(value)
    .split('<').join(String.raw`\u003c`)
    .split(LINE_SEP).join(String.raw`\u2028`)
    .split(PARA_SEP).join(String.raw`\u2029`);
}

/**
 * @param {object} opts
 * @param {URL} opts.pageUrl        upstream URL of the document
 * @param {ReturnType<import('./url.js').createUrlRewriter>} opts.urlRewriter
 * @param {string} [opts.headSnippet] HTML injected at the start of <head>
 * @param {string} [opts.bodySnippet] HTML injected at the start of <body>
 * @returns {RewritingStream}
 */
export function createHtmlRewriter({ pageUrl, urlRewriter, headSnippet = '', bodySnippet = '' }) {
  const rw = new RewritingStream();
  let base = pageUrl;
  let headInjected = false;
  let bodyInjected = false;
  /** raw text collected inside <style> / <noscript>, or null when not inside one */
  let rawBuffer = null;
  let rawBufferTag = null;

  const injectHead = () => {
    if (headInjected) return;
    headInjected = true;
    if (headSnippet) rw.emitRaw(headSnippet);
  };
  const injectBody = () => {
    if (bodyInjected) return;
    bodyInjected = true;
    if (bodySnippet) rw.emitRaw(bodySnippet);
  };

  const rewriteAttrValue = (name, value, tagName) => {
    if (SRCSET_ATTRS.has(name)) return urlRewriter.rewriteSrcset(value, base);
    if (name === 'style') return rewriteCss(value, base, urlRewriter);
    if (name === 'data' && tagName === 'object') return urlRewriter.rewrite(value, base);
    if (URL_ATTRS.has(name)) return urlRewriter.rewrite(value, base);
    return value;
  };

  rw.on('startTag', (tag, raw) => {
    const tn = tag.tagName;
    let modified = false;
    const attrs = tag.attrs;
    const get = (n) => attrs.find((a) => a.name.toLowerCase() === n)?.value;

    if (tn === 'meta') {
      const httpEquiv = (get('http-equiv') || '').toLowerCase();
      if (httpEquiv === 'content-security-policy' || httpEquiv === 'content-security-policy-report-only') {
        return; // drop: it would block the proxy's own script / proxied origins
      }
      for (const attr of attrs) {
        const n = attr.name.toLowerCase();
        if (n === 'charset') {
          attr.value = 'utf-8';
          modified = true;
        } else if (n === 'content' && httpEquiv === 'content-type') {
          attr.value = 'text/html; charset=utf-8';
          modified = true;
        } else if (n === 'content' && httpEquiv === 'refresh') {
          const m = META_REFRESH_RE.exec(attr.value);
          if (m && m[3]) {
            attr.value = `${m[1]}${urlRewriter.rewrite(m[3], base)}`;
            modified = true;
          }
        }
      }
    } else if (tn === 'link') {
      const rel = (get('rel') || '').toLowerCase().split(/\s+/);
      if (rel.some((r) => DROPPED_LINK_RELS.has(r))) return;
    }

    // <base href> changes how *subsequent* URLs resolve; its own href must be
    // resolved against the previous base.
    let nextBase = base;
    if (tn === 'base') {
      const href = get('href');
      if (href) {
        try {
          nextBase = new URL(href.trim(), base);
        } catch {
          /* keep previous base */
        }
      }
    }

    const kept = [];
    for (const attr of attrs) {
      // parse5 splits namespaced attributes in foreign content (xlink:href)
      // into prefix + name; re-join them so serialisation keeps the prefix.
      if (attr.prefix) {
        attr.name = `${attr.prefix}:${attr.name}`;
        attr.prefix = undefined;
        modified = true;
      }
      const n = attr.name.toLowerCase();
      if (DROP_ATTRS.has(n) && (n !== 'manifest' || tn === 'html')) {
        modified = true;
        continue;
      }
      const next = rewriteAttrValue(n, attr.value, tn);
      if (next !== attr.value) {
        attr.value = next;
        modified = true;
      }
      kept.push(attr);
    }
    tag.attrs = kept;
    base = nextBase;

    if (modified) rw.emitStartTag(tag);
    else rw.emitRaw(raw);

    if (tn === 'head') {
      injectHead();
    } else if (tn === 'body') {
      injectHead();
      injectBody();
    } else if (tn === 'style' || tn === 'noscript') {
      rawBuffer = '';
      rawBufferTag = tn;
    }
  });

  rw.on('endTag', (tag, raw) => {
    if (rawBuffer !== null && tag.tagName === rawBufferTag) {
      const text = rawBuffer;
      rawBuffer = null;
      rawBufferTag = null;
      rw.emitRaw(tag.tagName === 'style' ? rewriteCss(text, base, urlRewriter) : rewriteFragment(text, base, urlRewriter));
    } else if (tag.tagName === 'head') {
      injectHead();
    } else if (tag.tagName === 'body' || tag.tagName === 'html') {
      injectHead();
      injectBody();
    }
    rw.emitRaw(raw);
  });

  rw.on('text', (_token, raw) => {
    if (rawBuffer !== null) rawBuffer += raw;
    else rw.emitRaw(raw);
  });

  rw._flush = (cb) => {
    if (rawBuffer !== null) {
      rw.emitRaw(rawBuffer);
      rawBuffer = null;
    }
    injectHead();
    injectBody();
    cb();
  };

  return rw;
}

/**
 * Best-effort attribute rewriting for raw-text contexts such as <noscript>
 * where the tokenizer does not parse tags.
 */
export function rewriteFragment(html, base, urlRewriter) {
  return html.replace(FRAGMENT_ATTR_RE, (match, name, dq, sq) => {
    const value = dq !== undefined ? dq : sq;
    const lower = name.toLowerCase();
    const next = lower === 'srcset' ? urlRewriter.rewriteSrcset(value, base) : urlRewriter.rewrite(value, base);
    if (next === value) return match;
    return `${name}="${next.replace(/"/g, '&quot;')}"`;
  });
}
