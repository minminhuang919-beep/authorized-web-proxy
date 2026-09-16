# syntax=docker/dockerfile:1
#
# AnonView proxy — production image.
# Used by Render (render.yaml, runtime: docker) and by docker-compose locally.
# Multi-arch: the dependency tree has no native addons, so the same Dockerfile
# builds on linux/amd64 (Render) and linux/arm64 without a toolchain.

ARG NODE_VERSION=24

# ---- dependencies ----------------------------------------------------------
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

# The app listens on 0.0.0.0:$PORT. Render injects PORT (10000 by default);
# docker-compose and local runs fall back to 8080.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

# Copy the installed dependencies and the application source.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Optional persistent data (admin-managed allowlist when ALLOWLIST_STORAGE=file).
# On Render the filesystem is ephemeral; render.yaml sets ALLOWLIST_STORAGE=memory.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as the unprivileged `node` user (uid/gid 1000) shipped with the base image.
USER 1000:1000

EXPOSE 8080

# Docker-level health check (docker-compose). Render uses healthCheckPath instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["sh", "-c", "wget -qO- \"http://127.0.0.1:${PORT:-8080}/health\" >/dev/null || exit 1"]

# `node` handles SIGTERM itself (see src/server.js) for clean restarts/redeploys.
CMD ["node", "src/server.js"]
