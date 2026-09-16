/*
 * AnonView proxy client shim.
 *
 * Injected into proxied HTML pages. Server-side rewriting already fixed the
 * URLs present in the markup; this script keeps URLs that are created by the
 * page's own JavaScript (fetch/XHR calls, dynamically inserted elements,
 * history.pushState, …) inside the proxy. It never tries to bypass any site
 * protection — it only maps URLs onto the proxy's own origin.
 */
(function () {
  'use strict';
  var cfg = window.__PXY__;
  if (!cfg || window.__PXY_SHIM__) return;
  window.__PXY_SHIM__ = true;

  var PREFIX = cfg.prefix || '/p/';
  var proxyOrigin = window.location.origin;
  var allowed = cfg.allowed || [];
  var mode = cfg.mode || 'direct';
  var URL_ATTRS = ['href', 'src', 'poster', 'action', 'formaction', 'data', 'cite', 'background', 'longdesc', 'xlink:href'];
  var SRCSET_ATTRS = ['srcset', 'imagesrcset'];
  var SCHEME_RE = /^[a-z][a-z0-9+.\-]*:/i;
  var PROXY_PATH_RE = /^\/p\/(https?)\/([^/?#]+)([^#]*)$/;
  var CSS_URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^"')\s][^)\s]*))\s*\)/gi;

  function hostAllowed(host) {
    host = String(host || '').toLowerCase();
    for (var i = 0; i < allowed.length; i++) {
      var p = allowed[i];
      if (p.indexOf('*.') === 0) {
        var suffix = p.slice(1);
        if (host.length > suffix.length && host.slice(-suffix.length) === suffix) return true;
      } else if (p === host) {
        return true;
      }
    }
    return false;
  }

  /** The upstream URL of the current document, derived from the address bar. */
  function currentPageUrl() {
    var m = PROXY_PATH_RE.exec(window.location.pathname + window.location.search);
    if (m) return m[1] + '://' + m[2] + (m[3] || '/');
    return cfg.pageUrl;
  }

  function toProxy(u) {
    return PREFIX + u.protocol.replace(':', '') + '/' + u.hostname + u.pathname + u.search + u.hash;
  }

  function rewrite(value) {
    if (typeof value !== 'string') {
      if (value instanceof URL) value = value.href;
      else return value;
    }
    var s = value.trim();
    if (!s || s.charAt(0) === '#') return value;
    if (s.indexOf(PREFIX) === 0) return value; // already proxied
    if (SCHEME_RE.test(s) && !/^https?:/i.test(s)) return value; // data:, blob:, javascript:, mailto:, …
    var u;
    try {
      u = new URL(s, currentPageUrl());
    } catch (e) {
      return value;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return value;
    if (u.origin === proxyOrigin) return value; // points at the proxy itself
    if (u.port || u.username || u.password) return u.href;
    if (hostAllowed(u.hostname) || mode === 'proxy') return toProxy(u);
    return u.href;
  }

  function rewriteSrcset(value) {
    if (typeof value !== 'string' || !value.trim()) return value;
    return value
      .split(',')
      .map(function (part) {
        var t = part.trim();
        if (!t) return '';
        var pieces = t.split(/\s+/);
        pieces[0] = rewrite(pieces[0]);
        return pieces.join(' ');
      })
      .filter(Boolean)
      .join(', ');
  }

  function rewriteCssText(text) {
    if (typeof text !== 'string' || text.indexOf('url(') === -1) return text;
    return text.replace(CSS_URL_RE, function (match, dq, sq, bare) {
      var raw = dq !== undefined ? dq : sq !== undefined ? sq : bare;
      var next = rewrite(raw);
      if (next === raw) return match;
      return 'url("' + next.replace(/"/g, '\\"') + '")';
    });
  }

  function rewriteAttr(name, value, el) {
    var n = String(name).toLowerCase();
    if (SRCSET_ATTRS.indexOf(n) !== -1) return rewriteSrcset(value);
    if (n === 'style') return rewriteCssText(value);
    if (n === 'data' && !(el && el.tagName && el.tagName.toLowerCase() === 'object')) return value;
    if (URL_ATTRS.indexOf(n) !== -1) return rewrite(value);
    return value;
  }

  var origSetAttribute = Element.prototype.setAttribute;
  var origSetAttributeNS = Element.prototype.setAttributeNS;

  function isOwn(el) {
    // Elements injected by the proxy itself (banner) must keep their URLs.
    return el.hasAttribute('data-pxy-ignore') || (el.closest && el.closest('[data-pxy-ignore]'));
  }

  function fixElement(el) {
    if (!el || el.nodeType !== 1 || !el.getAttribute || isOwn(el)) return;
    var names = URL_ATTRS.concat(SRCSET_ATTRS, ['style']);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!el.hasAttribute(name)) continue;
      var value = el.getAttribute(name);
      var next = rewriteAttr(name, value, el);
      if (next !== value) origSetAttribute.call(el, name, next);
    }
  }

  function fixTree(root) {
    if (!root) return;
    if (root.nodeType === 1) fixElement(root);
    if (!root.querySelectorAll) return;
    var list = root.querySelectorAll('[href],[src],[srcset],[action],[poster],[formaction],[data],[style]');
    for (var i = 0; i < list.length; i++) fixElement(list[i]);
  }

  // --- Element attribute APIs -------------------------------------------
  Element.prototype.setAttribute = function (name, value) {
    return origSetAttribute.call(this, name, isOwn(this) ? value : rewriteAttr(name, value, this));
  };
  Element.prototype.setAttributeNS = function (ns, name, value) {
    return origSetAttributeNS.call(this, ns, name, isOwn(this) ? value : rewriteAttr(name, value, this));
  };

  function patchSetter(proto, prop, fn) {
    if (!proto) return;
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set || !desc.configurable) return;
    Object.defineProperty(proto, prop, {
      get: desc.get,
      set: function (v) {
        desc.set.call(this, this instanceof Element && isOwn(this) ? v : fn(v, this));
      },
      enumerable: desc.enumerable,
      configurable: true
    });
  }

  var w = window;
  var urlProps = [
    [w.HTMLAnchorElement, 'href'],
    [w.HTMLAreaElement, 'href'],
    [w.HTMLLinkElement, 'href'],
    [w.HTMLBaseElement, 'href'],
    [w.HTMLImageElement, 'src'],
    [w.HTMLScriptElement, 'src'],
    [w.HTMLIFrameElement, 'src'],
    [w.HTMLFrameElement, 'src'],
    [w.HTMLEmbedElement, 'src'],
    [w.HTMLSourceElement, 'src'],
    [w.HTMLTrackElement, 'src'],
    [w.HTMLMediaElement, 'src'],
    [w.HTMLInputElement, 'src'],
    [w.HTMLVideoElement, 'poster'],
    [w.HTMLFormElement, 'action'],
    [w.HTMLInputElement, 'formAction'],
    [w.HTMLButtonElement, 'formAction'],
    [w.HTMLObjectElement, 'data'],
    [w.HTMLQuoteElement, 'cite']
  ];
  for (var i = 0; i < urlProps.length; i++) {
    if (urlProps[i][0]) patchSetter(urlProps[i][0].prototype, urlProps[i][1], rewrite);
  }
  if (w.HTMLImageElement) patchSetter(w.HTMLImageElement.prototype, 'srcset', rewriteSrcset);
  if (w.HTMLSourceElement) patchSetter(w.HTMLSourceElement.prototype, 'srcset', rewriteSrcset);

  // innerHTML / outerHTML / insertAdjacentHTML / document.write
  function patchHtmlSetter(proto, prop) {
    var desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      get: desc.get,
      set: function (v) {
        var parent = prop === 'outerHTML' ? this.parentNode : this;
        desc.set.call(this, v);
        fixTree(parent);
      },
      enumerable: desc.enumerable,
      configurable: true
    });
  }
  patchHtmlSetter(Element.prototype, 'innerHTML');
  patchHtmlSetter(Element.prototype, 'outerHTML');
  if (w.ShadowRoot) patchHtmlSetter(w.ShadowRoot.prototype, 'innerHTML');
  var origInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (position, html) {
    var r = origInsertAdjacentHTML.call(this, position, html);
    var p = String(position).toLowerCase();
    fixTree(p === 'beforebegin' || p === 'afterend' ? this.parentNode : this);
    return r;
  };
  ['write', 'writeln'].forEach(function (m) {
    var orig = Document.prototype[m];
    if (!orig) return;
    Document.prototype[m] = function () {
      var r = orig.apply(this, arguments);
      fixTree(this.documentElement);
      return r;
    };
  });

  // Inline style objects
  if (w.CSSStyleDeclaration) {
    var sp = w.CSSStyleDeclaration.prototype;
    var origSetProperty = sp.setProperty;
    sp.setProperty = function (name, value, priority) {
      return origSetProperty.call(this, name, rewriteCssText(value), priority);
    };
    patchSetter(sp, 'cssText', rewriteCssText);
    ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyleImage', 'cursor', 'content', 'maskImage'].forEach(function (p) {
      patchSetter(sp, p, rewriteCssText);
    });
  }

  // --- Network APIs -------------------------------------------------------
  if (w.fetch) {
    var origFetch = w.fetch;
    w.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || input instanceof URL) {
          input = rewrite(String(input));
        } else if (w.Request && input instanceof w.Request) {
          var next = rewrite(input.url);
          if (next !== input.url) input = new w.Request(next, input);
        }
      } catch (e) {
        /* fall through with the original input */
      }
      return origFetch.call(this, input, init);
    };
  }
  if (w.XMLHttpRequest) {
    var origOpen = w.XMLHttpRequest.prototype.open;
    w.XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = rewrite(String(url));
      return origOpen.apply(this, args);
    };
  }
  if (w.navigator && w.navigator.sendBeacon) {
    var origBeacon = w.navigator.sendBeacon;
    w.navigator.sendBeacon = function (url, data) {
      return origBeacon.call(this, rewrite(String(url)), data);
    };
  }
  if (w.EventSource) {
    var OrigEventSource = w.EventSource;
    w.EventSource = function (url, init) {
      return new OrigEventSource(rewrite(String(url)), init);
    };
    w.EventSource.prototype = OrigEventSource.prototype;
  }
  ['Worker', 'SharedWorker'].forEach(function (name) {
    var Orig = w[name];
    if (!Orig) return;
    var Patched = function (url, opts) {
      return new Orig(rewrite(String(url)), opts);
    };
    Patched.prototype = Orig.prototype;
    w[name] = Patched;
  });
  if (w.navigator && w.navigator.serviceWorker && w.navigator.serviceWorker.register) {
    try {
      w.navigator.serviceWorker.register = function () {
        return Promise.reject(new Error('Service workers are disabled while viewing a site through the proxy.'));
      };
    } catch (e) {
      /* ignore */
    }
  }

  // --- Navigation APIs ----------------------------------------------------
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = w.history[m];
    w.history[m] = function (state, title, url) {
      if (url !== undefined && url !== null) url = rewrite(String(url));
      return orig.call(this, state, title, url);
    };
  });
  var origOpenWin = w.open;
  w.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url !== undefined && url !== null) args[0] = rewrite(String(url));
    return origOpenWin.apply(this, args);
  };

  // --- Catch-all: observe the DOM for anything the patches above missed ----
  if (w.MutationObserver) {
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === 'attributes') {
          fixElement(rec.target);
        } else if (rec.addedNodes) {
          for (var j = 0; j < rec.addedNodes.length; j++) fixTree(rec.addedNodes[j]);
        }
      }
    });
    var startObserving = function () {
      if (!document.documentElement) return;
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: URL_ATTRS.concat(SRCSET_ATTRS)
      });
    };
    if (document.documentElement) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving);
  }
})();
