/**
 * A local stand-in for the search APIs (SearXNG / Brave / Google shapes).
 * The behaviour is keyed on the query so one endpoint per shape covers
 * results, empty, error, invalid JSON, rate limiting and timeouts.
 */
import http from 'node:http';

export const RESULT_URLS = ['http://site.test/landing', 'https://outside.example/page', 'http://cdn.test/asset', 'http://site.test/landing#dup', 'ftp://site.test/file', 'not a url'];

function results(page) {
  const suffix = page > 1 ? ` (page ${page})` : '';
  return [
    { title: `Landing <b>page</b>${suffix}`, url: RESULT_URLS[0], snippet: 'A page on the &amp; test site <em>with</em> markup' },
    { title: 'Outside', url: RESULT_URLS[1], snippet: 'Not in the authorized scope' },
    { title: 'CDN asset', url: RESULT_URLS[2], snippet: 'On a blacklisted host' },
    { title: 'Duplicate', url: RESULT_URLS[3], snippet: 'Same URL again with a fragment' },
    { title: 'FTP', url: RESULT_URLS[4], snippet: 'Unsupported scheme' },
    { title: 'Broken', url: RESULT_URLS[5], snippet: 'Not a URL' }
  ];
}

export function createMockSearch() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock.local');
    const q = url.searchParams.get('q') || '';
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (q === 'fail') return json(500, { error: 'boom' });
    if (q === 'limited') return json(429, { error: 'slow down' });
    if (q === 'badjson') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{not json');
    }
    if (q === 'slow') {
      return setTimeout(() => {
        if (!res.destroyed) json(200, { results: [] });
      }, 2500).unref();
    }
    const empty = q === 'empty';
    switch (url.pathname) {
      case '/search': {
        const page = Number(url.searchParams.get('pageno') || 1);
        const list = empty ? [] : results(page).map((r) => ({ title: r.title, url: r.url, content: r.snippet, engine: 'mock' }));
        return json(200, { query: q, number_of_results: empty ? 0 : 1234, results: list, suggestions: empty ? [] : ['hockey drills', 'hockey <b>skills</b>'] });
      }
      case '/brave': {
        const page = Number(url.searchParams.get('offset') || 0) + 1;
        const list = empty ? [] : results(page).map((r) => ({ title: r.title, url: r.url, description: r.snippet }));
        return json(200, { query: { original: q, more_results_available: !empty && page < 3 }, web: { results: list } });
      }
      case '/google': {
        const page = Math.floor((Number(url.searchParams.get('start') || 1) - 1) / 10) + 1;
        const list = empty ? [] : results(page).map((r) => ({ title: r.title, link: r.url, snippet: r.snippet }));
        const body = { items: list, searchInformation: { totalResults: empty ? '0' : '98700' } };
        if (!empty && page < 3) body.queries = { nextPage: [{ startIndex: page * 10 + 1 }] };
        return json(200, body);
      }
      default:
        return json(404, { error: 'not found' });
    }
  });

  return {
    server,
    requests,
    get port() {
      return server.address().port;
    },
    get url() {
      return `http://127.0.0.1:${this.port}`;
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return this;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    reset() {
      requests.length = 0;
    },
    last() {
      return requests[requests.length - 1];
    }
  };
}
