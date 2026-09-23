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
      if (p === '*') return true;
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
    if (n === 'src' && el && el.tagName && el.tagName.toUpperCase() === 'SCRIPT') return rewriteScriptSrc(value, el);
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
  // Scripts get their own handler: a third-party sign-in SDK must not be
  // loaded at all (see "Third-party sign-in SDKs" below).
  if (w.HTMLScriptElement) patchSetter(w.HTMLScriptElement.prototype, 'src', rewriteScriptSrc);
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

  // --- Third-party sign-in SDKs -------------------------------------------
  //
  // A "Sign in with Google/Apple/..." SDK is bound to the application's own
  // origin: Google Identity Services checks `window.location.origin` against
  // the Authorized JavaScript origins registered for that site's OAuth client.
  // A proxied page is served from this proxy's origin, so the SDK refuses to
  // work. We never fake that origin, and we never touch anyone else's OAuth
  // configuration.
  //
  // What used to happen: the SDK's URL was rewritten into the proxy, the proxy
  // answered the <script> with its HTML "Sign-in required" page, the script
  // failed to parse, its `onload` never fired, and the site therefore never
  // called `renderButton()`. The sign-in control stayed an empty <div> and
  // clicking it did nothing at all.
  //
  // What happens now: the SDK is never fetched. A minimal stand-in is
  // installed so the page's own bookkeeping still runs, and the control it
  // renders explains the situation and offers to open the real site in the
  // visitor's own browser. No credential is ever produced, and the site's
  // callback is never invoked, so the page can never believe someone signed in.

  var EMPTY_SCRIPT = 'data:text/javascript,';
  var blockedSdks = {};

  function matchAuthSdk(u) {
    var host = u.hostname.toLowerCase();
    var path = u.pathname;
    if (host === 'accounts.google.com' && path.indexOf('/gsi/') === 0) return 'Google';
    if (host === 'apis.google.com' && (path.indexOf('/js/platform') === 0 || path.indexOf('/js/api') === 0)) return 'Google';
    if (host === 'appleid.cdn-apple.com' && path.indexOf('/appleauth/static/jsapi') === 0) return 'Apple';
    if (host === 'connect.facebook.net' && /\/sdk\.js$/.test(path)) return 'Facebook';
    return '';
  }

  /** `/p/https/host/path` back to the upstream URL it stands for. */
  function fromProxyPath(s) {
    var m = PROXY_PATH_RE.exec(s);
    return m ? m[1] + '://' + m[2] + (m[3] || '/') : '';
  }

  function rewriteScriptSrc(value, el) {
    if (el && isOwn(el)) return value;
    var provider = '';
    try {
      var s = String(value == null ? '' : value).trim();
      // Only an http(s) URL can be an SDK. Relative and protocol-relative
      // forms resolve against the page; data:, blob: and javascript: cannot.
      var absolute = s.indexOf(PREFIX) === 0 ? fromProxyPath(s) : SCHEME_RE.test(s) && !/^https?:/i.test(s) ? '' : s;
      if (absolute) provider = matchAuthSdk(new URL(absolute, currentPageUrl()));
    } catch (e) {
      provider = '';
    }
    if (!provider) return rewrite(value);
    sdkBlocked(provider);
    // An empty script: it loads instantly, so the page's `onload` handler runs
    // exactly as it would have, and nothing is requested from the provider.
    return EMPTY_SCRIPT;
  }

  /** Record that a provider's SDK was withheld, and install its stand-in. */
  function sdkBlocked(provider) {
    var name = String(provider || 'this').replace(/[^A-Za-z]/g, '') || 'this';
    blockedSdks[name] = true;
    if (name === 'Google') installGoogleIdentity();
    return name;
  }

  /**
   * The smallest usable stand-in for Google Identity Services. It stores no
   * client id, produces no credential and never calls the site's callback --
   * `renderButton` simply draws a control that hands off to the real site.
   */
  function installGoogleIdentity() {
    var g = (w.google = w.google || {});
    g.accounts = g.accounts || {};
    if (g.accounts.id && g.accounts.id.__pxy) return;
    var notDisplayed = {
      isDisplayMoment: function () {
        return false;
      },
      isDisplayed: function () {
        return false;
      },
      isNotDisplayed: function () {
        return true;
      },
      // The same reason a real browser reports when One Tap cannot run:
      // the origin is not one the client is configured for.
      getNotDisplayedReason: function () {
        return 'opt_out_or_no_session';
      },
      isSkippedMoment: function () {
        return false;
      },
      isDismissedMoment: function () {
        return false;
      }
    };
    g.accounts.id = {
      __pxy: true,
      initialize: function () {},
      renderButton: function (parent, options) {
        renderHandoffButton(parent, 'Google', options);
      },
      prompt: function (listener) {
        if (typeof listener === 'function') {
          try {
            listener(notDisplayed);
          } catch (e) {
            /* the site's own handler threw: not our problem to fix */
          }
        }
      },
      disableAutoSelect: function () {},
      cancel: function () {},
      storeCredential: function (_c, done) {
        if (typeof done === 'function') done();
      },
      revoke: function (_h, done) {
        if (typeof done === 'function') done({ successful: false, error: 'proxied origin' });
      }
    };
    // The authorization-code / access-token clients hand off the same way.
    g.accounts.oauth2 = g.accounts.oauth2 || {
      initTokenClient: function () {
        return {
          requestAccessToken: function () {
            openHandoff('Google');
          }
        };
      },
      initCodeClient: function () {
        return {
          requestCode: function () {
            openHandoff('Google');
          }
        };
      },
      hasGrantedAllScopes: function () {
        return false;
      },
      hasGrantedAnyScope: function () {
        return false;
      },
      revoke: function (_t, done) {
        if (typeof done === 'function') done();
      }
    };
  }

  /** The site's own container, filled with a control that actually does something. */
  function renderHandoffButton(parent, provider, options) {
    if (!parent || parent.nodeType !== 1) return;
    var existing = parent.querySelector('[data-pxy-auth-button]');
    if (existing) return;
    var width = options && options.width ? String(options.width).replace(/[^0-9]/g, '') : '';
    var btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-pxy-ignore', '1');
    btn.setAttribute('data-pxy-auth-button', provider);
    btn.textContent = 'Continue with ' + provider;
    btn.style.cssText =
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;' +
      'width:' + (width ? width + 'px' : '100%') + ';min-width:180px;height:100%;min-height:40px;padding:0 16px;' +
      'font:500 14px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f1f1f;background:#fff;' +
      'border:1px solid #747775;border-radius:20px;cursor:pointer;';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openHandoff(provider);
    });
    parent.appendChild(btn);
  }

  /** The current page on its real origin: origin and path only, never the query. */
  function directSiteUrl() {
    try {
      var u = new URL(currentPageUrl());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.origin + (u.pathname && u.pathname !== '/' ? u.pathname : '/');
    } catch (e) {
      return '';
    }
  }

  var panelEl = null;
  var opening = false;

  function closePanel() {
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
    opening = false;
  }

  function el(tag, css, text) {
    var node = document.createElement(tag);
    node.setAttribute('data-pxy-ignore', '1');
    if (css) node.style.cssText = css;
    if (text) node.textContent = text;
    return node;
  }

  /**
   * Explain, then hand off. One window per click: `opening` blocks a second
   * attempt while one is in flight, so a blocked popup can never turn into a
   * loop of popup attempts.
   */
  function openHandoff(provider) {
    var site = directSiteUrl();
    var host = '';
    try {
      host = new URL(site).hostname;
    } catch (e) {
      host = 'the original website';
    }
    closePanel();
    panelEl = el(
      'div',
      'all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(4,8,12,.72);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;'
    );
    var card = el(
      'div',
      'all:initial;box-sizing:border-box;max-width:440px;width:calc(100% - 32px);padding:24px;border-radius:14px;' +
        'background:#121820;color:#e6edf3;box-shadow:0 18px 48px rgba(0,0,0,.55);font:inherit;text-align:left;'
    );
    var title = el('h2', 'all:initial;display:block;font:600 18px/1.3 inherit;color:#fff;margin:0 0 10px;', 'Sign-in required');
    var body = el(
      'p',
      'all:initial;display:block;font:inherit;color:#9fb0c0;margin:0 0 18px;',
      provider +
        ' sign-in has to run on ' +
        host +
        ' itself. ' +
        provider +
        ' checks the website address it was opened from, and this page is being served through the proxy, so it will not accept a sign-in started here.'
    );
    var actions = el('div', 'all:initial;display:flex;flex-wrap:wrap;gap:10px;font:inherit;');
    var note = el('p', 'all:initial;display:block;font:400 12px/1.5 inherit;color:#7d8d9c;margin:16px 0 0;', 'You will stay signed out on this proxied page.');

    var go = el(
      'button',
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
        'border-radius:10px;background:#4cc2ff;color:#04121c;font:600 14px/1 inherit;cursor:pointer;'
    );
    go.setAttribute('type', 'button');
    go.textContent = site ? 'Continue on ' + host : 'Continue on the original website';

    var cancel = el(
      'button',
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
        'border-radius:10px;border:1px solid #2b3a48;color:#9fb0c0;font:500 14px/1 inherit;cursor:pointer;'
    );
    cancel.setAttribute('type', 'button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closePanel);

    go.addEventListener('click', function () {
      if (opening || !site) return;
      opening = true;
      var win = null;
      try {
        win = origOpenWin.call(w, site, '_blank', 'noopener,noreferrer');
      } catch (e) {
        win = null;
      }
      if (win) {
        closePanel();
        return;
      }
      // The browser refused the window. Do not try again on our own: offer a
      // link the visitor clicks themselves, which a popup blocker allows.
      showBlocked(card, site, host);
    });

    actions.appendChild(go);
    actions.appendChild(cancel);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    card.appendChild(note);
    panelEl.appendChild(card);
    panelEl.addEventListener('click', function (ev) {
      if (ev.target === panelEl) closePanel();
    });
    (document.body || document.documentElement).appendChild(panelEl);
    try {
      go.focus();
    } catch (e) {
      /* focus is a nicety */
    }
  }

  /** Popup blocked: say so, and give the visitor a link to click themselves. */
  function showBlocked(card, site, host) {
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(el('h2', 'all:initial;display:block;font:600 18px/1.3 inherit;color:#fff;margin:0 0 10px;', 'Sign-in window was blocked'));
    card.appendChild(
      el(
        'p',
        'all:initial;display:block;font:inherit;color:#9fb0c0;margin:0 0 18px;',
        'Your browser stopped the sign-in window from opening. Use the link below to open ' + host + ' yourself.'
      )
    );
    var row = el('div', 'all:initial;display:flex;flex-wrap:wrap;gap:10px;font:inherit;');
    var link = document.createElement('a');
    link.setAttribute('data-pxy-ignore', '1');
    link.setAttribute('href', site);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer nofollow');
    link.setAttribute('referrerpolicy', 'no-referrer');
    link.textContent = 'Open ' + host;
    link.style.cssText =
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
      'border-radius:10px;background:#4cc2ff;color:#04121c;font:600 14px/1 inherit;cursor:pointer;';
    link.addEventListener('click', function () {
      setTimeout(closePanel, 0);
    });
    var dismiss = el(
      'button',
      'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
        'border-radius:10px;border:1px solid #2b3a48;color:#9fb0c0;font:500 14px/1 inherit;cursor:pointer;'
    );
    dismiss.setAttribute('type', 'button');
    dismiss.textContent = 'Close';
    dismiss.addEventListener('click', closePanel);
    row.appendChild(link);
    row.appendChild(dismiss);
    card.appendChild(row);
    // `opening` deliberately stays set: once the browser has refused a window,
    // this panel never asks for another one. Only closing it (or a fresh click
    // on the site's sign-in control) allows a new attempt, so a blocked popup
    // can never become a loop of popup attempts.
  }

  // The proxy serves this same entry point in place of a sign-in SDK that was
  // requested as a <script> without the shim having caught it first.
  w.__PXY_AUTH__ = {
    sdkBlocked: sdkBlocked,
    handoff: openHandoff,
    directSiteUrl: directSiteUrl,
    blocked: blockedSdks
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
