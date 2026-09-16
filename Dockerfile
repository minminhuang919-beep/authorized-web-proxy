# syntax=docker/dockerfile:1
#
# AnonView proxy — production image.
# Multi-arch: builds natively on linux/arm64 (Oracle Ampere A1) and linux/amd64.
# The dependency tree contains no native addons, so no compiler toolchain is
# needed and the same Dockerfile works on both architectures.

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
      org.opencontainers.image.description="Allowlisted anonymous-view web proxy" \
      org.opencontainers.image.source="https://github.com/your-org/anonview-proxy"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=512

WORKDIR /app

# Copy the installed dependencies and the application source.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

# Persistent data (admin-managed allowlist) lives outside the image.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as the unprivileged `node` user (uid 1000) shipped with the base image.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1

# `node` handles SIGTERM itself (see src/server.js) and is PID 1 here; the
# init flag in docker-compose.yml adds a minimal init for zombie reaping.
CMD ["node", "src/server.js"]
