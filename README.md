# AnonView — an allowlisted “Anonymous View” web proxy

AnonView is a small, production-grade web proxy in the spirit of Startpage's
*Anonymous View*: you type a web address, the **server** fetches the page and
shows it to you, so the website sees the proxy's IP address instead of yours.
Links, images, stylesheets, forms and most scripts keep working because every
URL is rewritten to go back through the proxy.

It is deliberately **not** an open proxy: only domains an administrator has
put on an allowlist can be opened, and a strict set of network rules makes it
unusable as an SSRF tool against internal services. It does not try to defeat
logins, CAPTCHAs, bot protection or content filters.

The repository contains the application, its test-suite, a Dockerfile, a
`docker-compose.yml` for local development, and a `render.yaml` Blueprint
that deploys it to **Render** as a free Docker web service with HTTPS.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Local development](#3-local-development)
4. [Environment variables](#4-environment-variables)
5. [How the allowlist works](#5-how-the-allowlist-works)
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

* **Homepage** with a large address box. Enter `example.com/page` (the
  `https://` is optional) and press *Open*.
* The proxy validates the address, fetches it server-side over HTTP/HTTPS and
  streams it back to you under `https://your-proxy/p/https/example.com/page`.
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
* A protected **admin area** (`/admin`) lets you view, add and remove allowed
  domains and see health/status information.
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
        │   Docker web service   │   (in-memory sessions, allowlist from env)
        └───────────┬────────────┘
                    │ HTTP(S) to allowlisted hosts only, via the SSRF-safe client
                    ▼
            allowlisted websites
```

Request flow for `GET /p/https/example.com/a`:

1. `src/routes/proxy.js` parses the path, normalises the hostname and checks
   the allowlist (`src/allowlist.js`, `src/security/target.js`).
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

npm test                      # 96 tests against a local mock website (no network needed)
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

Admin-added domains are persisted in the `app_data` volume
(`ALLOWLIST_STORAGE=file`, the default). Caddy is only part of the local
stack; Render provides TLS itself.

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
| `PROXY_ALLOWED_DOMAINS` | *(empty)* | Comma-separated allowlist, e.g. `example.com,*.example.com`. |
| `PROXY_UNLISTED_URL_MODE` | `direct` | `direct`: links to unlisted domains stay direct; `proxy`: route them through the proxy (they get a "not authorized" page). |
| `PROXY_SHOW_ALLOWLIST` | `true` | Show the allowed domains on the homepage. |
| `PROXY_BANNER` | `true` | Inject the slim "viewing through AnonView" bar into proxied pages. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | *(empty = admin disabled)* | Admin login. Password ≥ 12 characters, no common words. |
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
| `ALLOWLIST_STORAGE` | `file` | `file`: admin-added domains persisted under `DATA_DIR`; `memory`: RAM only (Render — ephemeral disk). |
| `DATA_DIR` | `./data` | Directory for `allowlist.json` when `ALLOWLIST_STORAGE=file`. |
| `DOMAIN`, `ACME_EMAIL` | *(empty)* | Local docker-compose + Caddy only. Ignored on Render. |

`.env` is git-ignored; never commit it. `.env.example` documents every key.

## 5. How the allowlist works

* Matching is **strict**: `example.com` matches only `example.com`.
  `*.example.com` matches every subdomain (`www.example.com`, `a.b.example.com`)
  but *not* the bare `example.com` — list both if you want both.
* Entries can only be hostnames. IP addresses, ports and paths are rejected.
* Two sources are merged:
  * `PROXY_ALLOWED_DOMAINS` from the environment — **locked**, shown as
    "environment" in the admin UI; change them in Render's *Environment* tab
    (Render redeploys automatically).
  * Domains added in `/admin` — with `ALLOWLIST_STORAGE=file` (local Docker)
    they are saved to `DATA_DIR/allowlist.json`; with `ALLOWLIST_STORAGE=memory`
    (Render) they live in RAM and are **lost on restart or redeploy**. The
    admin page says so. Treat `PROXY_ALLOWED_DOMAINS` as the source of truth on
    Render and use the admin UI for quick experiments.
* Everything not on the list gets a clear "Website not authorized" page. In the
  default `direct` mode, links and assets on a proxied page that point to
  unlisted domains are left as direct links (your browser would contact those
  sites directly if you follow them; images from unlisted CDNs load directly).
  Set `PROXY_UNLISTED_URL_MODE=proxy` to have them blocked instead — then add
  the CDN domains you need to the allowlist.

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
* Connect, header, idle and total-transfer timeouts; maximum response and
  request sizes; a cap on concurrent upstream requests; per-IP rate limiting
  (stricter for admin login), keyed on Render's `True-Client-IP` header so a
  spoofed `X-Forwarded-For` cannot open a fresh bucket.

**Between visitor and proxy**

* Upstream cookies never reach the browser; they live in a signed, HttpOnly,
  SameSite, `Secure` (over HTTPS) session on the server and expire.
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
* Admin: constant-time credential comparison, signed `SameSite=Strict` session
  cookie, CSRF tokens on every state change, login rate limiting, `no-store`.
* Errors shown to users are generic; details, stack traces and resolved
  addresses go to the server log only. Logs never contain cookies,
  authorization headers, request bodies or query strings (proxied URLs are
  logged as `/p/https/host/…`), and pino redaction is configured as a
  second line of defence.
* Container: non-root user (uid 1000), production-only dependencies, memory
  cap sized for Render's free instance; no secrets in the image or repo.

See `test/ssrf.test.js` and `test/render.test.js` for the executable version
of these guarantees.

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
| `PROXY_ALLOWED_DOMAINS` | The sites visitors may open, comma-separated, e.g. `example.com,*.example.com,docs.python.org` |
| `ADMIN_USERNAME` | Your admin login name, e.g. `admin` |
| `ADMIN_PASSWORD` | A strong password, **at least 12 characters**, not containing "password"/"admin"/"changeme" |
| `SESSION_SECRET` | Leave it to Render — the Blueprint has `generateValue: true`, which creates a random 256-bit value that persists across deploys. (Manual flow: click *Generate* or paste `openssl rand -hex 32`.) |

Predefined by `render.yaml` (change in the *Environment* tab if needed):
`NODE_ENV=production`, `PORT=10000`, `HOST=0.0.0.0`, `TRUST_PROXY=true`,
`CLIENT_IP_HEADER=true-client-ip`, `ALLOWLIST_STORAGE=memory`,
`LOG_LEVEL=info`, `RATE_LIMIT=300`, `RATE_LIMIT_WINDOW=60`,
`ADMIN_RATE_LIMIT=10`, `MAX_RESPONSE_SIZE=20m`, `MAX_REQUEST_SIZE=2m`,
`REQUEST_TIMEOUT=30`, `CONNECT_TIMEOUT=10`, `TRANSFER_TIMEOUT=300`,
`MAX_CONCURRENT_UPSTREAM=32`, `PROXY_UNLISTED_URL_MODE=direct`,
`PROXY_SHOW_ALLOWLIST=true`, `PROXY_BANNER=true`.

Changing any variable triggers an automatic redeploy.

### 7.6 Deploy

Click **Apply** (Blueprint) or **Create Web Service**. Render clones the
repository, builds the Dockerfile (2–4 minutes the first time), starts the
container and polls `/health` until it answers `200`; only then does traffic
switch to the new instance. Every later `git push` to `main` deploys
automatically (`autoDeploy: true`); you can also click **Manual Deploy**.

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
* **Redeploy the same commit**: **Manual Deploy** → **Deploy latest commit**
  (rebuilds; use **Clear build cache & deploy** if the build looks stale).
* **Deploy new code**: `git push` to `main` — Render builds, health-checks
  `/health` and switches traffic with zero downtime.
* On restart/redeploy Render sends `SIGTERM`; the app finishes in-flight
  responses and exits (`maxShutdownDelaySeconds: 30`). Being stateless, it
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
* **Ephemeral filesystem:** anything written to disk is lost on restart or
  redeploy, and persistent disks are not available on the free plan —
  hence `ALLOWLIST_STORAGE=memory` and env-var driven configuration.
* **Bandwidth:** 100 GB/month outbound included; free services are
  suspended for the rest of the month if exceeded.
* **Build minutes:** 500 pipeline minutes/month; each deploy of this image
  uses about 2–3.
* **No shell access** on free instances; use the logs and `/health`.
* Cold starts and shared CPU mean a heavy page can take a few seconds the
  first time. Keep the allowlist small and treat the service as personal.

## 12. Troubleshooting

| Symptom | What to check |
|---|---|
| Build fails on Render | Events → deploy logs. The build only needs `package.json`, `package-lock.json` and `src/`; make sure they are committed. |
| Deploy stuck on "health check" | Logs tab. Common cause: a configuration error printed at start-up (`SESSION_SECRET` missing, `ADMIN_PASSWORD` shorter than 12 chars or containing a common word, invalid `PROXY_ALLOWED_DOMAINS` entry such as an IP or a port). Fix the variable → Render redeploys. |
| `/admin` returns 404 | Both `ADMIN_USERNAME` and `ADMIN_PASSWORD` must be set. |
| First request after a pause is slow | Free-tier spin-down (§11). |
| Website not authorized | Add the domain (and its subdomains with `*.`) to `PROXY_ALLOWED_DOMAINS`. |
| A domain added in `/admin` disappeared | Expected on Render (`ALLOWLIST_STORAGE=memory`); put it in `PROXY_ALLOWED_DOMAINS`. |
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
│   ├── allowlist.js         env + admin-managed allowlist (file or memory storage)
│   ├── sessions.js          in-memory sessions with cookie jars (TTL, LRU)
│   ├── security/            address policy, hostname rules, safe DNS lookup, target parsing
│   ├── upstream/            HTTP client, header hygiene, decompression, byte limits
│   ├── rewrite/             URL/srcset, CSS, charset handling, streaming HTML rewriter
│   ├── routes/              site pages, proxy endpoint, admin, referer fallback
│   ├── views/               HTML templates (escaping helpers)
│   └── public/              style.css, homepage JS, favicon, client shim (shim.js)
├── test/                    node:test suites + local mock website (helpers/)
├── Dockerfile               multi-stage, non-root, honours $PORT
├── render.yaml              Render Blueprint (free Docker web service, /health check)
├── docker-compose.yml       local stack: app + Caddy (development / self-hosting)
├── deploy/caddy/Caddyfile   Caddy config for the local stack only
└── .env.example             application settings template
```

There is no longer any Oracle Cloud / Terraform code in this repository;
the local Docker stack and `render.yaml` are the only deployment targets.
