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
    if (url === undefined || url === null) return origOpenWin.apply(this, args);
    var raw = String(url);
    // A window onto a provider's sign-in UI is not a web page to proxy. Left
    // to `rewrite()` it would become a *proxied* copy of the provider, which
    // is both useless and exactly the second tab we must never create.
    var provider = providerWindow(raw);
    if (provider) {
      // Only where the operator registered this proxy's origin with the
      // provider can that window succeed. Anywhere else it would just show
      // the provider's own origin error, so say what is actually wrong.
      if (!authFlowHost) {
        showUnavailable(provider.name);
        return null;
      }
      return openProviderPopup(provider.url, provider.name);
    }
    args[0] = rewrite(raw);
    return origOpenWin.apply(this, args);
  };

  /** Is this `window.open` call a provider sign-in window? */
  function providerWindow(raw) {
    var u;
    try {
      u = new URL(raw.indexOf(PREFIX) === 0 ? fromProxyPath(raw) || raw : raw, currentPageUrl());
    } catch (e) {
      return null;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isProviderHost(u.hostname)) return null;
    return { url: u.href, name: u.hostname.indexOf('google') !== -1 ? 'Google' : u.hostname.indexOf('apple') !== -1 ? 'Apple' : u.hostname };
  }

  // --- Third-party sign-in SDKs -------------------------------------------
  //
  // A "Sign in with Google/Apple/..." SDK is bound to the application's own
  // origin. Google Identity Services asks `accounts.google.com/gsi/status`
  // whether `window.location.origin` is an Authorized JavaScript origin of the
  // site's OAuth client *before* it will render a button or open its popup; an
  // origin that is not registered gets HTTP 403 and the flow stops there. A
  // proxied page is served from the proxy's origin, so for somebody else's
  // site that answer is always no. We never forge an origin, never touch
  // anyone else's OAuth client, and never build an authorization request of
  // our own.
  //
  // Two outcomes, and only two:
  //
  //   * The operator runs this application and has registered the proxy's
  //     origin with the provider (`PROXY_AUTH_FLOW_HOSTS`, `cfg.authFlowHost`).
  //     Then the SDK is left completely alone: it loads from the provider,
  //     exactly as it would on the real site, and Google's own popup UX runs
  //     with the site's own client id, redirect URI, state and nonce. The
  //     proxied page stays open underneath, which is what that UX is for.
  //
  //   * Anyone else's site. The SDK is never fetched, because it cannot work;
  //     the sign-in control says so and the page stays exactly where it is.
  //     Nothing is opened: no provider window, and above all no second copy
  //     of the site the visitor is already on.

  var EMPTY_SCRIPT = 'data:text/javascript,';
  var authFlowHost = cfg.authFlowHost === true;
  var blockedSdks = {};

  /** Hosts whose windows are the provider's own sign-in UI, never a website. */
  function isProviderHost(host) {
    host = String(host || '').toLowerCase();
    var exact = [
      'accounts.google.com',
      'accounts.youtube.com',
      'oauth2.googleapis.com',
      'appleid.apple.com',
      'idmsa.apple.com',
      'login.microsoftonline.com',
      'login.live.com',
      'www.facebook.com',
      'm.facebook.com',
      'github.com',
      'id.twitch.tv',
      'auth.atlassian.com'
    ];
    if (exact.indexOf(host) !== -1) return true;
    var suffixes = ['.auth0.com', '.okta.com', '.b2clogin.com', '.ciamlogin.com', '.onelogin.com'];
    for (var i = 0; i < suffixes.length; i++) {
      if (host.length > suffixes[i].length && host.slice(-suffixes[i].length) === suffixes[i]) return true;
    }
    return false;
  }

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
    var target = null;
    try {
      var str = String(value == null ? '' : value).trim();
      // Only an http(s) URL can be an SDK. Relative and protocol-relative
      // forms resolve against the page; data:, blob: and javascript: cannot.
      var absolute = str.indexOf(PREFIX) === 0 ? fromProxyPath(str) : SCHEME_RE.test(str) && !/^https?:/i.test(str) ? '' : str;
      if (absolute) {
        target = new URL(absolute, currentPageUrl());
        provider = matchAuthSdk(target);
      }
    } catch (e) {
      provider = '';
    }
    if (!provider) return rewrite(value);
    // The operator vouched for this host, so the provider's own SDK is what
    // should run: load it from the provider, unproxied, and stay out of it.
    if (authFlowHost) return target.href;
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
   * `renderButton` simply draws a control that explains why sign-in cannot
   * run here. Nothing it does could make the page believe someone signed in.
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
      // The same reason a real browser reports when One Tap cannot run.
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
        renderSignInButton(parent, 'Google', options);
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
    g.accounts.oauth2 = g.accounts.oauth2 || {
      initTokenClient: function () {
        return {
          requestAccessToken: function () {
            showUnavailable('Google');
          }
        };
      },
      initCodeClient: function () {
        return {
          requestCode: function () {
            showUnavailable('Google');
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

  /** The site's own container, filled with a control that says what it does. */
  function renderSignInButton(parent, provider, options) {
    if (!parent || parent.nodeType !== 1) return;
    if (parent.querySelector('[data-pxy-auth-button]')) return;
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
      showUnavailable(provider);
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

  // --- the panel ----------------------------------------------------------
  var panelEl = null;
  var watcher = null;

  function closePanel() {
    if (watcher) {
      clearInterval(watcher);
      watcher = null;
    }
    if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
    panelEl = null;
  }

  function el(tag, css, text) {
    var node = document.createElement(tag);
    node.setAttribute('data-pxy-ignore', '1');
    if (css) node.style.cssText = css;
    if (text) node.textContent = text;
    return node;
  }

  var CARD_CSS =
    'all:initial;box-sizing:border-box;max-width:440px;width:calc(100% - 32px);padding:24px;border-radius:14px;' +
    'background:#121820;color:#e6edf3;box-shadow:0 18px 48px rgba(0,0,0,.55);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;text-align:left;';
  var TITLE_CSS = 'all:initial;display:block;font:600 18px/1.3 inherit;color:#fff;margin:0 0 10px;';
  var BODY_CSS = 'all:initial;display:block;font:inherit;color:#9fb0c0;margin:0 0 18px;';
  var ROW_CSS = 'all:initial;display:flex;flex-wrap:wrap;gap:10px;font:inherit;';
  var PRIMARY_CSS =
    'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
    'border-radius:10px;background:#4cc2ff;color:#04121c;font:600 14px/1 inherit;cursor:pointer;';
  var GHOST_CSS =
    'all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;' +
    'border-radius:10px;border:1px solid #2b3a48;color:#9fb0c0;font:500 14px/1 inherit;cursor:pointer;';

  /** Open (or reuse) the overlay and return the card to draw into. */
  function openPanel() {
    closePanel();
    panelEl = el(
      'div',
      'all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(4,8,12,.72);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;'
    );
    var card = el('div', CARD_CSS);
    panelEl.appendChild(card);
    panelEl.addEventListener('click', function (ev) {
      if (ev.target === panelEl) closePanel();
    });
    (document.body || document.documentElement).appendChild(panelEl);
    return card;
  }

  function button(label, css, onClick) {
    var b = el('button', css, label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }

  function fill(card, title, body, buttons) {
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(el('h2', TITLE_CSS, title));
    card.appendChild(el('p', BODY_CSS, body));
    var row = el('div', ROW_CSS);
    for (var i = 0; i < buttons.length; i++) row.appendChild(buttons[i]);
    card.appendChild(row);
    return card;
  }

  /**
   * The only answer available for somebody else's site. The proxied page is
   * left exactly as it was: no provider window, and no second copy of the
   * site the visitor is already looking at.
   */
  function showUnavailable(provider, detail) {
    var name = provider || 'Google';
    var host = '';
    try {
      host = new URL(directSiteUrl()).hostname;
    } catch (e) {
      host = 'this website';
    }
    var card = openPanel();
    fill(
      card,
      name + ' sign-in isn’t available inside this proxy',
      detail ||
        name +
          ' only accepts a sign-in that starts from ' +
          host +
          '’s own web address. This page is being served through the proxy, so ' +
          name +
          ' refuses the request before any sign-in window can open. Nothing can be done about that from here without impersonating ' +
          host +
          ', which this proxy will not do.',
      [
        button('Try again', PRIMARY_CSS, function () {
          retry(name);
        }),
        button('Close', GHOST_CSS, closePanel)
      ]
    );
    card.appendChild(
      el(
        'p',
        'all:initial;display:block;font:400 12px/1.5 inherit;color:#7d8d9c;margin:16px 0 0;',
        'You stay on this page, and stay signed out on it. To use your account, open ' + host + ' yourself in a new tab.'
      )
    );
  }

  /** Re-check, with a visible loading state, then report the same answer. */
  function retry(provider) {
    var card = openPanel();
    fill(card, 'Checking…', 'Asking ' + provider + ' whether this address may start a sign-in.', [button('Cancel', GHOST_CSS, closePanel)]);
    setTimeout(function () {
      if (!panelEl) return;
      showUnavailable(provider);
    }, 600);
  }

  /**
   * A provider sign-in window, for a host the operator vouched for. Only ever
   * the provider's own URL, never proxied, with the parent page left open
   * behind it -- that is the whole point of the popup UX.
   */
  function openProviderPopup(url, provider) {
    var name = provider || 'Google';
    var win = null;
    try {
      win = origOpenWin.call(w, url, 'pxy_signin', 'popup=1,width=500,height=640');
    } catch (e) {
      win = null;
    }
    if (!win) {
      var blocked = openPanel();
      fill(blocked, 'Sign-in window was blocked', 'Your browser stopped the ' + name + ' sign-in window from opening. Allow pop-ups for this page, then try again.', [
        button('Try again', PRIMARY_CSS, function () {
          closePanel();
          openProviderPopup(url, name);
        }),
        button('Close', GHOST_CSS, closePanel)
      ]);
      return null;
    }
    try {
      win.focus();
    } catch (e) {
      /* focus is a nicety */
    }
    var card = openPanel();
    fill(card, 'Waiting for ' + name + '…', 'Finish signing in in the ' + name + ' window. This page stays open and will pick up from where it is.', [
      button('Cancel', GHOST_CSS, function () {
        closePanel();
        try {
          win.close();
        } catch (e) {
          /* the window is the provider's; it may refuse */
        }
      })
    ]);
    watcher = setInterval(function () {
      var closed = false;
      try {
        closed = win.closed;
      } catch (e) {
        closed = false;
      }
      if (!closed) return;
      clearInterval(watcher);
      watcher = null;
      if (!panelEl) return;
      // The window went away without the page reporting a session. Say so
      // plainly rather than guessing that it worked.
      fill(
        panelEl.firstChild,
        'Sign-in window was closed',
        'The ' + name + ' window closed before this page reported a signed-in session. If you did sign in, reload the page; otherwise try again.',
        [
          button('Try again', PRIMARY_CSS, function () {
            closePanel();
            openProviderPopup(url, name);
          }),
          button('Close', GHOST_CSS, closePanel)
        ]
      );
    }, 500);
    return win;
  }

  w.__PXY_AUTH__ = {
    sdkBlocked: sdkBlocked,
    unavailable: showUnavailable,
    popup: openProviderPopup,
    directSiteUrl: directSiteUrl,
    blocked: blockedSdks,
    supported: authFlowHost
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
