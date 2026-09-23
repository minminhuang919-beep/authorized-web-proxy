/**
 * A very small DOM, just big enough to run `src/public/shim.js`.
 *
 * There is no DOM library in this project's dependencies, and pulling one in
 * to test one file would be a poor trade. This implements only what the shim
 * actually touches: elements with attributes and children, the URL-bearing
 * property setters it patches, `window.open`, and event listeners. It is
 * deliberately literal — if the shim starts using something that is not here,
 * the test fails loudly rather than silently passing.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'public', 'shim.js');

/** Properties the shim patches with `Object.defineProperty` on a prototype. */
const URL_PROPS = {
  HTMLAnchorElement: ['href'],
  HTMLAreaElement: ['href'],
  HTMLLinkElement: ['href'],
  HTMLBaseElement: ['href'],
  HTMLImageElement: ['src', 'srcset'],
  HTMLScriptElement: ['src'],
  HTMLIFrameElement: ['src'],
  HTMLFrameElement: ['src'],
  HTMLEmbedElement: ['src'],
  HTMLSourceElement: ['src', 'srcset'],
  HTMLTrackElement: ['src'],
  HTMLMediaElement: ['src'],
  HTMLInputElement: ['src', 'formAction'],
  HTMLVideoElement: ['poster'],
  HTMLFormElement: ['action'],
  HTMLButtonElement: ['formAction'],
  HTMLObjectElement: ['data'],
  HTMLQuoteElement: ['cite']
};

const TAG_CLASS = {
  A: 'HTMLAnchorElement',
  SCRIPT: 'HTMLScriptElement',
  IMG: 'HTMLImageElement',
  IFRAME: 'HTMLIFrameElement',
  LINK: 'HTMLLinkElement',
  FORM: 'HTMLFormElement',
  BUTTON: 'HTMLButtonElement',
  DIV: 'HTMLElement',
  P: 'HTMLElement',
  H2: 'HTMLElement',
  SPAN: 'HTMLElement',
  BODY: 'HTMLElement'
};

/**
 * @param {object} [opts]
 * @param {string} [opts.proxyUrl] the address bar of the proxied page
 * @param {string} [opts.pageUrl] the upstream URL it stands for
 * @param {string[]} [opts.allowed] the authorized scope handed to the shim
 * @param {null|object} [opts.popup] what `window.open` returns (null = blocked)
 * @param {boolean} [opts.authFlowHost] the operator registered this proxy's
 *   origin with the provider for this host (PROXY_AUTH_FLOW_HOSTS)
 */
export function createDom({
  proxyUrl = 'http://proxy.test/p/https/www.geoguessr.com/',
  pageUrl = 'https://www.geoguessr.com/',
  allowed = ['*'],
  authFlowHost = false,
  popup = { closed: false }
} = {}) {
  const location = new URL(proxyUrl);
  const opened = [];
  const listeners = new Map();
  const timers = new Map();
  const intervals = new Map();
  let timerId = 0;

  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.attributes = new Map();
      this.childNodes = [];
      this.parentNode = null;
      this.style = createStyle();
      this._listeners = new Map();
      this.textContent = '';
    }
    getAttribute(name) {
      const v = this.attributes.get(String(name).toLowerCase());
      return v === undefined ? null : v;
    }
    setAttribute(name, value) {
      this.attributes.set(String(name).toLowerCase(), String(value));
    }
    removeAttribute(name) {
      this.attributes.delete(String(name).toLowerCase());
    }
    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }
    appendChild(child) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i !== -1) this.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    }
    insertBefore(child) {
      return this.appendChild(child);
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    closest(selector) {
      const attr = /^\[([^\]=]+)\]$/.exec(selector);
      let node = this;
      while (node) {
        if (attr && node.hasAttribute && node.hasAttribute(attr[1])) return node;
        node = node.parentNode;
      }
      return null;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const wanted = String(selector)
        .split(',')
        .map((s) => /^\[([^\]=]+)\]$/.exec(s.trim()))
        .filter(Boolean)
        .map((m) => m[1]);
      const out = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (wanted.some((a) => child.hasAttribute && child.hasAttribute(a))) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
    /** Fire a listener as a click would, with a minimal event object. */
    click() {
      const ev = { type: 'click', target: this, preventDefault() {}, stopPropagation() {} };
      for (const fn of (this._listeners.get('click') || []).slice()) fn.call(this, ev);
      return ev;
    }
    dispatch(type, ev) {
      for (const fn of (this._listeners.get(type) || []).slice()) fn.call(this, ev || { type, target: this });
    }
    /** Every descendant, for assertions. */
    all() {
      const out = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    text() {
      return [this.textContent, ...this.all().map((n) => n.textContent)].filter(Boolean).join(' ');
    }
  }

  function createStyle() {
    return {
      _css: '',
      get cssText() {
        return this._css;
      },
      set cssText(v) {
        this._css = String(v);
      },
      setProperty() {}
    };
  }

  const classes = {};
  for (const name of Object.keys(URL_PROPS)) {
    classes[name] = class extends Node {};
    Object.defineProperty(classes[name], 'name', { value: name });
  }
  classes.HTMLElement = class extends Node {};

  // The real URL-bearing properties: reading and writing the attribute, which
  // is what the shim's `patchSetter` wraps.
  for (const [name, props] of Object.entries(URL_PROPS)) {
    for (const prop of props) {
      const attr = prop.toLowerCase();
      Object.defineProperty(classes[name].prototype, prop, {
        get() {
          return this.getAttribute(attr) || '';
        },
        set(v) {
          this.setAttribute(attr, v);
        },
        configurable: true,
        enumerable: true
      });
    }
  }

  const document = {
    nodeType: 9,
    createElement(tag) {
      const Cls = classes[TAG_CLASS[String(tag).toUpperCase()] || 'HTMLElement'] || classes.HTMLElement;
      return new Cls(tag);
    },
    getElementById(id) {
      return document.documentElement.all().find((n) => n.getAttribute('id') === id) || null;
    },
    getElementsByTagName(tag) {
      const t = String(tag).toUpperCase();
      return document.documentElement.all().filter((n) => n.tagName === t);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    cookie: ''
  };
  document.documentElement = new classes.HTMLElement('html');
  document.body = new classes.HTMLElement('body');
  document.documentElement.appendChild(document.body);

  const window = {
    location,
    document,
    URL,
    __PXY__: { pageUrl, prefix: '/p/', mode: 'direct', allowed, authFlowHost },
    open(url, target, features) {
      opened.push({ url: String(url), target, features });
      return typeof popup === 'function' ? popup(String(url)) : popup;
    },
    setTimeout: (fn) => {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    // The popup watcher polls `win.closed`; tests drive it with `tick()`.
    setInterval: (fn) => {
      const id = ++timerId;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    history: { pushState() {}, replaceState() {} },
    navigator: {},
    // Not provided on purpose: the shim must cope without a MutationObserver.
    Element: classes.HTMLElement,
    ...classes
  };
  window.window = window;
  window.self = window;
  // Every element class shares one prototype chain root, so the shim's
  // `Element.prototype.setAttribute` patch reaches all of them and
  // `this instanceof Element` holds for every element it touches.
  for (const name of Object.keys(classes)) {
    if (name !== 'HTMLElement') Object.setPrototypeOf(classes[name].prototype, classes.HTMLElement.prototype);
  }
  Object.setPrototypeOf(classes.HTMLElement.prototype, Node.prototype);
  Object.setPrototypeOf(classes.HTMLElement, Node);
  window.Element = Node;
  window.Node = Node;
  window.Document = class Document {};
  window.CSSStyleDeclaration = null;

  const context = vm.createContext(window);
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(SHIM, 'utf8'), context, { filename: 'shim.js' });

  return {
    window,
    document,
    classes,
    opened,
    /** The proxy's sign-in hand-off API, installed by the shim. */
    get auth() {
      return window.__PXY_AUTH__;
    },
    /** The hand-off panel currently on screen, if any. */
    panel() {
      return document.body.childNodes.find((n) => n.getAttribute('data-pxy-ignore') === '1' && n.tagName === 'DIV') || null;
    },
    /** Run every pending `setTimeout` the shim queued. */
    runTimers() {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) fn();
    },
    /** One turn of every `setInterval` the shim is polling with. */
    tick() {
      for (const [, fn] of [...intervals.entries()]) fn();
    },
    get intervalCount() {
      return intervals.size;
    },
    async flush() {
      await new Promise((r) => setImmediate(r));
    }
  };
}
