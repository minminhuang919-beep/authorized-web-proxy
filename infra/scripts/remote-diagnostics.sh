#!/usr/bin/env bash
# Runs ON THE SERVER: a one-screen picture of host and container health.
# Never prints secrets (.env is not read).
set -uo pipefail
APP_DIR="${APP_DIR:-/opt/anonview}"

section() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

section "Host"
echo "hostname : $(hostname)   arch: $(uname -m)   kernel: $(uname -r)"
echo "uptime   :$(uptime | sed 's/.*up/ up/')"
echo "os       : $(. /etc/os-release && echo "$PRETTY_NAME")"

section "CPU / memory"
echo "load     : $(cut -d' ' -f1-3 /proc/loadavg) (1/5/15 min, $(nproc) cores)"
free -h | sed 's/^/  /'

section "Disk"
df -h / /var/lib/docker 2>/dev/null | sed 's/^/  /'

section "Containers"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  (cd "$APP_DIR" 2>/dev/null && docker compose ps 2>/dev/null) || docker ps
  echo
  docker stats --no-stream --format '  {{.Name}}: cpu {{.CPUPerc}}  mem {{.MemUsage}}  net {{.NetIO}}' 2>/dev/null
  echo
  for c in anonview-app anonview-caddy; do
    printf '  %-16s health=%s restarts=%s started=%s\n' "$c" \
      "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c" 2>/dev/null || echo missing)" \
      "$(docker inspect --format '{{.RestartCount}}' "$c" 2>/dev/null || echo -)" \
      "$(docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null | cut -c1-19)"
  done
else
  echo "  docker not available"
fi

section "Application /health"
curl -fsSL -k --max-time 10 http://127.0.0.1/health 2>/dev/null || echo "  (not reachable through Caddy)"
echo

section "Certificates (Caddy)"
docker exec anonview-caddy sh -c 'ls /data/caddy/certificates/*/ 2>/dev/null' 2>/dev/null | sed 's/^/  /' || echo "  none yet (no domain configured or issuance pending)"

section "Firewall (host)"
sudo iptables -S INPUT 2>/dev/null | grep -E 'dport (22|80|443)|REJECT|DROP' | sed 's/^/  /'

section "fail2ban"
sudo fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned|Total banned' | sed 's/^/  /' || echo "  not running"

section "Recent application log lines"
(cd "$APP_DIR" 2>/dev/null && docker compose logs --tail=15 --no-log-prefix app 2>/dev/null | cut -c1-200) || true
