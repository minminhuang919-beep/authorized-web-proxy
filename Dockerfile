# syntax=docker/dockerfile:1
#
# AnonView proxy — production image.
# Used by Render (render.yaml, runtime: docker) and by docker-compose locally.
#
# The image contains the Node application and its production dependencies —
# nothing else. Web search is NOT built into this image: it is an external
# backend the app calls over HTTP (SEARCH_PROVIDER). The default, `bing`,
# needs no URL, no key and no second container; docker-compose can also run
# the official SearXNG image next to this one on a private network
# (`--profile searxng`). See README §5 and §11.
#
# Multi-arch: no native addons, so the same file builds on amd64 and arm64.

ARG NODE_VERSION=24

# ---- node dependencies -----------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.title="anonview-proxy" \
      org.opencontainers.image.description="Allowlisted anonymous-view web proxy"

# The app listens on 0.0.0.0:$PORT. Render injects PORT (render.yaml sets
# 10000); docker-compose and local runs fall back to 8080. Node's heap is
# capped so a burst of proxied responses cannot push a 512 MB instance into
# the OOM killer.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

# The installed dependencies and the application source.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Optional persistent data (admin-managed allowlist when ADMIN_STORAGE=file).
# On Render the filesystem is ephemeral; render.yaml sets ADMIN_STORAGE=memory.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as the unprivileged `node` user (uid/gid 1000) shipped with the base image.
USER 1000:1000

EXPOSE 8080

# Docker-level health check (docker-compose). Render uses healthCheckPath instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["sh", "-c", "wget -qO- \"http://127.0.0.1:${PORT:-8080}/health\" >/dev/null || exit 1"]

# Node is PID 1 and handles SIGTERM itself (see src/server.js), so no
# entrypoint script or process supervisor is needed.
CMD ["node", "src/server.js"]
