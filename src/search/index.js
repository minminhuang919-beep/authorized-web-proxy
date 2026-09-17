/**
 * Web search for the homepage box. Search is OFF unless the administrator
 * sets SEARCH_PROVIDER explicitly:
 *
 *   none     no search: queries get a "not configured" page (default)
 *   searxng  a SearXNG instance's JSON API (SEARCH_URL = its base URL;
 *            `json` must be enabled in its `search.formats`)
 *   brave    Brave Search API (SEARCH_API_KEY)
 *   google   Google Programmable Search JSON API (SEARCH_API_KEY + SEARCH_ENGINE_ID)
 *   proxy    no API: the query is opened on a search *website* through the
 *            proxy itself (SEARCH_URL = URL template with `{q}`, whose host
 *            must be inside the authorized scope, e.g.
 *            https://duckduckgo.com/html/?q={q})
 *
 * Nothing is scraped: the API providers are documented JSON APIs, and
 * `proxy` mode just renders a website the visitor asked for, like any other
 * proxied page.
 *
 * API providers are called with plain `fetch()`, not the SSRF-guarded
 * upstream client: the endpoint is operator configuration (like a database
 * URL) and may legitimately live on a private network (a SearXNG container
 * next to the app). The visitor's query only ever travels URL-encoded in the
 * query string, so it cannot change the destination. Results are reduced to
 * plain-text titles/snippets and http(s) URLs before they reach the page.
 */
import { ConfigError } from '../config.js';
import { ProxyError, SearchTimeoutError, SearchUnavailableError } from '../errors.js';
import { validateTarget } from '../security/target.js';

export const SEARCH_PROVIDERS = ['none', 'searxng', 'brave', 'google', 'proxy'];
export const MAX_PAGE = 10;
const MAX_RESULTS = 20;
const MAX_SNIPPET = 320;
const MAX_TITLE = 160;
const MAX_BODY = 4 * 1024 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Reduce provider HTML (Brave bolds matches, SearXNG may include tags) to plain text. */
export function stripHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
      const c = code.toLowerCase();
      if (c.startsWith('#x')) return safeChar(parseInt(c.slice(2), 16));
      if (c.startsWith('#')) return safeChar(parseInt(c.slice(1), 10));
      return ENTITIES[c] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function safeChar(codePoint) {
  if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 0x10ffff) return ' ';
  return String.fromCodePoint(codePoint);
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function clampPage(page) {
  const n = Number.parseInt(page, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}

/** Keep only well-formed http(s) results, as plain text, without duplicates. */
export function sanitizeResults(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = truncate(stripHtml(item.title), MAX_TITLE) || url.hostname;
    const snippet = truncate(stripHtml(item.snippet), MAX_SNIPPET);
    out.push({ title, url: url.href, host: url.hostname, snippet });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function sanitizeRelated(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const text = typeof item === 'string' ? stripHtml(item) : '';
    if (text && text.length <= 100 && !out.includes(text)) out.push(text);
    if (out.length >= 8) break;
  }
  return out;
}

const ADAPTERS = {
  searxng: {
    label: 'SearXNG',
    request({ query, page, settings }) {
      const url = new URL(`${settings.url.replace(/\/+$/, '')}/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('pageno', String(page));
      return { url, headers: {} };
    },
    parse(json) {
      const results = (Array.isArray(json?.results) ? json.results : []).map((r) => ({ title: r?.title, url: r?.url, snippet: r?.content }));
      return { results, hasNext: results.length > 0, total: Number(json?.number_of_results) || null, related: json?.suggestions };
    }
  },
  brave: {
    label: 'Brave Search',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    request({ query, page, settings }) {
      const url = new URL(settings.url || this.endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('count', '20');
      url.searchParams.set('offset', String(Math.min(page - 1, 9)));
      return { url, headers: { 'x-subscription-token': settings.apiKey } };
    },
    parse(json) {
      const results = (Array.isArray(json?.web?.results) ? json.web.results : []).map((r) => ({ title: r?.title, url: r?.url, snippet: r?.description }));
      return { results, hasNext: Boolean(json?.query?.more_results_available), total: null, related: null };
    }
  },
  google: {
    label: 'Google Programmable Search',
    endpoint: 'https://www.googleapis.com/customsearch/v1',
    request({ query, page, settings }) {
      const url = new URL(settings.url || this.endpoint);
      url.searchParams.set('key', settings.apiKey);
      url.searchParams.set('cx', settings.engineId);
      url.searchParams.set('q', query);
      url.searchParams.set('num', '10');
      url.searchParams.set('start', String((page - 1) * 10 + 1));
      return { url, headers: {} };
    },
    parse(json) {
      const results = (Array.isArray(json?.items) ? json.items : []).map((r) => ({ title: r?.title, url: r?.link, snippet: r?.snippet }));
      return { results, hasNext: Boolean(json?.queries?.nextPage), total: Number(json?.searchInformation?.totalResults) || null, related: null };
    }
  }
};

/**
 * @param {object} opts
 * @param {ReturnType<import('../config.js').loadConfig>} opts.config
 * @param {object} opts.policy access policy
 * @param {import('pino').Logger} [opts.logger]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {SearchProvider}
 */
export function createSearchProvider({ config, policy, logger = null, fetchImpl = globalThis.fetch }) {
  const settings = config.search;
  const kind = settings.provider;

  if (kind === 'none') {
    return {
      kind,
      label: '',
      enabled: false,
      mode: 'off',
      async search() {
        throw new SearchUnavailableError('Search is not configured on this proxy.');
      },
      targetFor() {
        throw new SearchUnavailableError('Search is not configured on this proxy.');
      }
    };
  }

  if (kind === 'proxy') {
    const targetFor = (query) => validateTarget(new URL(settings.url.replaceAll('{q}', encodeURIComponent(query))), policy);
    let probe;
    try {
      probe = targetFor('probe');
    } catch (err) {
      if (!(err instanceof ProxyError)) throw err;
      const host = new URL(settings.url.replaceAll('{q}', 'probe')).hostname;
      const why =
        err.code === 'DOMAIN_NOT_ALLOWED'
          ? `"${host}" is not inside the authorized scope (add it to PROXY_ALLOWED_DOMAINS)`
          : err.code === 'DOMAIN_BLACKLISTED'
            ? `"${host}" is blacklisted`
            : err.message;
      throw new ConfigError(`SEARCH_URL cannot be used with SEARCH_PROVIDER=proxy: ${why}`, { cause: err });
    }
    return {
      kind,
      label: probe.hostname,
      enabled: true,
      mode: 'redirect',
      async search() {
        throw new SearchUnavailableError();
      },
      targetFor
    };
  }

  const adapter = ADAPTERS[kind];
  if (!adapter) throw new ConfigError(`Unknown search provider "${kind}"`);

  return {
    kind,
    label: adapter.label,
    enabled: true,
    mode: 'results',
    targetFor() {
      throw new SearchUnavailableError();
    },
    /**
     * @param {string} query
     * @param {{ page?: number|string, signal?: AbortSignal }} [opts]
     * @returns {Promise<SearchResponse>}
     */
    async search(query, { page = 1, signal } = {}) {
      const pageNo = clampPage(page);
      const { url, headers } = adapter.request({ query, page: pageNo, settings });
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: combined, redirect: 'manual' });
      } catch (err) {
        if (timeout.aborted) throw new SearchTimeoutError();
        if (signal?.aborted) throw err;
        logger?.warn({ provider: kind, host: url.hostname, err: err.message }, 'search provider unreachable');
        throw new SearchUnavailableError();
      }
      if (!res.ok) {
        logger?.warn({ provider: kind, host: url.hostname, status: res.status }, 'search provider error');
        if (res.status === 429) throw new SearchUnavailableError('The search provider is rate limiting requests. Please try again shortly.');
        throw new SearchUnavailableError();
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > MAX_BODY) throw new SearchUnavailableError();
      let json;
      try {
        const text = await res.text();
        if (text.length > MAX_BODY) throw new Error('too large');
        json = JSON.parse(text);
      } catch (err) {
        if (timeout.aborted) throw new SearchTimeoutError();
        logger?.warn({ provider: kind, host: url.hostname, err: err.message }, 'search provider sent an invalid response');
        throw new SearchUnavailableError();
      }
      const parsed = adapter.parse(json, { page: pageNo });
      return {
        query,
        page: pageNo,
        provider: adapter.label,
        results: sanitizeResults(parsed.results),
        hasNext: Boolean(parsed.hasNext) && pageNo < MAX_PAGE,
        total: parsed.total ?? null,
        related: sanitizeRelated(parsed.related)
      };
    }
  };
}

/**
 * Annotate results for the results page. Every result opens through
 * `/open?url=…`, so a click always runs the full chain (authorized scope →
 * blacklist → SSRF checks at connection time) and an unauthorized result
 * lands on the secure "Website not authorized" page. The state computed here
 * only labels what will happen: `proxied` (opens through the proxy),
 * `unauthorized`, `blocked` (blacklisted) or `unsupported` (port,
 * credentials, …).
 * @param {Array<{ url: string, host: string }>} results
 * @param {{ policy: object }} opts
 */
export function annotateResults(results, { policy }) {
  return results.map((r) => {
    const href = `/open?url=${encodeURIComponent(r.url)}`;
    try {
      validateTarget(new URL(r.url), policy);
      return { ...r, state: 'proxied', href };
    } catch (err) {
      if (!(err instanceof ProxyError)) throw err;
      if (err.code === 'DOMAIN_BLACKLISTED') return { ...r, state: 'blocked', href };
      if (err.code === 'DOMAIN_NOT_ALLOWED') return { ...r, state: 'unauthorized', href };
      return { ...r, state: 'unsupported', href };
    }
  });
}

/**
 * @typedef {object} SearchProvider
 * @property {string} kind
 * @property {string} label human-readable provider name
 * @property {boolean} enabled
 * @property {'off'|'results'|'redirect'} mode
 * @property {(query: string, opts?: { page?: number, signal?: AbortSignal }) => Promise<SearchResponse>} search
 * @property {(query: string) => URL} targetFor `proxy` mode: the validated search-website URL
 */

/**
 * @typedef {object} SearchResponse
 * @property {string} query
 * @property {number} page
 * @property {string} provider
 * @property {Array<{ title: string, url: string, host: string, snippet: string }>} results
 * @property {boolean} hasNext
 * @property {number|null} total
 * @property {string[]} related
 */
