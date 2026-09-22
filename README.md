# AnonView — an allowlisted “Anonymous View” web proxy

AnonView is a small, production-grade web proxy in the spirit of Startpage's
*Anonymous View*: you type a website — a configured shortcut such as
`google`, an address such as `example.com`, or a search query — the
**server** fetches the page and shows it to you, so the website sees the
proxy's IP address instead of yours. Links, images, stylesheets, forms and
most scripts keep working because every URL is rewritten to go back through
the proxy.

It is deliberately **not** an open proxy: only websites inside the
administrator's **authorized scope** can be opened, the administrator can
additionally **blacklist** individual websites, and a strict set of network
rules makes it unusable as an SSRF tool against internal services. It does
not try to defeat logins, CAPTCHAs, bot protection or content filters.

The repository contains the application, its test-suite, a Dockerfile, a
`docker-compose.yml` for local development, and a `render.yaml` Blueprint
that deploys it to **Render** as a free Docker web service with HTTPS.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Local development](#3-local-development)
4. [Environment variables](#4-environment-variables)
5. [Authorized scope and blacklist](#5-authorized-scope-and-blacklist) · [site shortcuts](#site-shortcuts-the-site-directory) · [web search](#web-search)
6. [Security model](#6-security-model)
7. [Deploying to Render](#7-deploying-to-render)
8. [Custom domain and HTTPS](#8-custom-domain-and-https)
9. [Viewing logs](#9-viewing-logs)
10. [Restarting and redeploying](#10-restarting-and-redeploying)
11. [Render free-tier limitations](#11-render-free-tier-limitations)
12. [Troubleshooting](#12-troubleshooting)
13. [Project structure](#13-project-structure)

---

## 1. What it does

* **Search-engine style homepage**: one large centred box that understands
  three kinds of input —
  * a **shortcut** configured by the administrator (`google`, `youtube`,
    `wikipedia` — no `https://`, `www.` or `.com` needed; matching ignores
    case), which opens the configured destination through the proxy;
  * a **website address** (`example.com/page`, `https://example.com`; the
    `https://` is optional), opened through the proxy;
  * anything else (`geoguessr`, `weather today`, `best hockey drills`) is a
    **web search**, answered on a results page by the search backend the
    administrator selected with `SEARCH_PROVIDER` (`bing` by default, which
    needs nothing else; `none` switches web search off).
    A bare word is never turned into a domain — `geoguessr` is a search, not
    `geoguessr.com`.

  The box says *Search the web or open a configured site*. While typing, it
  suggests matching shortcuts (keyboard navigable) next to a *Search for …*
  entry; the configured shortcuts are also shown as chips under the box. A
  progress bar and button spinner show while a page is being fetched.
* **Sign-in is handed to your browser, never faked.** A third-party OAuth /
  sign-in page (`appleid.apple.com`, `accounts.google.com`, an
  `/oauth/authorize` endpoint, a callback carrying an authorization code) gets
  a *Sign-in required* page with a **Continue to sign in** button that opens
  the provider's own website directly, outside the proxy — instead of the
  provider's `403 origin_mismatch`. The link is a bare origin: no OAuth
  parameter is copied into it. Ordinary `/login`, `/signin` and `/accounts`
  pages keep working through the proxy. See §6.
* Whether typed or behind a shortcut, every destination is validated and
  normalised, checked against the **authorized scope**, then the
  **blacklist**, then fetched server-side over HTTP/HTTPS (SSRF address checks
  run on the resolved addresses) and streamed back to you under
  `https://your-proxy/p/https/example.com/page` — the address bar stays on
  the proxy.
* HTML and CSS are rewritten on the fly so that navigation, images, fonts,
  stylesheets, forms, iframes and `srcset` images stay inside the proxy.
  Scripts are relayed unchanged; a small client-side shim keeps
  JavaScript-generated requests (`fetch`, `XMLHttpRequest`, dynamically
  inserted elements, `history.pushState`, …) inside the proxy as well.
* Cookies set by the website are kept in a **server-side, per-visitor session
  jar** and replayed only to that site, so site cookies never reach your
  browser. Sessions expire after 30 minutes of inactivity.
* Compressed responses (gzip, deflate, brotli, zstd) are handled; binary
  assets are streamed through untouched with their original headers.
* Redirects are re-validated against the allowlist before the browser is
  allowed to follow them.
* A protected **admin area** (`/admin`) with a dashboard (counts, proxy
  status, recent configuration changes), a **Sites** page (the shortcut
  directory: add / edit / enable / disable / delete / search, with each
  destination's live scope and blacklist status, JSON API), a **Blacklist**
  page (add / search / delete with confirmation, reasons, timestamps, JSON
  API) and a **Settings** page (authorized scope, running configuration).
* Light and dark themes (follows the system, with a manual toggle), fully
  keyboard accessible, responsive down to phone widths.
* `/health` returns a JSON status for monitoring and for Render's health check.

## 2. Architecture

```
                 Internet
                    │  HTTPS (Render-managed certificate)
        ┌───────────▼────────────┐
        │   Render edge / LB     │   TLS termination, HTTP→HTTPS redirect,
        │                        │   X-Forwarded-*, True-Client-IP headers
        └───────────┬────────────┘
                    │ HTTP to the container on 0.0.0.0:$PORT (10000)
        ┌───────────▼────────────┐
        │   AnonView (Node 24)   │   Fastify 5, non-root user, stateless
        │   Docker web service   │   (in-memory sessions, allowlist from env);
        └──────┬──────────┬──────┘   the image holds the Node app only
               │          │ one call per query to the search backend
               │          │ (SEARCH_PROVIDER, default `bing`: keyless RSS)
               │          ▼
               │   search backend: Bing's RSS feed, a SearXNG instance
               │   or a search API (never bundled into this image)
               │ HTTP(S) to allowlisted hosts only, via the SSRF-safe client
               ▼
        allowlisted websites
```

Request flow for the search box (`GET /search?q=…`):

0. `src/resolve.js` classifies the input, in this order: a configured,
   enabled shortcut (`src/sites.js`) → its destination; an explicit URL →
   that address; something that clearly looks like a domain (`example.com`)
   → `https://` + that address; anything else (a bare word such as
   `geoguessr`, a phrase) → a search query — never a guessed domain. Shortcut
   destinations and typed addresses go through exactly the same validation
   (`src/security/target.js`: http/https only, named host, no port or
   credentials, authorized scope, blacklist) and are redirected into
   `/p/…`. Queries go to the configured search provider (`src/search/`).

Request flow for `GET /p/https/example.com/a`:

1. `src/routes/proxy.js` parses the path, normalises the hostname and runs
   the access policy (`src/policy.js`): authorized scope (`src/allowlist.js`)
   first, then the blacklist (`src/blacklist.js`).
2. Request headers are sanitised (`src/upstream/headers.js`); the visitor's
   session jar supplies the `Cookie` header (`tough-cookie`).
3. `src/upstream/client.js` opens the connection. DNS is resolved through a
   custom `lookup` (`src/security/safe-lookup.js`) that rejects loopback,
   private, link-local, multicast and reserved addresses on **every** new
   connection — the check runs on the exact addresses the socket uses, which
   defeats DNS rebinding. TLS still verifies the certificate for the hostname.
4. The response is checked: size limit, redirect re-validation, `Set-Cookie`
   captured into the jar, dangerous headers stripped (CSP, HSTS, `Link`,
   `Alt-Svc`, `Clear-Site-Data`, …).
5. HTML is decoded (charset sniffing) and rewritten by a streaming parse5
   rewriter (`src/rewrite/html.js`); CSS by `src/rewrite/css.js`; everything
   else streams through with byte limits and timeouts.

Everything is plain JavaScript with **no native addons**, so the same
Dockerfile builds on Render (amd64) and on ARM machines alike.

## 3. Local development

Requirements: Node.js 22.12+ (24 LTS recommended), npm.

```bash
npm install
cp .env.example .env          # edit PROXY_ALLOWED_DOMAINS, ADMIN_* …
npm run dev                   # http://localhost:8080 with pretty logs (auto-reload)

npm test                      # 196 tests against local mock website + search API (no network needed)
npm run hash-password         # print an scrypt hash for ADMIN_PASSWORD_HASH
npm run lint                  # ESLint
npm run check                 # lint + test
```

`npm start` runs the server without the pretty-printer (JSON logs). In
development a random `SESSION_SECRET` is generated if you leave it empty;
in production it is required.

### Local Docker (unchanged)

`docker-compose.yml` runs the same image behind a local Caddy instance:

```bash
cp .env.example .env
docker compose up --build     # http://localhost  (Caddy on :80; with DOMAIN set, HTTPS via Let's Encrypt)
```

Web search works immediately: the app defaults to `SEARCH_PROVIDER=bing`,
one keyless HTTPS request per query to Bing's RSS result feed, the same
backend the Render deployment uses. Without Docker, `SEARCH_PROVIDER=bing
node src/server.js` is enough — then open
`http://localhost:8080/search?q=youtube`.

To run the optional self-hosted metasearch backend instead — the **official
SearXNG container image**, pinned to a dated tag, on the internal network with
no published port:

```bash
SEARXNG_SECRET=<long random string> docker compose --profile searxng up -d --build
# then in .env:  SEARCH_PROVIDER=searxng
#                SEARCH_PROVIDER_URL=http://searxng:8080
```

Nothing is built from source in either case.

Admin-added scope entries, blacklist entries and shortcuts are persisted in
the `app_data` volume (`ADMIN_STORAGE=file`, the default). Caddy is only part
of the local stack; Render provides TLS itself.

## 4. Environment variables

All configuration comes from environment variables (`.env` locally,
Render's *Environment* tab in production — `render.yaml` predefines the
non-secret ones). Sizes accept `k`/`m`/`g` suffixes; durations are seconds.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address. Render sets `PORT=10000`; the app always binds `0.0.0.0:$PORT`. |
| `NODE_ENV` | `development` | `production` enforces `SESSION_SECRET`. |
| `LOG_LEVEL` | `info` | pino log level. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from the reverse proxy (`true` on Render / docker-compose; a number = proxy hop count). |
| `CLIENT_IP_HEADER` | *(empty)* | Header set by a trusted edge with the real client IP, used for rate limiting (`true-client-ip` on Render). |
| `PROXY_ALLOWED_DOMAINS` | *(empty)* | The **authorized scope**, comma-separated, e.g. `example.com,*.example.com` — the domains you are authorized to proxy. Required: while it is empty the homepage says so and nothing can be opened. A bare `*` authorizes **every website** (an open proxy — not used by any shipped configuration, and logged as a warning at start-up); the blacklist and SSRF checks still apply. |
| `PROXY_AUTH_FLOW_HOSTS` | *(empty)* | Hosts whose **sign-in / OAuth flows** may be proxied because you run the application and control its OAuth client (§6). Same syntax as the scope (`app.example.com`, `*.corp.example`); `*` is refused. Empty = every authentication flow gets the *Sign-in required* hand-off page. |
| `PROXY_BLACKLIST` | *(empty)* | Blacklisted domains inside the scope, comma-separated, optional `\|reason`: `ads.example.com\|Not permitted,tracker.example`. |
| `PROXY_SITES` | *(empty)* | Permanent **site shortcuts**, comma-separated `shortcut=destination\|Name\|Description` (name/description optional, leading `!` = disabled): `google=https://google.com\|Google\|Google Search,yt=https://youtube.com\|YouTube`. Destinations must be inside the scope. |
| `SEARCH_PROVIDER` | `bing` | Web search backend for the homepage box: `bing` (keyless, the default), `searxng`, `brave`, `google`, `proxy`, or `none` to switch search off. The app never embeds a search engine; it calls the backend over HTTP. See §5. |
| `SEARCH_PROVIDER_URL` | *(empty)* | The backend's URL. Not needed by `bing`, which has a built-in endpoint. `searxng` = the instance's base URL (`http://searxng:8080` with docker-compose's `searxng` profile); `proxy` = a URL template containing `{q}` whose host is in the scope; `bing`/`brave`/`google` = optional endpoint override. `SEARXNG_URL` (searxng only) and `SEARCH_URL` are accepted as aliases. |
| `SEARXNG_SECRET` | *(empty)* | Only read by the optional SearXNG service in `docker-compose.yml` (`--profile searxng`, any long random string). The application never uses it. |
| `SEARCH_API_KEY` | *(empty)* | API key for `brave` / `google`. Never displayed or logged. |
| `SEARCH_ENGINE_ID` | *(empty)* | `google`: the Programmable Search Engine id (`cx`). |
| `SEARCH_TIMEOUT` | `10` | Seconds to wait for the search provider. |
| `SEARCH_RATE_LIMIT` | `60` | Searches per client IP per `RATE_LIMIT_WINDOW` (protects API quotas). |
| `PROXY_UNLISTED_URL_MODE` | `direct` | `direct`: links to unlisted domains stay direct; `proxy`: route them through the proxy (they get a "not authorized" page). |
| `PROXY_SHOW_ALLOWLIST` | `true` | Show the allowed domains on the homepage. |
| `PROXY_BANNER` | `true` | Inject the slim "viewing through AnonView" bar into proxied pages. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | *(empty = admin disabled)* | Admin login. Password ≥ 12 characters, no common words; it is hashed (scrypt) at start-up and never kept in plaintext by the app. |
| `ADMIN_PASSWORD_HASH` | *(empty)* | Preferred alternative to `ADMIN_PASSWORD`: an scrypt hash from `npm run hash-password`, so no plaintext password is stored anywhere. |
| `SESSION_SECRET` | *(required in production)* | ≥ 32 random characters; signs session cookies. Render generates it. |
| `SESSION_TTL` / `SESSION_MAX` | `1800` / `5000` | Idle lifetime and maximum number of sessions kept in memory. |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW` | `300` / `60` | Requests per client IP per window. |
| `ADMIN_RATE_LIMIT` | `10` | Login attempts per IP per window. |
| `MAX_RESPONSE_SIZE` | `20m` | Largest upstream response relayed (compressed and decoded bytes). |
| `MAX_REQUEST_SIZE` | `2m` | Largest request body accepted. |
| `REQUEST_TIMEOUT` | `30` | Seconds to wait for upstream headers / between body chunks. |
| `CONNECT_TIMEOUT` | `10` | Seconds to establish the upstream TCP/TLS connection. |
| `TRANSFER_TIMEOUT` | `300` | Hard cap on the duration of one proxied response. |
| `MAX_CONCURRENT_UPSTREAM` | `64` | In-flight upstream requests across all visitors (503 beyond). |
| `ADMIN_STORAGE` | `file` | Where admin-managed data lives: `file` = JSON under `DATA_DIR`; `memory` = RAM only (Render — ephemeral disk). `ALLOWLIST_STORAGE` is accepted as an alias. |
| `DATA_DIR` | `./data` | Directory for `allowlist.json` / `blacklist.json` / `sites.json` when `ADMIN_STORAGE=file`. |
| `DOMAIN`, `ACME_EMAIL` | *(empty)* | Local docker-compose + Caddy only. Ignored on Render. |

`.env` is git-ignored; never commit it. `.env.example` documents every key.

## 5. Authorized scope and blacklist

A request is permitted only when **all** of the following hold, checked in
this order:

```
AUTHORIZED SCOPE  →  BLACKLIST  →  SSRF / SECURITY CHECKS  →  allow
```

1. **Authorized scope** — the hostname must be on the allowlist. Matching is
   strict: `example.com` matches only `example.com`; `*.example.com` matches
   every subdomain but not the bare domain (list both for both). Entries are
   hostnames only — IP addresses, ports and paths are rejected. Anything
   outside the scope gets a “Website not authorized” page. Sources:
   `PROXY_ALLOWED_DOMAINS` (locked, shown as *environment*) plus entries added
   on the admin **Settings** page.
2. **Blacklist** — the administrator can block websites *inside* the scope.
   Those get a “Website unavailable — The administrator has blocked this
   website.” page with no further detail. The blacklist can only narrow the
   scope; it never authorizes anything.
3. **SSRF / security checks** — performed on the resolved addresses at
   connection time (see §6). These are never skipped.

**Blacklist matching rule** — an entry blocks the domain **and all of its
subdomains**, matched on whole DNS labels:

| Entry | Blocks | Does *not* block |
|---|---|---|
| `example.com` | `example.com`, `www.example.com`, `a.b.example.com` | `notexample.com`, `example.com.evil.net`, `example.org` |
| `shop.example.com` | `shop.example.com`, `eu.shop.example.com` | `example.com`, `www.example.com` |

Wildcards are not needed (and are rejected) because every entry already
covers its subdomains. Adding a domain that is already covered by a broader
entry is refused as a duplicate. Because the scope is checked first, a
blacklisted host that is *not* in the scope is reported as “not authorized”.

Links on proxied pages that point at blacklisted hosts stay routed through
the proxy, so clicking them shows the blocked page rather than leaving the
proxy. Redirects to blacklisted or unauthorized destinations are stopped.

Sources: `PROXY_BLACKLIST` in the environment (locked, format
`domain|reason,domain2`) plus entries added on the admin **Blacklist** page.

**Persistence.** With `ADMIN_STORAGE=file` (local Docker) admin changes are
saved as JSON in `DATA_DIR` and survive restarts. On Render's free plan the
filesystem is ephemeral and there is no database, so `render.yaml` sets
`ADMIN_STORAGE=memory`: changes made in the admin UI take effect immediately
but are **lost on restart or redeploy**. The Blacklist page shows an *Export
as `PROXY_BLACKLIST` value* box — copy it into the service's Environment tab
to make the list permanent (the same applies to scope additions and
`PROXY_ALLOWED_DOMAINS`). No password is ever stored: the admin password is
kept only as an scrypt hash.

* In the default `PROXY_UNLISTED_URL_MODE=direct`, links and assets on a
  proxied page that point to domains *outside the scope* are left as direct
  links (your browser would contact those sites directly if you follow them).
  Set `proxy` to have them blocked instead.

### Site shortcuts (the site directory)

A shortcut is a name visitors can type instead of an address:

```
google     →  https://google.com/      (configured by the administrator)
youtube    →  https://youtube.com/
wikipedia  →  https://wikipedia.org/
```

Shortcuts are **not** built in — nothing is reachable by name until the
administrator creates it, on the admin **Sites** page or in `PROXY_SITES`.
A shortcut is a convenience, never an authorization:

* Every destination is validated **when it is saved** with exactly the rules
  a typed address gets: `http`/`https` only, a domain name (never an IP
  literal, `localhost`, a private/special-use name, a port or credentials),
  inside the authorized scope and not blacklisted. `google → http://127.0.0.1`,
  `google → http://localhost`, a private address or a domain outside the scope
  are all refused with a clear message.
* It is validated **again every time it is used** — scope, blacklist, then the
  SSRF address checks at connection time and redirect re-validation, like any
  other request. If a destination is blacklisted or de-authorized later, the
  Sites page flags it (*Blacklisted* / *Not authorized*), it disappears from
  the homepage and the suggestions, and using it shows the usual blocked /
  not-authorized page.
* Shortcut names are 1–32 characters — letters, digits, `-` and `_` (no dots,
  so a shortcut can never be confused with a domain) — matched
  **case-insensitively**: `Google`, `google` and `GOOGLE` are the same
  shortcut. Duplicates are refused.
* Entries can be enabled/disabled; a disabled shortcut is simply not a
  shortcut (the word is searched for instead). `PROXY_SITES` entries are
  locked (edit the environment); admin-created ones are editable.

How the box decides what you meant (`src/resolve.js`), in this fixed order:

| Priority | You type | Treated as |
|---|---|---|
| A | `google` — exactly a configured, enabled shortcut (case-insensitive) | the shortcut's destination, validated |
| B | `https://example.com/x`, `http://…`, `//host/x` | that explicit address, validated |
| C | `example.com`, `example.co.uk`, `sub.example.com/x` — clearly a domain (a valid hostname with an alphabetic top-level label) | `https://` + the address, validated |
| — | `127.0.0.1`, `[::1]`, `localhost:3000`, `example.com:8080` | an address the proxy refuses — you get the explanation, not a search |
| D | `geoguessr`, `randomword`, `weather today`, `GCSE physics`, `e.g`, `v1.2`, a disabled shortcut | a web search |

A bare word is **never** turned into a domain: `geoguessr` is a search, not
`geoguessr.com`, and can never produce the "Website not authorized" page.
Only a configured shortcut opens a site by name.

### Web search

Anything that is not a shortcut or an address is a **search query**:

```
Browser → proxy web app → search backend (HTTP/JSON) → proxy's own results page
```

The proxy **contains no search engine**. `src/search/index.js` is an adapter
layer: the application only knows the `SearchProvider` interface
(`search(query, { page })` → normalized `{ results: [{ title, url, snippet,
domain }], hasNext, total, related }`) and talks to whatever backend
`SEARCH_PROVIDER` selects, over HTTP.

The default is **`bing`**, which needs no account, no API key and no service
of your own — see *Choosing a backend* below for why that is the one that
works on a free instance.

Two states that look alike are deliberately kept apart:

* **"Web search isn't set up yet"** — only with `SEARCH_PROVIDER=none`. The
  feature is switched off; shortcuts and addresses keep working.
* **"Search is temporarily unavailable"** — a provider *is* selected but the
  query failed: the backend is unreachable, rate-limiting, slow, or one of
  its settings is missing. A missing setting never disables the feature and
  never stops the process; it is named in the start-up log, in `/health`
  (`search.configured: false`), on `/admin/search` and, for signed-in
  administrators, on the results page. Only a *malformed* value (unknown
  provider, a URL that is not http(s), a `proxy` template without `{q}`)
  stops start-up.

| `SEARCH_PROVIDER` | What it does | Settings |
|---|---|---|
| `bing` | **The default.** Reads Bing's RSS result feed (`?q=…&format=rss`) over plain HTTPS and renders the results page. Keyless — no account, no quota to manage, ~4 KB per query. The feed serves one page of ten results and ignores paging parameters, so the results page offers no *next page*. | — (optional `SEARCH_PROVIDER_URL` endpoint override) |
| `none` | Search off. Shortcuts and addresses still work. | — |
| `searxng` | Queries a [SearXNG](https://docs.searxng.org/) instance's JSON API and renders the results page. Any instance works if `json` is listed under `search.formats` in its `settings.yml`. | `SEARCH_PROVIDER_URL` = its base URL |
| `brave` | [Brave Search API](https://brave.com/search/api/) web results. | `SEARCH_API_KEY` |
| `google` | [Google Programmable Search JSON API](https://developers.google.com/custom-search/v1/overview). | `SEARCH_API_KEY`, `SEARCH_ENGINE_ID` (the engine's `cx`) |
| `proxy` | No API: the query is opened on a search **website** through the proxy itself, like any other page (Startpage-style). The website's host must be in the authorized scope and its terms apply. | `SEARCH_PROVIDER_URL` = template with `{q}`, e.g. `https://duckduckgo.com/html/?q={q}` |

**Choosing a backend**

`bing` is the default because it is the only backend that needs nothing and
is actually reachable from a free Render instance. Measured from the deployed
service (§11): `www.bing.com` answers, while `html.duckduckgo.com` and
`www.mojeek.com` never complete a TCP connection from Render's address range,
and every public SearXNG instance now sits behind a browser/bot challenge
that returns an HTML page instead of JSON. `api.search.brave.com` and
`www.googleapis.com` are reachable but want an API key.

Use one of the others when you have a reason to:

* **`searxng` — your own metasearch instance.** `docker-compose.yml` can run
  the official `docker.io/searxng/searxng` image, pinned to a dated tag, as
  the optional `searxng` service on the internal network with **no published
  port** and `deploy/searxng/settings.yml` mounted read-only (JSON API on,
  limiter off, moderate safe search, `public_instance: false`):

  ```bash
  SEARXNG_SECRET=<long random string> docker compose --profile searxng up -d
  # then in .env:  SEARCH_PROVIDER=searxng
  #                SEARCH_PROVIDER_URL=http://searxng:8080
  ```

  Nothing is built from source and the app image never contains SearXNG. On
  Render the free plan has **no private services**, so such an instance has
  to live somewhere else (a paid Render private service, another host, your
  own machine) — see §11.
* **`brave` / `google` — an official API** with a quota you control.
* **`proxy` — no results page at all:** the query is opened on a search
  website through the proxy, so that site's own page is what the visitor
  sees. Its host must be inside `PROXY_ALLOWED_DOMAINS`.

`/admin/search` (administrators only) shows which provider is configured,
whether its URL and key are set, and the result of one live query against the
backend — without printing any of those values. `/health/search` is the same
information as JSON.

On the built-in results page nothing is proxied automatically: every result
links to `/open?url=…` on the proxy's own origin, so a click runs the normal
chain — authorized scope → blacklist → SSRF checks at connection time — and
either opens the page through the proxy or shows the secure *Website not
authorized* / *Website unavailable* page. The badge next to each result
(*via proxy*, *not authorized*, *blocked*) only predicts that outcome from
the current policy. Results never link out directly. Titles and snippets are
reduced to plain text.
The API providers are called with a plain `fetch()` (the endpoint is
operator configuration, like a database URL, so it may be a private
address); the visitor's query only ever travels URL-encoded in the query
string. Searches have their own per-IP limit (`SEARCH_RATE_LIMIT`) so a
visitor cannot burn through an API quota, and a timeout (`SEARCH_TIMEOUT`).
Provider errors show a generic "search unavailable" page; details go to the
log only. API keys never appear in pages or logs.

## 6. Security model

**Not an open proxy / SSRF surface**

* Only `http:` and `https:` targets; only the scheme's default port (80/443) —
  user-supplied ports and embedded credentials are rejected.
* Hostnames must be on the allowlist; IP literals in any form (dotted,
  decimal, hex, IPv6, IPv4-mapped IPv6) and special-use names (`localhost`,
  `*.local`, `*.internal`, `*.lan`, `*.arpa`, `*.onion`, …) are always refused.
* DNS results are validated inside the socket's `lookup` hook on every new
  connection (DNS-rebinding protection). Blocked: `0.0.0.0/8`, `10/8`,
  `100.64/10`, `127/8`, `169.254/16` (cloud metadata), `172.16/12`,
  `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`,
  `198.51.100/24`, `203.0.113/24`, multicast, `240/4`; IPv6 `::`, `::1`,
  `::/96`, IPv4-mapped and NAT64 forms of the above, `64:ff9b:1::/48`,
  `100::/64`, Teredo, 6to4, documentation/benchmark/ORCHID ranges,
  `fc00::/7`, `fe80::/10`, `fec0::/10`, multicast, `3fff::/20`, `5f00::/16`.
  A host whose answer mixes public and private addresses is refused entirely.
* Redirects (`Location`) are resolved and re-validated; redirects to unlisted
  or private destinations are stopped with an explanatory page.
* Shortcuts cannot weaken any of this: a destination is validated with the
  same rules when an administrator saves it *and* on every use, so a
  shortcut can never resolve to `127.0.0.1`, `localhost`, a private address,
  a port, or a domain outside the scope, and the SSRF, redirect, rate and
  size limits apply to the resulting request exactly as to a typed one.
  Only administrator-configured, enabled, currently-usable shortcuts are
  ever exposed by the homepage and `/suggest`.
* Web search is selected by `SEARCH_PROVIDER`, rate-limited per client
  separately from the proxy, uses published result formats (Bing's RSS feed,
  the SearXNG/Brave/Google JSON APIs) or the proxy itself, reduces results
  to plain text and http(s) URLs, and never links out: every result opens
  through `/open`, i.e. through the same authorization → blacklist → SSRF
  chain as a typed address. A bare word typed into the box is a search, never
  a guessed domain.
* Connect, header, idle and total-transfer timeouts; maximum response and
  request sizes; a cap on concurrent upstream requests; per-IP rate limiting
  (stricter for admin login), keyed on Render's `True-Client-IP` header so a
  spoofed `X-Forwarded-For` cannot open a fresh bucket.

**Sign-in and OAuth flows**

A proxied page is served from the proxy's origin, not the application's. An
OAuth 2.0 / OIDC authorization request is bound to exactly that origin and to
the redirect URIs registered for the OAuth client, so the provider refuses it —
Google answers `403 origin_mismatch`. The only ways to make it succeed would be
to forge the origin or rewrite the OAuth parameters, i.e. to defeat a control
that protects the visitor's account. **AnonView does neither.** It stops the
request *before* the provider is contacted and hands the visitor off to their
own browser: a *Sign-in required* page (`src/security/auth-flow.js`,
`src/views/error.js`) whose **Continue to sign in** button opens the
provider's real website in a new tab, outside the proxy, where the flow works
normally. The HTTP status stays `501` — the proxy genuinely will not
implement this hop — but the page reads as a hand-off, not a failure.

**What the hand-off link is, and what it is not.** It is an ordinary
`<a href>` to a **bare origin** — `https://appleid.apple.com/`,
`https://accounts.google.com/` — opened with `target="_blank"`,
`rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`, so
nothing about the proxy session travels with it. For an application's *own*
sign-in route (`/auth/google`) the path is kept, because that route is exactly
what starts the flow normally. Everything else is dropped:

* no `client_id`, `redirect_uri`, `response_type`, `scope`, `state`, `nonce`,
  `code_challenge`, `code` or token is ever copied into a link, a page or a log;
* no redirect URI is invented, and the provider is never asked to send anyone
  back to the proxy;
* the page renderer refuses outright to emit a hand-off `href` that has a query
  string or a fragment at all, whatever produced it.

An interrupted authorization request cannot be replayed from the hand-off page
anyway, and pretending otherwise would be dishonest: the application's session
cookie lives in **this proxy's** server-side jar, not in the visitor's browser.
So for an authorization request or a callback the button points at the
application's (or provider's) origin and the flow is simply started again
there, the normal way.

**The return destination.** When the visitor came from a proxied page, that
page is offered as a second link — origin and path only, query string
dropped — so they can pick up where they left off. It is a plain link shown
to the visitor; it is never turned into a redirect URI and never handed to the
provider.

* **Nothing is intercepted.** No password, authorization code, access or
  refresh token, client secret or authentication cookie is captured, logged,
  modified or stored, and there is no code that could do so. A refused flow
  never leaves the proxy at all. Query strings are never logged (proxied URLs
  appear as `/p/https/host/…`), and a destination that has to be named on a
  page — a stopped redirect — has its query values redacted first.
* **Ordinary logins still work.** Detection is conservative: a bare `/login`,
  `/signin` or `/accounts` page is proxied as usual, and a username/password
  form POST is relayed byte for byte, unread. A request is treated as
  authentication only when it carries OAuth material (`access_token`,
  `id_token`, `refresh_token`, `SAMLResponse`, a `code`+`state` pair that
  really looks like OAuth), looks like an authorization request (`client_id`
  with `response_type`/`redirect_uri`/`scope`/`code_challenge`), is hosted on a
  dedicated identity provider (`accounts.google.com`,
  `login.microsoftonline.com`, an Auth0/Okta tenant …), or sits on an
  unmistakable endpoint (`/oauth/…`, `/o/oauth2/…`, `/connect/authorize`,
  `/protocol/openid-connect/…`, `/signin-oidc`, `/saml/…`, `/auth/google`).
* **The authorization boundary comes first.** Scope and blacklist are checked
  before any of this, so an identity provider outside the authorized scope is
  simply "not authorized" as before.
* **Only the sign-in step is handed over.** Everything else about the website
  — pages, assets, redirects, cookies, ordinary form posts — keeps going
  through the proxy exactly as before.

**If you own the application and its OAuth client**

Only for applications *you* run. Never change, and never assume anything about,
a third party's OAuth configuration.

1. In your own OAuth client, register the origin this proxy is served from and
   the redirect URI the flow will actually come back to. For a Render
   deployment the origin is `https://<your-service>.onrender.com`, and a
   proxied callback URL has the form
   `https://<your-service>.onrender.com/p/https/<your-app-host>/<callback path>`.
2. Then list those application hosts in `PROXY_AUTH_FLOW_HOSTS`
   (`app.example.com`, `*.corp.example`). Their sign-in pages are proxied like
   any other page; the proxy still forges nothing and the provider still
   applies every one of its own checks, so an unregistered origin or redirect
   URI keeps failing at the provider, as it should.
3. Sign-in traffic for those hosts then passes through your proxy. It is never
   logged or stored, but only enable it for applications you are responsible
   for.

**Google OAuth specifically** (Google Cloud console → *APIs & Services* →
*Credentials* → your OAuth 2.0 Client ID):

* **Authorized JavaScript origins** must match the actual origin the
  application is served from — scheme, host and port only, no path and no
  trailing slash (`https://your-service.onrender.com`). A mismatch is exactly
  what produces `403 origin_mismatch`.
* **Authorized redirect URIs** must match the redirect URI *exactly*, as a
  full URL including scheme, host, port and path. Google does not accept
  wildcards, and a trailing slash or a different path is a different URI.
* Both lists belong to *your* client ID. A client ID you do not own cannot be
  made to accept this proxy's origin, and AnonView will not pretend otherwise.

**Between visitor and proxy**

* Upstream cookies never reach the browser; they live in a signed, HttpOnly,
  SameSite, `Secure` (over HTTPS) session on the server and expire. The jar is
  in memory only for the session's lifetime (`SESSION_TTL`), is never written
  to disk, never logged and never shown; nothing inspects it for credentials.
* `Cookie`, `Authorization`, `X-Forwarded-*`, `Sec-Fetch-*`, CDN headers and
  other client-identifying headers are never forwarded upstream; `Referer` and
  `Origin` are rewritten to their upstream form; a `Via` header identifies the
  proxy honestly. Your IP is not sent to the website.
* Upstream `Content-Security-Policy`, `Strict-Transport-Security`,
  `Set-Cookie`, `Link`, `Alt-Svc`, `Clear-Site-Data`, `Cross-Origin-*`,
  `Service-Worker-Allowed` and similar headers are stripped so a website
  cannot apply policies to the proxy's origin; service-worker registration is
  disabled by the shim. Proxied pages get `Referrer-Policy: same-origin` and
  `X-Robots-Tag: noindex`.
* The proxy's own pages carry a strict CSP and Helmet's security headers; the
  app sends `Strict-Transport-Security` on every HTTPS response.
* Admin: scrypt-hashed password verified in constant time, signed
  `SameSite=Strict` session cookie, CSRF tokens on every state change (form
  field or `x-csrf-token` header for the JSON API), login rate limiting,
  `no-store`. The API returns 401 without a session and 403 without a valid
  token; environment-defined entries cannot be deleted through it.
* Errors shown to users are generic; details, stack traces and resolved
  addresses go to the server log only. Logs never contain cookies,
  authorization headers, request bodies or query strings (proxied URLs are
  logged as `/p/https/host/…`), and pino redaction is configured as a
  second line of defence.
* Container: non-root user (uid 1000), production-only dependencies, memory
  cap sized for Render's free instance; no secrets in the image or repo.

See `test/ssrf.test.js`, `test/blacklist.test.js`, `test/sites.test.js`,
`test/search.test.js`, `test/auth-flow.test.js`, `test/routing.test.js` and
`test/render.test.js` for
the executable version of these guarantees.

### Admin area

Sign in at `/admin/login` (the *Admin* link appears in the navigation once you
are signed in). Sections:

* **Dashboard** — number of shortcuts and blacklisted domains, size of the
  authorized scope, proxy health, uptime, service statistics, the search
  provider in use and the recent configuration changes made through the UI.
* **Sites** — the shortcut directory: create entries (name, shortcut,
  destination, optional description), edit them, enable/disable, delete with
  a confirmation dialog, search/filter the table (name, shortcut, domain,
  description), see each destination and whether it is currently
  *Blacklisted* or *Not authorized*, and export the directory as a
  `PROXY_SITES` value. Duplicate shortcuts are refused; every destination is
  validated before it is saved.
* **Blacklist** — add a domain with an optional reason, search/filter the
  table (domain or reason), see when each entry was added, delete with a
  confirmation dialog, export the list as a `PROXY_BLACKLIST` value.
* **Settings** — manage the authorized scope and view the running
  configuration (read-only; values come from the environment; API keys are
  shown only as "set").

JSON API (same session cookie, plus `x-csrf-token` taken from the page):

```
GET    /admin/blacklist            Accept: application/json  → { entries, total, persistent }
POST   /admin/blacklist            { "domain": "ads.example.com", "reason": "Not permitted" } → 201 { entry }
DELETE /admin/blacklist/:id        → 200 { ok, entry } | 404 | 403 (environment entry)

GET    /admin/sites                Accept: application/json  → { entries, total, enabled, persistent }
POST   /admin/sites                { "name": "Google", "shortcut": "google", "destination": "https://google.com",
                                     "description": "Google Search", "enabled": true } → 201 { entry }
                                   400 INVALID_SHORTCUT | INVALID_DESTINATION | DESTINATION_NOT_AUTHORIZED |
                                       DESTINATION_BLACKLISTED, 409 DUPLICATE
PATCH  /admin/sites/:id            any subset of the fields above (PUT is accepted too) → 200 { entry }
DELETE /admin/sites/:id            → 200 { ok, entry } | 404 | 403 (environment entry)
```

Public, unauthenticated endpoints used by the search box:

```
GET /search?q=<input>[&page=N][&mode=search]   shortcut/address → 302 into the proxy; query → results page
GET /open?url=<input>                           "open this": a shortcut or an address → 302 into the proxy (or the
                                                403 page); a bare word is an invalid address here — never a search,
                                                never a guessed domain. Used by result links and the About page.
GET /suggest?q=<prefix>                         → { query, sites: [{ name, shortcut, host, description }], search }
```

## 7. Deploying to Render

Render builds the Dockerfile from your Git repository and runs it as a web
service with a public HTTPS URL. The whole setup is described in
[`render.yaml`](render.yaml) (a Render *Blueprint*); you only enter the
secret values.

### 7.1 Create a Render account

Go to <https://render.com>, click **Get Started** and sign up (GitHub or
GitLab login is easiest — it also grants repository access). No credit card
is required for the free plan.

### 7.2 Connect the Git repository

Push this project to a repository on GitHub or GitLab:

```bash
git remote add origin git@github.com:<you>/anonview-proxy.git
git push -u origin main
```

In Render, the first time you create a service you will be asked to install
the Render GitHub/GitLab app and grant access to the repository.

### 7.3 Create the web service

Recommended — **Blueprint** (uses `render.yaml`, nothing to type by hand):

1. Dashboard → **New +** → **Blueprint**.
2. Select the repository and branch (`main`). Render detects `render.yaml`
   and shows the `anonview-proxy` web service it will create.
3. Fill in the prompted values (see 7.5) and click **Apply**.

Alternative — manual **Web Service** (if you prefer not to use Blueprints):
**New +** → **Web Service** → pick the repository → *Language*: **Docker**
→ *Dockerfile path*: `./Dockerfile` → *Health Check Path*: `/health` →
add the environment variables from 7.5 → **Create Web Service**.

### 7.4 Select the free plan

`render.yaml` already sets `plan: free`. In the manual flow choose
**Free** under *Instance Type*. See §11 for what the free plan implies.

### 7.5 Set environment variables

Render's *Environment* tab (or the Blueprint prompt) is where all secrets
live — none are committed. `render.yaml` predefines safe defaults for the
non-secret variables and marks these for you to enter:

| Variable | What to enter |
|---|---|
| `PROXY_ALLOWED_DOMAINS` | **Required.** The comma-separated list of domains you are authorized to proxy, e.g. `example.com,*.example.com,docs.example.org` (`*.` covers subdomains only — list the bare domain too). Do not enter `*`: that authorizes every website. While it is empty the service starts, stays healthy and opens nothing, and the homepage says so |
| `ADMIN_USERNAME` | Your admin login name, e.g. `admin` |
| `ADMIN_PASSWORD` | A strong password, **at least 12 characters**, not containing "password"/"admin"/"changeme" |
| `SESSION_SECRET` | Leave it to Render — the Blueprint has `generateValue: true`, which creates a random 256-bit value that persists across deploys. (Manual flow: click *Generate* or paste `openssl rand -hex 32`.) |

Predefined by `render.yaml` (change in the *Environment* tab if needed):
`NODE_ENV=production`, `PORT=10000`, `HOST=0.0.0.0`, `TRUST_PROXY=true`,
`CLIENT_IP_HEADER=true-client-ip`, `ADMIN_STORAGE=memory`,
`LOG_LEVEL=info`, `RATE_LIMIT=300`, `RATE_LIMIT_WINDOW=60`,
`ADMIN_RATE_LIMIT=10`, `MAX_RESPONSE_SIZE=20m`, `MAX_REQUEST_SIZE=2m`,
`REQUEST_TIMEOUT=30`, `CONNECT_TIMEOUT=10`, `TRANSFER_TIMEOUT=300`,
`MAX_CONCURRENT_UPSTREAM=32`, `PROXY_UNLISTED_URL_MODE=direct`,
`PROXY_SHOW_ALLOWLIST=true`, `PROXY_BANNER=true`, `SEARCH_PROVIDER=bing`,
`SEARCH_TIMEOUT=10`, `SEARCH_RATE_LIMIT=60`.

Optional variables you can add in the *Environment* tab:

* `PROXY_SITES` — permanent site shortcuts (format
  `shortcut=destination|Name|Description,…`; the admin *Sites* page exports
  this value). Their domains must also be in `PROXY_ALLOWED_DOMAINS`.
* `PROXY_BLACKLIST` — permanent blacklist entries, format
  `domain|reason,domain2`.
* Web search needs **nothing added**: `render.yaml` already sets
  `SEARCH_PROVIDER=bing`, which takes no URL and no key. To use a different
  backend, override it here: `SEARCH_PROVIDER=searxng` +
  `SEARCH_PROVIDER_URL=https://<your-searxng>/`, or `brave` / `google` with
  `SEARCH_API_KEY` (+ `SEARCH_ENGINE_ID`), or `proxy` with a `{q}` template
  whose host is in the scope (§5 and §11). `SEARCH_PROVIDER=none` switches
  web search off. Keep API keys in the Environment tab only, never in git.
* `ADMIN_PASSWORD_HASH` — use it instead of `ADMIN_PASSWORD`; generate with
  `npm run hash-password`.

Changing any variable triggers an automatic redeploy.

### 7.6 Deploy

Click **Apply** (Blueprint) or **Create Web Service**. Render clones the
repository, builds the Dockerfile (2–4 minutes the first time), starts the
container and polls `/health` until it answers `200`; only then does traffic
switch to the new instance. Every later `git push` to `main` deploys
automatically (`autoDeployTrigger: commit`); you can also click **Manual
Deploy**.

### 7.7 Find the Render URL

The service page shows the public URL at the top-left:

```
https://anonview-proxy.onrender.com
```

(If the name is already taken by someone else Render appends a random
suffix, e.g. `https://anonview-proxy-x7k2.onrender.com`.) Open it — the
homepage, `/health` and `/admin` are live immediately.

### 7.8 Add a custom domain

See §8.

### 7.9 HTTPS/TLS

Automatic — see §8.

### 7.10 Viewing logs

See §9.

### 7.11 Restarting/redeploying

See §10.

### 7.12 Free-tier limitations and 7.13 spin-down

See §11.

## 8. Custom domain and HTTPS

* Every Render web service gets an `https://<name>.onrender.com` URL with a
  Render-managed TLS certificate; plain `http://` requests are redirected to
  HTTPS. Nothing to configure.
* Custom domain: service → **Settings** → **Custom Domains** → **Add Custom
  Domain** → enter `proxy.example.com`. Render shows the DNS record to
  create at your registrar (a `CNAME` to `<name>.onrender.com` for
  subdomains, or `A`/`ALIAS` records for a root domain). Once DNS
  propagates, Render issues and renews a Let's Encrypt certificate
  automatically — TLS 1.2+/1.3, HTTP/2 and HTTP→HTTPS redirects included.
* The app itself only speaks HTTP to Render's edge, trusts Render's
  `X-Forwarded-Proto` (`TRUST_PROXY=true`) to mark cookies `Secure` and adds
  `Strict-Transport-Security` on HTTPS responses.

## 9. Viewing logs

Service → **Logs** tab: live, searchable stdout/stderr of the container
(JSON lines from pino). Filter for `"status":5` to spot upstream failures or
`"level":40` for warnings. Log lines contain method, path (query stripped,
proxied URLs as `/p/https/host/…`), status, duration and client IP — never
cookies, tokens or bodies. Render keeps recent logs for free services
(longer retention and log streaming are paid features).

Deploy/build output is under **Events** → the deploy → **Logs**.

## 10. Restarting and redeploying

* **Restart**: service → **Manual Deploy** → **Restart service** (keeps the
  current image; takes ~30 s).
* **Which build is live?** `GET /health` returns `commit` (the short
  `RENDER_GIT_COMMIT` Render injects into the deploy) next to `version`. If it
  is not the commit you pushed, the deploy did not reach production — see the
  *Deploy cancelled* row in §12.
* **Redeploy the same commit**: **Manual Deploy** → **Deploy latest commit**
  (rebuilds; use **Clear build cache & deploy** if the build looks stale).
* **Deploy new code**: `git push` to `main` — Render builds, health-checks
  `/health` and switches traffic with zero downtime.
* On restart/redeploy Render sends `SIGTERM`; the app finishes in-flight
  responses and exits within 10 seconds (`src/server.js`;
  `maxShutdownDelaySeconds` is not supported on the free plan and is not
  used). Being stateless, it
  needs nothing else: configuration comes from the environment, sessions
  are ephemeral by design, and `SESSION_SECRET` is preserved by Render so
  existing cookies stay valid.

## 11. Render free-tier limitations

* **Spin-down after inactivity:** a free web service is suspended after
  **15 minutes without inbound traffic**. The next request wakes it, which
  takes **up to ~a minute** (Docker image start + health check). Render's
  own health checks do not keep it awake. If that delay is unacceptable,
  upgrade to the Starter plan (always on).
* **Hours:** 750 free instance hours per month across all free services —
  enough for one service running continuously, but a second free service
  would share the budget.
* **Resources:** 512 MB RAM, 0.1 shared CPU. The image is tuned for this
  (`NODE_OPTIONS=--max-old-space-size=384`, `MAX_CONCURRENT_UPSTREAM=32`).
  Very large proxied downloads are streamed, so memory stays flat.
* **Web search works, but not by hosting a search engine here.** Render's
  free instance types exist only for web services, static sites, Postgres
  and Key Value — **there are no free private services**, so a SearXNG
  instance cannot be deployed privately next to the proxy, and a second
  *free* web service would be public and unauthenticated. Running SearXNG
  inside the proxy's own container is not a reliable answer either: one
  shared 0.1 CPU (10 % of a core) and 512 MB have to cover Node's HTML
  rewriting *and* a Python metasearch engine that fans a query out to a
  dozen engines and parses every answer; searches would take tens of
  seconds, and an out-of-memory kill would take down the proxy itself, not
  just search.

  The free deployment therefore **calls a backend instead of hosting one**,
  and ships with `SEARCH_PROVIDER=bing` — one HTTPS request per query to
  Bing's RSS feed, ~4 KB back, no key, no second service. Which backends are
  reachable from a Render instance is not a matter of taste; measured from
  the deployed service:

  | Backend | From a Render free instance |
  |---|---|
  | `www.bing.com` (RSS) | 200, ten results |
  | `api.search.brave.com`, `www.googleapis.com` | reachable, API key required |
  | `html.duckduckgo.com`, `www.mojeek.com` | TCP connection never completes (10 s timeout) |
  | public SearXNG instances | bot challenge instead of JSON |

  Use `SEARCH_PROVIDER=none` to switch web search off; shortcuts, addresses
  and the rest of the proxy are unaffected either way.
* **Ephemeral filesystem:** anything written to disk is lost on restart or
  redeploy, and persistent disks are not available on the free plan —
  hence `ADMIN_STORAGE=memory` and env-var driven configuration (export the
  blacklist from the admin page into `PROXY_BLACKLIST` to keep it).
* **Bandwidth:** 100 GB/month outbound included; free services are
  suspended for the rest of the month if exceeded.
* **Build minutes:** 500 pipeline minutes/month; each deploy of this image
  uses about 1–2 (one `npm ci` on top of the Node base image).
* **No shell access** on free instances; use the logs and `/health`.
* Cold starts and shared CPU mean a heavy page can take a few seconds the
  first time. Keep the allowlist small and treat the service as personal.

## 12. Troubleshooting

| Symptom | What to check |
|---|---|
| Build fails on Render | Events → deploy logs. The build only needs `package.json`, `package-lock.json` and `src/` to be committed, and network access for `npm ci` (about 1–2 min). |
| Events show `Deploy cancelled` (and the logs show `signal: SIGTERM, shutting down`) | Two deploys were triggered close together and Render cancelled the older one — typically a code push *and* a Blueprint env-var sync from the same `git push`, or someone pressing **Cancel**. Nothing crashed: `signal: SIGTERM, shutting down` is this app's own graceful-shutdown line, logged whenever Render replaces or spins down the instance. The service keeps serving the **previous** image, so check `/health` → `commit`; if it is not your commit, run **Manual Deploy → Deploy latest commit** once no other deploy is in progress. |
| The site is up but behaves like the old code | An env-var change restarts the service from the *last successful build*, so a cancelled or failed build leaves the previous image running. Compare `/health` → `commit` with `git rev-parse --short HEAD`, then redeploy. |
| Deploy stuck on "health check" | Logs tab. Common cause: a configuration error printed at start-up (`SESSION_SECRET` missing, `ADMIN_PASSWORD` shorter than 12 chars or containing a common word, invalid `PROXY_ALLOWED_DOMAINS` entry such as an IP or a port). Fix the variable → Render redeploys. |
| `/admin` returns 404 | `ADMIN_USERNAME` and `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`) must be set. |
| A blacklisted site still opens | Check the scope/blacklist order: only hosts inside the scope reach the blacklist; entries cover subdomains, so `example.com` also blocks `www.example.com`. |
| A domain added in `/admin` disappeared | Expected on Render (`ADMIN_STORAGE=memory`); export it to `PROXY_BLACKLIST` / `PROXY_ALLOWED_DOMAINS` (shortcuts: `PROXY_SITES`). |
| Typing `google` searches instead of opening the site | No enabled shortcut named `google` exists (or its destination is blacklisted / outside the scope — see the status column on the *Sites* page). |
| "Web search isn't set up yet" | Shown **only** when `SEARCH_PROVIDER=none`. Set `SEARCH_PROVIDER=bing` (nothing else needed) or one of the other backends in §5. |
| "Search is temporarily unavailable" | A provider is selected and the query failed. Open `/admin/search` as an administrator: it says whether the configuration is complete and runs a live connectivity test. Logs show `search provider unreachable` / `search provider error` with the host and HTTP status: wrong `SEARCH_PROVIDER_URL` or API key, a SearXNG instance without `json` in `search.formats`, quota exhausted (429), or a timeout (`SEARCH_TIMEOUT`). `proxy` mode needs the search website's host in `PROXY_ALLOWED_DOMAINS`. |
| Start-up fails mentioning `PROXY_SITES` | An entry is malformed (`shortcut=destination`), has an invalid shortcut (letters, digits, `-`, `_` only), a duplicate shortcut, or an invalid destination (IP, port, credentials, non-http scheme). Out-of-scope destinations only log a warning. |
| First request after a pause is slow | Free-tier spin-down (§11). |
| Website not authorized | Add the domain (and its subdomains with `*.`) to `PROXY_ALLOWED_DOMAINS` — only domains you are authorized to proxy. An empty scope authorizes nothing and is reported on the homepage. |
| Google shows `403 origin_mismatch`, or a site's "Sign in with …" button fails | Expected: an identity provider validates the application's own origin, which a proxy cannot satisfy without forging it. The proxy stops such flows first and shows *Sign-in required* with a **Continue to sign in** button that opens the provider directly. If you run the application and its OAuth client, see §6 and `PROXY_AUTH_FLOW_HOSTS`. |
| *Sign-in required* on an ordinary page | Detection needs OAuth material, an authorization-request shape, an identity-provider host or an OAuth endpoint path — check whether the URL carries `client_id`/`code`/`access_token` or sits under `/oauth/…`. For an application you run yourself, list its host in `PROXY_AUTH_FLOW_HOSTS`. |
| Signed in with the button, but the proxied site still shows me as logged out | Expected. The sign-in happened in your own browser against the provider's site; the proxy keeps its own separate cookie jar per visitor. Continue in the tab that opened, or use the site directly for anything behind the login. |
| A page looks broken | Its assets may come from an unlisted CDN (allow it) or it relies on WebSockets/service workers (unsupported). |
| `503 The proxy is busy` | `MAX_CONCURRENT_UPSTREAM` reached — raise it or check for a slow upstream. |
| `429 Too many requests` for a legitimate user | Raise `RATE_LIMIT`; on Render the limiter keys on `True-Client-IP`. |
| Out-of-memory restarts | Lower `MAX_RESPONSE_SIZE`/`MAX_CONCURRENT_UPSTREAM`, or move to a larger instance. |

Local checks: `npm run check`, then `PORT=10000 NODE_ENV=production
SESSION_SECRET=<32+ chars> PROXY_ALLOWED_DOMAINS=example.com npm start` and
`curl http://127.0.0.1:10000/health`.

## 13. Project structure

```
proxy/
├── src/
│   ├── server.js            entry point (env loading, graceful shutdown on SIGTERM)
│   ├── app.js               Fastify app factory, error handler, 404/referer fallback, HSTS
│   ├── config.js            environment parsing & validation
│   ├── policy.js            access policy: authorized scope → blacklist
│   ├── allowlist.js         authorized scope (env + admin, file or memory storage)
│   ├── blacklist.js         blacklist (env + admin, subdomain matching, export)
│   ├── sites.js             site directory: shortcuts (env + admin), validated destinations, suggestions, export
│   ├── resolve.js           search-box input → shortcut | address | search query
│   ├── search/index.js      SEARCH_PROVIDER adapters (bing, searxng, brave, google, proxy), result sanitising/linking
│   ├── store.js             atomic JSON persistence / memory mode
│   ├── audit.js             recent configuration changes (in memory)
│   ├── sessions.js          in-memory sessions with cookie jars (TTL, LRU)
│   ├── security/            address policy, hostname rules, safe DNS lookup, target parsing, sign-in/OAuth detection, scrypt passwords
│   ├── tools/               hash-password CLI
│   ├── upstream/            HTTP client, header hygiene, decompression, byte limits
│   ├── rewrite/             URL/srcset, CSS, charset handling, streaming HTML rewriter
│   ├── routes/              site pages (/, /search, /open, /suggest, /about), proxy endpoint, admin, referer fallback
│   ├── views/               HTML templates: home, search box + results, about, errors, admin (dashboard, sites, blacklist, settings, login)
│   └── public/              style.css (design system, light/dark), theme.js, app.js (suggestions combobox), admin.js, favicon, shim.js
├── test/                    node:test suites + local mock website and mock search API (helpers/)
├── Dockerfile               multi-stage Node image (app only), non-root, honours $PORT
├── render.yaml              Render Blueprint (free Docker web service, /health check)
├── docker-compose.yml       local stack: app + Caddy (+ optional official SearXNG image, profile `searxng`)
├── deploy/caddy/Caddyfile   Caddy config for the local stack only
├── deploy/searxng/settings.yml  settings mounted into the official SearXNG container (JSON API, no limiter)
└── .env.example             application settings template
```

There is no longer any Oracle Cloud / Terraform code in this repository;
the local Docker stack and `render.yaml` are the only deployment targets.
