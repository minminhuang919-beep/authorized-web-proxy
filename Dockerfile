# syntax=docker/dockerfile:1
#
# AnonView proxy — production image.
# Used by Render (render.yaml, runtime: docker) and by docker-compose locally.
#
# The image also carries a private SearXNG metasearch backend so that web
# search works without a paid API or a second hosted service: the entrypoint
# starts it on 127.0.0.1 next to the Node app when SEARCH_PROVIDER=searxng
# (see deploy/docker-entrypoint.sh). It is never reachable from outside the
# container. With docker-compose SearXNG runs as its own internal service and
# the embedded copy stays off.
#
# Multi-arch: no native Node addons; the Python wheels used by SearXNG ship
# for musl on amd64 and arm64.

ARG NODE_VERSION=24
# Pinned SearXNG commit (https://github.com/searxng/searxng); bump deliberately.
ARG SEARXNG_COMMIT=c0042add30116a315ebacfcb84781bb3e1e4e77e

# ---- node dependencies -----------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- searxng ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS searxng
ARG SEARXNG_COMMIT
RUN apk add --no-cache python3 py3-pip curl tar
WORKDIR /usr/local/searxng
RUN curl -fsSL "https://github.com/searxng/searxng/archive/${SEARXNG_COMMIT}.tar.gz" \
      | tar -xz --strip-components=1 \
          "searxng-${SEARXNG_COMMIT}/searx" \
          "searxng-${SEARXNG_COMMIT}/requirements.txt" \
          "searxng-${SEARXNG_COMMIT}/requirements-server.txt" \
 && python3 -m venv --without-pip .venv \
 && pip install --python .venv/bin/python --no-cache-dir --only-binary=:all: \
      -r requirements.txt -r requirements-server.txt \
 && printf 'VERSION_STRING = "%s"\nVERSION_TAG = "%s"\nDOCKER_TAG = "%s"\nGIT_URL = "https://github.com/searxng/searxng"\nGIT_BRANCH = "master"\n' \
      "${SEARXNG_COMMIT}" "${SEARXNG_COMMIT}" "${SEARXNG_COMMIT}" > searx/version_frozen.py \
 && .venv/bin/python -m compileall -q searx \
 && find .venv -type d -name __pycache__ -prune -exec rm -rf {} +

# ---- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="anonview-proxy" \
      org.opencontainers.image.description="Allowlisted anonymous-view web proxy with private SearXNG search"

# Python runtime for SearXNG (no compiler, no pip). tzdata: engines use zoneinfo.
RUN apk add --no-cache python3 tzdata ca-certificates libstdc++

# The app listens on 0.0.0.0:$PORT. Render injects PORT (10000 by default);
# docker-compose and local runs fall back to 8080. Node's heap is capped so
# that it and SearXNG fit together in a 512 MB instance.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=256 \
    SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml

WORKDIR /app

# Copy the installed dependencies and the application source.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# SearXNG code + virtualenv and its settings (loopback bind, JSON API on).
COPY --from=searxng --chown=node:node /usr/local/searxng /usr/local/searxng
COPY --chown=node:node deploy/searxng/settings.yml /etc/searxng/settings.yml
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /var/cache/searxng && chown node:node /var/cache/searxng

# Optional persistent data (admin-managed allowlist when ADMIN_STORAGE=file).
# On Render the filesystem is ephemeral; render.yaml sets ADMIN_STORAGE=memory.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as the unprivileged `node` user (uid/gid 1000) shipped with the base image.
USER 1000:1000

EXPOSE 8080

# Docker-level health check (docker-compose). Render uses healthCheckPath instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["sh", "-c", "wget -qO- \"http://127.0.0.1:${PORT:-8080}/health\" >/dev/null || exit 1"]

# The entrypoint forwards SIGTERM to node (see src/server.js) and SearXNG.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
