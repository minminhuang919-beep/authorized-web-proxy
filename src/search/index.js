/**
 * Web search for the homepage box. The application only ever talks to a
 * search *backend* over HTTP — it never embeds or supervises one. Search is
 * OFF unless the administrator sets SEARCH_PROVIDER explicitly:
 *
 *   none     no search: queries get a "not configured" page (default)
 *   bing     Bing's RSS result feed (`?q=…&format=rss`). Keyless: no account,
 *            no API key, nothing to host. SEARCH_PROVIDER_URL optionally
 *            overrides the endpoint (default https://www.bing.com/search).
 *            This is what the Render free deployment uses — it is the one
 *            backend that is reachable from that instance without a key.
 *   searxng  a SearXNG instance's JSON API (SEARCH_PROVIDER_URL = its base
 *            URL; `json` must be enabled in its `search.formats`)
 *   brave    Brave Search API (SEARCH_API_KEY)
 *   google   Google Programmable Search JSON API (SEARCH_API_KEY + SEARCH_ENGINE_ID)
 *   proxy    no API: the query is opened on a search *website* through the
 *            proxy itself (SEARCH_PROVIDER_URL = URL template with `{q}`,
 *            whose host must be inside the authorized scope, e.g.
 *            https://duckduckgo.com/html/?q={q})
 *
 * A provider whose required settings are missing does not disable the
 * feature: it stays selected and every search reports "Search is temporarily
 * unavailable" (the missing variable is in `reason`, for administrators
 * only). "Web search isn't set up yet" is reserved for SEARCH_PROVIDER=none,
 * so the page never claims the feature is unimplemented when it is merely
 * misconfigured. Either way an incomplete search configuration never takes
 * the proxy itself down.
 *
 * API providers are called with plain `fetch()`, not the SSRF-guarded
 * upstream client: the endpoint is operator configuration (like a database
 * URL) and may legitimately live on a private network (a SearXNG container
 * next to the app). The visitor's query only ever travels URL-encoded in the
 * query string, so it cannot change the destination. Results are reduced to
 * plain-text titles/snippets and http(s) URLs before they reach the page.
 */
import { ConfigError, SEARCH_PROVIDERS } from '../config.js';
import { ProxyError, SearchTimeoutError, SearchUnavailableError } from '../errors.js';
import { validateTarget } from '../security/target.js';

export { SEARCH_PROVIDERS };
export const MAX_PAGE = 10;
const MAX_RESULTS = 20;
const MAX_SNIPPET = 320;
const MAX_TITLE = 160;
const MAX_BODY = 4 * 1024 * 1024;

/** The query used by the administrator-only connectivity check. */
const PROBE_QUERY = 'test';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the XML/HTML entities providers use, without touching anything else. */
export function decodeEntities(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const c = code.toLowerCase();
    if (c.startsWith('#x')) return safeChar(parseInt(c.slice(2), 16));
    if (c.startsWith('#')) return safeChar(parseInt(c.slice(1), 10));
    return ENTITIES[c] ?? m;
  });
}

/** Reduce provider markup (Brave bolds matches, SearXNG may include tags) to plain text. */
export function stripHtml(value) {
  if (value === null || value === undefined) return '';
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' '))
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

function clampPage(page, max = MAX_PAGE) {
  const n = Number.parseInt(page, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/**
 * Pull `<item>` entries out of an RSS feed. Deliberately a small regex reader
 * rather than a dependency: the feed is a flat list of items with three text
 * fields, and every value is sanitised again before it reaches the page.
 * Matching is scoped to each item so channel-level `<link>`/`<title>` tags
 * (including the `<image>` block) can never be mistaken for a result.
 * @param {string} xml
 */
export function parseRssItems(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const out = [];
  for (const match of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    out.push({ title: rssField(block, 'title'), link: rssField(block, 'link'), description: rssField(block, 'description') });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

function rssField(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!m) return '';
  const raw = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return cdata ? cdata[1].trim() : raw;
}

/** Keep only well-formed http(s) results, as plain text, without duplicates. */
export function sanitizeResults(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.url !== 'string') continue;
    let url;
    try {
      url = new URL(decodeEntities(item.url).trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = truncate(stripHtml(item.title), MAX_TITLE) || url.hostname;
    const snippet = truncate(stripHtml(item.snippet), MAX_SNIPPET);
    // The normalised shape the results page renders: title, url, snippet, domain.
    out.push({ title, url: url.href, domain: url.hostname, snippet });
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
  bing: {
    label: 'Bing',
    endpoint: 'https://www.bing.com/search',
    // RSS, not JSON: a ~4 KB feed instead of a ~120 KB results page, which
    // matters on a 512 MB / 0.1 CPU instance.
    format: 'xml',
    accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
    // The feed always answers with the first page of results and ignores
    // `first`/`count`, so the results page never offers a second page.
    maxPage: 1,
    request({ query, settings }) {
      const url = new URL(settings.url || this.endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'rss');
      return { url, headers: {} };
    },
    parse(xml) {
      const results = parseRssItems(xml).map((item) => ({ title: item.title, url: item.link, snippet: item.description }));
      return { results, hasNext: false, total: null, related: null };
    }
  },
  searxng: {
    label: 'SearXNG',
    format: 'json',
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
    format: 'json',
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
    format: 'json',
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
 * The provider's *built-in* endpoint host, for the diagnostics page. Empty
 * once SEARCH_PROVIDER_URL is set: an operator-supplied backend URL may name
 * an internal host, so it is only ever reported as configured / not
 * configured, never printed.
 */
function defaultEndpointHost(kind, settings) {
  if (settings.url) return '';
  const raw = ADAPTERS[kind]?.endpoint || '';
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

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

  // Search is deliberately switched off. This — and only this — is the state
  // the results page describes as "not set up yet".
  if (kind === 'none') {
    return {
      kind,
      label: '',
      enabled: false,
      configured: true,
      reason: '',
      mode: 'off',
      defaultEndpoint: '',
      async search() {
        throw new SearchUnavailableError('Search is not configured on this proxy.');
      },
      async check() {
        return { ok: false, configured: false, ms: 0, results: 0, error: 'No search provider is configured.' };
      },
      targetFor() {
        throw new SearchUnavailableError('Search is not configured on this proxy.');
      }
    };
  }

  // A provider was chosen but one of its settings is missing. The feature
  // stays selected: searches are attempted and fail with "temporarily
  // unavailable" rather than pretending search does not exist.
  if (!settings.configured) {
    logger?.warn({ provider: kind, reason: settings.reason }, 'search provider is missing a required setting: searches will fail');
    const fail = () => new SearchUnavailableError('Search is temporarily unavailable. Please try again in a moment.');
    return {
      kind,
      label: ADAPTERS[kind]?.label || kind,
      enabled: false,
      configured: false,
      // Always `results`, even for `proxy`: with nowhere to redirect to, the
      // query belongs on the results page as a failure the visitor can see.
      reason: settings.reason,
      mode: 'results',
      defaultEndpoint: '',
      async search() {
        throw fail();
      },
      async check() {
        return { ok: false, configured: false, ms: 0, results: 0, error: settings.reason };
      },
      targetFor() {
        throw fail();
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
      throw new ConfigError(`SEARCH_PROVIDER_URL cannot be used with SEARCH_PROVIDER=proxy: ${why}`, { cause: err });
    }
    return {
      kind,
      label: probe.hostname,
      enabled: true,
      configured: true,
      reason: '',
      mode: 'redirect',
      defaultEndpoint: '', // always operator-supplied in this mode
      async search() {
        throw new SearchUnavailableError();
      },
      /** Nothing is fetched in redirect mode: the destination is re-validated instead. */
      async check() {
        try {
          targetFor(PROBE_QUERY);
          return { ok: true, configured: true, ms: 0, results: 0, error: '' };
        } catch (err) {
          return { ok: false, configured: true, ms: 0, results: 0, error: err instanceof ProxyError ? err.message : 'The search website is not usable.' };
        }
      },
      targetFor
    };
  }

  const adapter = ADAPTERS[kind];
  if (!adapter) throw new ConfigError(`Unknown search provider "${kind}"`);
  const maxPage = adapter.maxPage ?? MAX_PAGE;

  const provider = {
    kind,
    label: adapter.label,
    enabled: true,
    configured: true,
    reason: '',
    mode: 'results',
    defaultEndpoint: defaultEndpointHost(kind, settings),
    targetFor() {
      throw new SearchUnavailableError();
    },
    /**
     * @param {string} query
     * @param {{ page?: number|string, signal?: AbortSignal }} [opts]
     * @returns {Promise<SearchResponse>}
     */
    async search(query, { page = 1, signal } = {}) {
      const pageNo = clampPage(page, maxPage);
      const { url, headers } = adapter.request({ query, page: pageNo, settings });
      const timeout = AbortSignal.timeout(settings.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: adapter.accept || 'application/json', ...headers }, signal: combined, redirect: 'manual' });
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
      let payload;
      try {
        const text = await res.text();
        if (text.length > MAX_BODY) throw new Error('too large');
        payload = adapter.format === 'xml' ? text : JSON.parse(text);
      } catch (err) {
        if (timeout.aborted) throw new SearchTimeoutError();
        logger?.warn({ provider: kind, host: url.hostname, err: err.message }, 'search provider sent an invalid response');
        throw new SearchUnavailableError();
      }
      const parsed = adapter.parse(payload, { page: pageNo });
      return {
        query,
        page: pageNo,
        provider: adapter.label,
        results: sanitizeResults(parsed.results),
        hasNext: Boolean(parsed.hasNext) && pageNo < maxPage,
        total: parsed.total ?? null,
        related: sanitizeRelated(parsed.related)
      };
    },
    /**
     * Administrator diagnostics: run one real query against the backend and
     * report whether it answered. Never returns the URL, the API key or the
     * provider's own error text.
     */
    async check({ signal } = {}) {
      const started = Date.now();
      try {
        const data = await provider.search(PROBE_QUERY, { signal });
        return { ok: data.results.length > 0, configured: true, ms: Date.now() - started, results: data.results.length, error: data.results.length ? '' : 'The provider answered but returned no results.' };
      } catch (err) {
        const message = err instanceof ProxyError ? err.message : 'The search provider could not be reached.';
        return { ok: false, configured: true, ms: Date.now() - started, results: 0, error: message };
      }
    }
  };
  return provider;
}

/**
 * Annotate results for the results page. Every result opens through
 * `/open?url=…`, so a click always runs the full chain (authorized scope →
 * blacklist → SSRF checks at connection time) and an unauthorized result
 * lands on the secure "Website not authorized" page. The state computed here
 * only labels what will happen: `proxied` (opens through the proxy),
 * `unauthorized`, `blocked` (blacklisted) or `unsupported` (port,
 * credentials, …).
 * @param {Array<{ url: string, domain: string }>} results
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
 * @property {boolean} configured every required setting is present
 * @property {string} reason why it is not configured (empty when it is)
 * @property {'off'|'results'|'redirect'} mode
 * @property {string} defaultEndpoint built-in backend host ('' once SEARCH_PROVIDER_URL is set)
 * @property {(query: string, opts?: { page?: number, signal?: AbortSignal }) => Promise<SearchResponse>} search
 * @property {(opts?: { signal?: AbortSignal }) => Promise<SearchCheck>} check connectivity probe
 * @property {(query: string) => URL} targetFor `proxy` mode: the validated search-website URL
 */

/**
 * @typedef {object} SearchCheck
 * @property {boolean} ok
 * @property {boolean} configured
 * @property {number} ms
 * @property {number} results
 * @property {string} error user-safe reason when `ok` is false
 */

/**
 * @typedef {object} SearchResponse
 * @property {string} query
 * @property {number} page
 * @property {string} provider
 * @property {Array<{ title: string, url: string, domain: string, snippet: string }>} results
 * @property {boolean} hasNext
 * @property {number|null} total
 * @property {string[]} related
 */
