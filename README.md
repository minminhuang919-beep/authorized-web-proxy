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

The repository contains the application, its test-suite, a Docker/Caddy
production stack with automatic HTTPS, and Terraform + shell automation to
run it on an **Oracle Cloud Always Free** Ampere A1 (ARM64) server.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Local development](#3-local-development)
4. [Environment variables](#4-environment-variables)
5. [How the allowlist works](#5-how-the-allowlist-works)
6. [Security model](#6-security-model)
7. [Creating OCI credentials](#7-creating-oci-credentials)
8. [Provisioning the Oracle server](#8-provisioning-the-oracle-server)
9. [Configuring a domain](#9-configuring-a-domain)
10. [How HTTPS works](#10-how-https-works)
11. [Deploying updates](#11-deploying-updates)
12. [Viewing logs](#12-viewing-logs)
13. [Restarting the service](#13-restarting-the-service)
14. [Troubleshooting](#14-troubleshooting)
15. [Destroying the infrastructure](#15-destroying-the-infrastructure)
16. [Oracle Always Free limitations](#16-oracle-always-free-limitations)
17. [ARM64 compatibility](#17-arm64-compatibility)
18. [Project structure](#18-project-structure)

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
* `/health` returns a JSON status for monitoring.

## 2. Architecture

```
                 Internet
                    │
        ┌───────────▼────────────┐   ports 80 / 443 only
        │   Caddy (TLS edge)     │   automatic Let's Encrypt, HTTP→HTTPS,
        │   caddy:2-alpine       │   compression, reverse proxy
        └───────────┬────────────┘
                    │ internal Docker network (app port never published)
        ┌───────────▼────────────┐
        │   AnonView (Node 24)   │   Fastify 5, runs as non-root `node`,
        │   anonview-proxy       │   read-only filesystem, /data volume
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

Everything is plain JavaScript with **no native addons**, which is what makes
the ARM64 build trivial.

## 3. Local development

Requirements: Node.js 22.12+ (24 LTS recommended), npm.

```bash
npm install
cp .env.example .env          # edit PROXY_ALLOWED_DOMAINS, ADMIN_* …
npm run dev                   # http://localhost:8080 with pretty logs (auto-reload)

npm test                      # 90 tests against a local mock website (no network needed)
npm run lint                  # ESLint
npm run check                 # lint + test
```

`npm start` runs the server without the pretty-printer (JSON logs). In
development a random `SESSION_SECRET` is generated if you leave it empty;
in production it is required.

Docker locally (if you have Docker):

```bash
docker compose up --build     # http://localhost (Caddy on :80, no domain → HTTP)
```

## 4. Environment variables

All configuration comes from environment variables (`.env` locally, the
server's `/opt/anonview/.env` in production — generated by `deploy.sh` from
your `deploy.env`). Sizes accept `k`/`m`/`g` suffixes; durations are seconds.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Listen address (internal only in Docker). |
| `NODE_ENV` | `development` | `production` enforces `SESSION_SECRET`. |
| `LOG_LEVEL` | `info` | pino log level. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from the reverse proxy (`true` in docker-compose). |
| `PROXY_ALLOWED_DOMAINS` | *(empty)* | Comma-separated allowlist, e.g. `example.com,*.example.com`. |
| `PROXY_UNLISTED_URL_MODE` | `direct` | `direct`: links to unlisted domains stay direct; `proxy`: route them through the proxy (they get a "not authorized" page). |
| `PROXY_SHOW_ALLOWLIST` | `true` | Show the allowed domains on the homepage. |
| `PROXY_BANNER` | `true` | Inject the slim "viewing through AnonView" bar into proxied pages. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | *(empty = admin disabled)* | Admin login. Password ≥ 12 characters, no common words. |
| `SESSION_SECRET` | *(required in production)* | ≥ 32 random characters; signs session cookies. `openssl rand -hex 32`. |
| `SESSION_TTL` / `SESSION_MAX` | `1800` / `5000` | Idle lifetime and maximum number of sessions kept in memory. |
| `RATE_LIMIT` / `RATE_LIMIT_WINDOW` | `300` / `60` | Requests per client IP per window. |
| `ADMIN_RATE_LIMIT` | `10` | Login attempts per IP per window. |
| `MAX_RESPONSE_SIZE` | `20m` | Largest upstream response relayed (applies to compressed and decoded bytes). |
| `MAX_REQUEST_SIZE` | `2m` | Largest request body accepted. |
| `REQUEST_TIMEOUT` | `30` | Seconds to wait for upstream headers / between body chunks. |
| `CONNECT_TIMEOUT` | `10` | Seconds to establish the upstream TCP/TLS connection. |
| `TRANSFER_TIMEOUT` | `300` | Hard cap on the duration of one proxied response. |
| `MAX_CONCURRENT_UPSTREAM` | `64` | In-flight upstream requests across all visitors (503 beyond). |
| `DATA_DIR` | `./data` | Where admin-added allowlist entries are persisted (`/data` volume in Docker). |
| `DOMAIN`, `ACME_EMAIL` | *(empty)* | Used by Caddy: public domain for HTTPS and the Let's Encrypt contact e-mail. |

`.env` is git-ignored; never commit it. `.env.example` documents every key.

## 5. How the allowlist works

* Matching is **strict**: `example.com` matches only `example.com`.
  `*.example.com` matches every subdomain (`www.example.com`, `a.b.example.com`)
  but *not* the bare `example.com` — list both if you want both.
* Entries can only be hostnames. IP addresses, ports and paths are rejected.
* Two sources are merged:
  * `PROXY_ALLOWED_DOMAINS` from the environment — **locked**, shown as
    "environment" in the admin UI; change them by editing the environment.
  * Domains added in `/admin` — persisted to `DATA_DIR/allowlist.json`
    (a Docker volume in production), survive restarts, removable in the UI.
* Everything not on the list gets a clear "Website not authorized" page. In the
  default `direct` mode, links and assets on a proxied page that point to
  unlisted domains are left as direct links (your browser would contact those
  sites directly if you follow them; images from unlisted CDNs load directly).
  Set `PROXY_UNLISTED_URL_MODE=proxy` if you would rather have them blocked —
  then add the CDN domains you need to the allowlist.

## 6. Security model

**Not an open proxy / SSRF surface**

* Only `http:` and `https:` targets; only the scheme's default port (80/443) —
  user-supplied ports and embedded credentials are rejected.
* Hostnames must be on the allowlist; IP literals in any form (dotted,
  decimal, hex, IPv6, IPv4-mapped IPv6) and special-use names (`localhost`,
  `*.local`, `*.internal`, `*.lan`, `*.arpa`, `*.onion`, …) are always refused.
* DNS results are validated inside the socket's `lookup` hook on every new
  connection. Blocked: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`,
  `169.254/16` (cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`,
  `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
  `203.0.113/24`, multicast, `240/4`; IPv6 `::`, `::1`, `::/96`, IPv4-mapped
  and NAT64 forms of the above, `64:ff9b:1::/48`, `100::/64`, Teredo, 6to4,
  documentation/benchmark/ORCHID ranges, `fc00::/7`, `fe80::/10`,
  `fec0::/10`, multicast, `3fff::/20`, `5f00::/16`. A host whose answer mixes
  public and private addresses is refused entirely.
* Redirects (`Location`) are resolved and re-validated; redirects to unlisted
  or private destinations are stopped with an explanatory page.
* Connect, header, idle and total-transfer timeouts; maximum response and
  request sizes; a cap on concurrent upstream requests; per-IP rate limiting
  (stricter for admin login).

**Between visitor and proxy**

* Upstream cookies never reach the browser; they live in a signed, HttpOnly,
  SameSite session on the server and expire.
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
* The proxy's own pages carry a strict CSP and Helmet's security headers;
  Caddy adds HSTS on HTTPS.
* Admin: constant-time credential comparison, signed `SameSite=Strict` session
  cookie, CSRF tokens on every state change, login rate limiting, `no-store`.
* Errors shown to users are generic; details, stack traces and resolved
  addresses go to the server log only. Logs never contain cookies,
  authorization headers, request bodies or query strings (proxied URLs are
  logged as `/p/https/host/…`), and pino redaction is configured as a
  second line of defence.
* Container: non-root user, read-only root filesystem, all capabilities
  dropped, `no-new-privileges`, memory limit, app port not published.
* Host: only 22/80/443 open in both the OCI security list and the Ubuntu
  iptables rules; SSH is key-only with fail2ban; unattended security updates.

See `test/ssrf.test.js` for the executable version of these guarantees.

## 7. Creating OCI credentials

The automation needs an **API signing key** for your Oracle Cloud user plus
the OCI CLI and Terraform on your machine. It cannot create an Oracle account
or pass Oracle's sign-up verification for you.

1. Create/sign in to an account at <https://cloud.oracle.com>. Note the
   **home region** shown at the top (Always Free compute only exists there).
2. Top-right profile icon → **My profile** → **API keys** → **Add API key** →
   **Generate API key pair** → download the *private* key → **Add**.
3. Oracle shows a *Configuration file preview*. Save it as `~/.oci/config`
   (Windows: `C:\Users\<you>\.oci\config`) and set `key_file` to where you
   stored the private key, e.g.

   ```ini
   [DEFAULT]
   user=ocid1.user.oc1..aaaaaaaa…
   fingerprint=12:34:56:…
   tenancy=ocid1.tenancy.oc1..aaaaaaaa…
   region=eu-frankfurt-1
   key_file=~/.oci/oci_api_key.pem
   ```

4. Install the tools:
   * Windows: `winget install Oracle.OCI-CLI` and `winget install Hashicorp.Terraform`
     (run `deploy.sh` from **Git Bash**).
   * macOS: `brew install oci-cli terraform`
   * Linux: `bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"`
     and <https://developer.hashicorp.com/terraform/install>.
5. Check: `oci iam region-subscription list` should list your regions.

`./deploy.sh` performs this check itself and prints exactly what is missing.

## 8. Provisioning the Oracle server

```bash
cp deploy.env.example deploy.env      # edit: PROXY_ALLOWED_DOMAINS, DOMAIN, ADMIN_USERNAME, SSH_ALLOWED_CIDR …
./deploy.sh
```

What `./deploy.sh` does, in order:

1. Checks prerequisites (bash, ssh, tar, curl, terraform) and generates an SSH
   key at `~/.ssh/anonview` if needed.
2. Verifies OCI authentication and discovers the tenancy and **home region**.
3. Asks OCI's *Compute Capacity Report* API which availability domain has
   room for `VM.Standard.A1.Flex` with your OCPU/RAM (then 1 OCPU/6 GB, then —
   only if `ALLOW_X86_FALLBACK=true` — the x86 `VM.Standard.E2.1.Micro`).
   **No instance is ever created blindly**; if nothing is available it stops
   and explains what to do (see §16).
4. Runs Terraform (`infra/terraform`): VCN `10.0.0.0/16`, internet gateway,
   route table, security list (22 from `SSH_ALLOWED_CIDR`, 80, 443/tcp+udp),
   public subnet, the Ubuntu 24.04 ARM64 instance (2 OCPU / 12 GB / 50 GB boot
   volume by default) with a reserved public IP. Cloud-init installs Docker +
   Compose, opens 80/443 in the host firewall, enables fail2ban and
   unattended upgrades, and sets up Docker log rotation.
   If an existing instance is found in the Terraform state it is reused.
5. Waits for SSH and for cloud-init to finish.
6. Uploads the project (excluding secrets, state and `node_modules`), writes
   `/opt/anonview/.env` (mode 600) from `deploy.env`, generating
   `SESSION_SECRET` and `ADMIN_PASSWORD` if you left them empty, then runs
   `docker compose up -d --build` **on the server** (native ARM64 build).
7. Waits for the container health checks, then verifies from your machine:
   `/health`, an allowlisted site, an unlisted site (403), several SSRF
   targets (400/403) and that `/admin` needs a login.
8. Prints the public URL, health URL, SSH command and — once — a generated
   admin password.

Other commands: `./deploy.sh infra` (server only), `./deploy.sh app`
(redeploy only), `verify`, `status`, `logs`, `ssh`, `ip`.

## 9. Configuring a domain

1. Buy/choose a domain and create an **A record** pointing at the server's
   public IP (`./deploy.sh ip`). Wait until `nslookup your.domain` returns it.
2. Set `DOMAIN=your.domain` and `ACME_EMAIL=you@example.com` in `deploy.env`.
3. `./deploy.sh app` — Caddy obtains a certificate within about a minute.

Without a domain the stack serves plain **HTTP on the IP address** — fine for
testing, but there is no encryption between you and the proxy, and browsers
treat the site as insecure. Use a domain for real use.

## 10. How HTTPS works

Caddy (`deploy/caddy/Caddyfile`) sits in front of the app:

* `DOMAIN` set → Caddy listens on 443, obtains and **renews** Let's Encrypt
  certificates automatically (stored in the `caddy_data` volume), redirects
  HTTP→HTTPS, adds HSTS, compresses responses, and proxies to `app:8080`.
  Caddy's TLS defaults are modern (TLS 1.2+, strong ciphers, OCSP stapling).
* `DOMAIN` empty → Caddy listens on 80 only.
* The app only ever listens on the internal Docker network.

## 11. Deploying updates

```bash
git pull            # or edit the code
npm run check       # tests + lint locally
./deploy.sh app     # upload, rebuild on the server, rolling restart, health check
```

Existing generated secrets on the server are preserved; anything set in
`deploy.env` overrides the server's `.env`. Admin-added domains live in the
`app_data` volume and survive updates and restarts.

## 12. Viewing logs

```bash
./deploy.sh logs                       # follow app + caddy logs
./deploy.sh ssh
  cd /opt/anonview
  docker compose logs --tail=200 app   # application (JSON lines, pino)
  docker compose logs caddy            # access log + certificate events
  sudo journalctl -u docker            # Docker daemon
  sudo cat /var/log/cloud-init-output.log   # first-boot provisioning
```

Application log lines contain method, path (query stripped, proxied URLs as
`/p/https/host/…`), status, duration and client IP — never cookies, tokens
or bodies. Logs rotate at 10 MB × 3 files per container.

## 13. Restarting the service

```bash
./deploy.sh ssh
  cd /opt/anonview
  docker compose restart app       # restart the proxy only
  docker compose restart           # everything
  docker compose down && docker compose up -d
```

Containers use `restart: unless-stopped`, Docker starts at boot and
`live-restore` is enabled, so the service comes back by itself after crashes,
Docker restarts and reboots (unattended upgrades reboot at 04:30 when
required).

## 14. Troubleshooting

| Symptom | What to check |
|---|---|
| `deploy.sh` says credentials are missing | §7. `~/.oci/config` must exist with `user`, `tenancy`, `fingerprint`, `key_file`, `region`. |
| `No Always Free capacity is available` | Not a bug. Re-run later, upgrade to Pay-As-You-Go (stays free), or set `ALLOW_X86_FALLBACK=true`. See §16. |
| `terraform apply` fails with a 4xx | Permissions: the user needs `manage` on virtual-network-family, instance-family and public-ips in the compartment (root compartment for a personal tenancy is fine). |
| SSH times out | Security list (`SSH_ALLOWED_CIDR` must include your current IP) and the instance state in the console. |
| `/health` unreachable from outside, fine on the server | Host firewall: `sudo iptables -S INPUT` must show ACCEPT for 80/443 (cloud-init does this; re-run `sudo /usr/local/sbin/anonview-firewall.sh`). OCI security list must allow 80/443. |
| HTTPS certificate not issued | DNS A record must point at the server; port 80 **and** 443 must be reachable (ACME); `docker compose logs caddy`. |
| Website not authorized | Add the domain (and its subdomains with `*.`) in `/admin` or `PROXY_ALLOWED_DOMAINS`. |
| A page looks broken | Its assets may come from an unlisted CDN (allow it) or it relies on WebSockets/service workers (unsupported). |
| `503 The proxy is busy` | `MAX_CONCURRENT_UPSTREAM` reached — raise it or check for a slow upstream. |
| High memory / disk | `./deploy.sh status` (CPU, RAM, disk, container stats), `docker system prune`. |

Diagnostics in one go: `./deploy.sh status`.

## 15. Destroying the infrastructure

```bash
./destroy.sh
```

It lists every resource in the Terraform state and asks you to type the
instance name before running `terraform destroy`. This deletes the instance
**and its boot volume** (including the admin allowlist and TLS certificates
stored in Docker volumes), the reserved IP and the network. Nothing outside
the Terraform state is touched. Your OCI account and credentials remain.

## 16. Oracle Always Free limitations

* **ARM (A1) compute:** up to 4 OCPUs and 24 GB RAM in total per tenancy,
  only in the home region, split across at most 4 instances. This project uses
  2 OCPU / 12 GB by default (change `INSTANCE_OCPUS`/`INSTANCE_MEMORY_GB`).
* **Capacity:** A1 hosts are frequently exhausted ("Out of host capacity").
  Free-tier tenancies are lowest priority; upgrading to Pay As You Go keeps
  Always Free resources free but gets capacity much more reliably. The
  deploy script checks capacity first and never loops creating instances.
* **Other Always Free shapes:** 2 × `VM.Standard.E2.1.Micro` (x86, 1/8 OCPU,
  1 GB). The image is multi-arch so it runs there (`ALLOW_X86_FALLBACK=true`),
  with reduced throughput.
* **Storage:** 200 GB total block storage (boot volumes count); the default
  50 GB boot volume fits comfortably.
* **Network:** 10 TB/month outbound; reserved public IPv4 addresses are free.
* **Idle reclamation:** Oracle may stop Always Free instances that are idle
  (< 20 % CPU/network for 7 days). A proxy with occasional use may be
  reclaimed; upgrading to PAYG exempts you. The instance can simply be
  started again from the console.
* No SLA; keep the allowlist small and treat it as a personal service.

## 17. ARM64 compatibility

* Runtime: `node:24-alpine` and `caddy:2-alpine` are published for
  `linux/arm64/v8` and `linux/amd64`; the Dockerfile has no architecture
  specific steps.
* Dependencies: the whole tree is pure JavaScript (verified — no `binding.gyp`
  or `.node` files), so no cross-compilation or native toolchain is needed.
* The image is built **on the server** for its native architecture, so a
  Windows/macOS laptop without Docker can deploy. On an x86 fallback instance
  the same Dockerfile produces an amd64 image.
* Docker Engine and the Compose plugin are installed from Docker's official
  Ubuntu repository, which ships arm64 packages.

## 18. Project structure

```
proxy/
├── src/
│   ├── server.js            entry point (env loading, graceful shutdown)
│   ├── app.js               Fastify app factory, error handler, 404/referer fallback
│   ├── config.js            environment parsing & validation
│   ├── allowlist.js         env + admin-managed allowlist with JSON persistence
│   ├── sessions.js          in-memory sessions with cookie jars (TTL, LRU)
│   ├── security/            address policy, hostname rules, safe DNS lookup, target parsing
│   ├── upstream/            HTTP client, header hygiene, decompression, byte limits
│   ├── rewrite/             URL/srcset, CSS, charset handling, streaming HTML rewriter
│   ├── routes/              site pages, proxy endpoint, admin, referer fallback
│   ├── views/               HTML templates (escaping helpers)
│   └── public/              style.css, homepage JS, favicon, client shim (shim.js)
├── test/                    node:test suites + local mock website (helpers/)
├── Dockerfile, docker-compose.yml, .dockerignore
├── deploy/caddy/Caddyfile   TLS edge configuration
├── deploy.sh / destroy.sh   one-command deployment / teardown
├── deploy.env.example       deployment settings template
├── infra/
│   ├── README.md            infrastructure details
│   ├── terraform/           OCI resources + cloud-init template
│   └── scripts/             auth check, capacity check, wait-for-ssh, remote deploy/diagnostics, self-test
└── .env.example             application settings template
```
