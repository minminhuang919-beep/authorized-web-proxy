#!/bin/sh
# Container entrypoint: starts the proxy and, when configured, the embedded
# SearXNG search backend next to it (loopback only). Used on Render, where the
# free plan runs a single container and has no private services; with
# docker-compose SearXNG runs as its own internal service instead and the
# embedded copy stays off (SEARXNG_EMBEDDED=false).
#
#   SEARXNG_EMBEDDED  auto (default) | true | false
#     auto: start SearXNG when SEARCH_PROVIDER=searxng and SEARXNG_URL points
#           at this container (127.0.0.1 / localhost) or is unset.
#   SEARXNG_PORT      loopback port SearXNG listens on (default 8888)
#   SEARXNG_SECRET    SearXNG's own secret key; a random one is generated when
#                     unset (the SearXNG UI is unreachable from outside anyway)
set -eu

embedded="${SEARXNG_EMBEDDED:-auto}"
provider="$(printf '%s' "${SEARCH_PROVIDER:-none}" | tr '[:upper:]' '[:lower:]')"
port="${SEARXNG_PORT:-8888}"

if [ "$embedded" = "auto" ]; then
  embedded=false
  if [ "$provider" = "searxng" ]; then
    case "${SEARXNG_URL:-}" in
      ''|http://127.0.0.1:*|http://127.0.0.1|http://localhost:*|http://localhost|http://\[::1\]:*) embedded=true ;;
    esac
  fi
fi

if [ "$embedded" = "true" ]; then
  : "${SEARXNG_URL:=http://127.0.0.1:$port}"
  export SEARXNG_URL
  export SEARXNG_SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
  export SEARXNG_BIND_ADDRESS=127.0.0.1
  export SEARXNG_PORT="$port"
  if [ -z "${SEARXNG_SECRET:-}" ]; then
    SEARXNG_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    export SEARXNG_SECRET
  fi
  export PYTHONPATH=/usr/local/searxng
  export PYTHONUNBUFFERED=1
  echo "[entrypoint] starting embedded SearXNG on 127.0.0.1:$port"
  /usr/local/searxng/.venv/bin/granian --interface wsgi --host 127.0.0.1 --port "$port" \
    --workers 1 --blocking-threads "${SEARXNG_THREADS:-4}" --no-ws --log-level warning \
    searx.webapp:app &
  searx_pid=$!
else
  searx_pid=""
fi

node /app/src/server.js &
node_pid=$!

shutdown() {
  kill -TERM "$node_pid" 2>/dev/null || true
  [ -n "$searx_pid" ] && kill -TERM "$searx_pid" 2>/dev/null || true
}
trap 'shutdown' TERM INT

# Exit as soon as either process stops so the platform restarts the container.
if [ -n "$searx_pid" ]; then
  wait -n "$node_pid" "$searx_pid" && status=0 || status=$?
else
  wait "$node_pid" && status=0 || status=$?
fi
shutdown
wait || true
exit "$status"
