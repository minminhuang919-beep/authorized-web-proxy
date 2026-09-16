#!/usr/bin/env bash
# Runs ON THE SERVER (piped through ssh by deploy.sh).
# Builds the image natively (arm64 or amd64), starts/updates the stack with
# zero manual steps, waits for the health checks and prunes old images.
#
# Environment: APP_DIR (default /opt/anonview)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/anonview}"
cd "$APP_DIR"

echo "==> Deploying in $APP_DIR on $(uname -m) ($(. /etc/os-release && echo "$PRETTY_NAME"))"
[ -f .env ] || { echo "✖ $APP_DIR/.env is missing" >&2; exit 1; }
chmod 600 .env

# Ensure the docker group membership is active for this session.
if ! docker info >/dev/null 2>&1; then
  if command -v sg >/dev/null 2>&1 && getent group docker >/dev/null; then
    exec sg docker -c "APP_DIR='$APP_DIR' bash '$0'"
  fi
  echo "✖ Cannot talk to the Docker daemon (is the ubuntu user in the docker group?)" >&2
  exit 1
fi

echo "==> Building the application image (native $(uname -m) build)…"
docker compose build --pull app

echo "==> Starting / updating containers…"
# `up` recreates only what changed; Caddy keeps its certificates in a volume.
docker compose up -d --remove-orphans

echo "==> Waiting for the application health check…"
deadline=$(( $(date +%s) + 180 ))
status="starting"
while :; do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' anonview-app 2>/dev/null || echo unknown)"
  case "$status" in
    healthy) break ;;
    unhealthy|exited|dead)
      echo "✖ Application container is $status. Recent logs:" >&2
      docker compose logs --tail=50 app >&2 || true
      exit 1 ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "✖ Timed out waiting for the app to become healthy (status: $status). Logs:" >&2
    docker compose logs --tail=50 app >&2 || true
    exit 1
  fi
  sleep 3
done
echo " ✔ app container is healthy"

deadline=$(( $(date +%s) + 60 ))
until [ "$(docker inspect --format '{{.State.Health.Status}}' anonview-caddy 2>/dev/null)" = "healthy" ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "! Caddy health check not green yet; continuing (check: docker compose logs caddy)" >&2
    break
  fi
  sleep 3
done
echo " ✔ caddy container is $(docker inspect --format '{{.State.Health.Status}}' anonview-caddy 2>/dev/null || echo running)"

echo "==> Local health check through Caddy…"
# In domain mode port 80 redirects to HTTPS; -L follows it and -k tolerates
# the certificate not being issued yet.
if curl -fsSL -k --max-time 10 -o /tmp/anonview-health.json http://127.0.0.1/health 2>/dev/null; then
  echo " ✔ /health: $(head -c 200 /tmp/anonview-health.json)"
else
  echo "! /health not reachable through Caddy yet (certificate issuance may be in progress)" >&2
fi
rm -f /tmp/anonview-health.json

echo "==> Cleaning up unused images…"
docker image prune -f >/dev/null 2>&1 || true

echo "==> Containers:"
docker compose ps
echo "✔ Deployment finished"
