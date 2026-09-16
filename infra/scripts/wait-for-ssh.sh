#!/usr/bin/env bash
# Wait until the server accepts SSH and cloud-init has finished provisioning.
# Usage: wait-for-ssh.sh <ip> [timeout-seconds]
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_deploy_env

ip="$1"
timeout="${2:-600}"
deadline=$(( $(date +%s) + timeout ))

log "Waiting for SSH on $ip (up to ${timeout}s)…"
until remote "$ip" true 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "Timed out waiting for SSH on $ip. Check the OCI console (instance state, security list, your SSH_ALLOWED_CIDR)."
  fi
  printf '.' >&2
  sleep 10
done
printf '\n' >&2
ok "SSH is up"

log "Waiting for cloud-init to finish (Docker installation, firewall)…"
# `cloud-init status --wait` blocks until done; returns 1 on error, 2 on
# "done with recoverable errors" (fine for us).
remote "$ip" 'sudo cloud-init status --wait >/dev/null 2>&1; rc=$?; sudo cloud-init status; exit $(( rc == 1 ? 1 : 0 ))' || \
  die "cloud-init reported errors. Inspect with: ssh $SSH_USER@$ip sudo cat /var/log/cloud-init-output.log"

until remote "$ip" 'test -f /var/lib/cloud/instance/anonview-ready && docker info >/dev/null 2>&1'; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    die "Docker did not become ready in time. Inspect with: ssh $SSH_USER@$ip sudo cat /var/log/cloud-init-output.log"
  fi
  printf '.' >&2
  sleep 10
done
printf '\n' >&2
ok "Server provisioned: $(remote "$ip" 'docker --version && docker compose version' | tr '\n' ' ')"
