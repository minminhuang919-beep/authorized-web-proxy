#!/usr/bin/env bash
# =============================================================================
# deploy.sh — provision an Oracle Cloud Always Free server and deploy AnonView.
#
#   ./deploy.sh            provision (or reuse) the server, then deploy the app
#   ./deploy.sh infra      only provision / reconcile the server
#   ./deploy.sh app        only build + deploy the app to the existing server
#   ./deploy.sh verify     run the remote health / allowlist / SSRF checks
#   ./deploy.sh status     host + container diagnostics
#   ./deploy.sh logs       follow the application logs
#   ./deploy.sh ssh        open an SSH session on the server
#   ./deploy.sh ip         print the server's public IP
#
# Configuration: deploy.env (copy deploy.env.example). Secrets are generated
# when missing and only ever written to the server's .env (mode 600).
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=infra/scripts/lib.sh
. infra/scripts/lib.sh

usage() { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
case "${1:-all}" in -h|--help|help) usage ;; esac
COMMAND="${1:-all}"

GENERATED_ADMIN_PASSWORD=""
SERVER_IP="${SERVER_IP:-}"

# -----------------------------------------------------------------------------
# 1. Prerequisites
# -----------------------------------------------------------------------------
check_prereqs() {
  log "Checking prerequisites"
  [ "${BASH_VERSINFO[0]}" -ge 4 ] || die "bash 4+ is required (on macOS: brew install bash)"
  need_cmd ssh "OpenSSH client"
  need_cmd ssh-keygen "OpenSSH client"
  need_cmd tar
  need_cmd curl
  TERRAFORM_MISSING=0
  if [ "$COMMAND" = "all" ] || [ "$COMMAND" = "infra" ]; then
    if have_cmd terraform; then
      ok "terraform $(terraform version -json 2>/dev/null | sed -n 's/.*"terraform_version": *"\([^"]*\)".*/\1/p' | head -1)"
    else
      TERRAFORM_MISSING=1
    fi
  fi
  load_deploy_env
  [ -n "${PROXY_ALLOWED_DOMAINS:-}" ] || warn "PROXY_ALLOWED_DOMAINS is empty in deploy.env — the proxy will refuse every site until domains are added in /admin."
  ok "deploy.env loaded (instance: $INSTANCE_NAME, shape: $INSTANCE_SHAPE ${INSTANCE_OCPUS}x${INSTANCE_MEMORY_GB}GB, domain: ${DOMAIN:-<none, IP mode>})"
}

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY_PATH" ]; then
    log "Generating SSH key $SSH_KEY_PATH"
    mkdir -p "$(dirname "$SSH_KEY_PATH")"
    ssh-keygen -t ed25519 -N "" -C "anonview-deploy" -f "$SSH_KEY_PATH" >/dev/null
  fi
  [ -f "$SSH_KEY_PATH.pub" ] || die "Public key $SSH_KEY_PATH.pub not found next to the private key"
  ok "SSH key: $SSH_KEY_PATH"
}

# -----------------------------------------------------------------------------
# 2. Oracle Cloud authentication (stops with instructions when unavailable)
# -----------------------------------------------------------------------------
check_oci_auth() {
  log "Verifying Oracle Cloud authentication"
  local vars
  vars="$(bash infra/scripts/oci-check-auth.sh)" || exit $?
  eval "$vars"
  export TENANCY_OCID TENANCY_NAME HOME_REGION REGION COMPARTMENT_OCID
  if [ "${TERRAFORM_MISSING:-0}" = "1" ]; then
    die "terraform is not installed. Install it (Windows: winget install Hashicorp.Terraform; macOS: brew install terraform; Linux: https://developer.hashicorp.com/terraform/install) and re-run."
  fi
}

# -----------------------------------------------------------------------------
# 3. Infrastructure (Terraform + capacity-aware instance creation)
# -----------------------------------------------------------------------------
write_tfvars() { # write_tfvars <ad> <shape> <ocpus> <mem>
  local pubkey
  pubkey="$(tr -d '\r\n' < "$SSH_KEY_PATH.pub")"
  cat > "$TF_DIR/generated.auto.tfvars.json" <<EOF
{
  "tenancy_ocid": "$TENANCY_OCID",
  "compartment_ocid": "$( [ "$COMPARTMENT_OCID" = "$TENANCY_OCID" ] && echo "" || echo "$COMPARTMENT_OCID" )",
  "region": "$REGION",
  "oci_profile": "$OCI_PROFILE",
  "ssh_public_key": "$pubkey",
  "ssh_allowed_cidr": "$SSH_ALLOWED_CIDR",
  "instance_name": "$INSTANCE_NAME",
  "instance_shape": "$2",
  "instance_ocpus": $3,
  "instance_memory_gb": $4,
  "boot_volume_size_gb": $BOOT_VOLUME_GB,
  "availability_domain": "$1",
  "reserved_public_ip": $RESERVED_PUBLIC_IP,
  "app_dir": "$APP_DIR"
}
EOF
}

instance_exists() {
  tf state list 2>/dev/null | grep -q '^oci_core_instance\.proxy$'
}

provision_infra() {
  log "Initialising Terraform"
  tf init -input=false -upgrade=false >/dev/null || tf init -input=false
  ok "Terraform initialised"

  if instance_exists; then
    ok "Instance already exists in Terraform state — reconciling (no recreation)"
    local ad shape
    ad="$(tf_output availability_domain)"; shape="$(tf_output shape)"
    write_tfvars "$ad" "$shape" "$INSTANCE_OCPUS" "$INSTANCE_MEMORY_GB"
    tf apply -input=false -auto-approve >/dev/null || die "terraform apply failed while reconciling existing infrastructure (run: terraform -chdir=infra/terraform plan)"
  else
    local attempt=1 excluded=""
    while [ "$attempt" -le 3 ]; do
      log "Checking Always Free capacity (attempt $attempt/3)"
      local cap
      cap="$(EXCLUDE_ADS="$excluded" bash infra/scripts/oci-capacity.sh "$COMPARTMENT_OCID" "$TENANCY_OCID" "$REGION")" || exit $?
      eval "$cap"
      write_tfvars "$AVAILABILITY_DOMAIN" "$SHAPE" "$OCPUS" "$MEMORY_GB"
      log "Creating $SHAPE (${OCPUS} OCPU, ${MEMORY_GB} GB) in $AVAILABILITY_DOMAIN — this takes 1–3 minutes"
      local out
      if out="$(tf apply -input=false -auto-approve 2>&1)"; then
        ok "Infrastructure created"
        break
      fi
      if printf '%s' "$out" | grep -qiE 'out of host capacity|OutOfHostCapacity|capacity'; then
        warn "Capacity disappeared between the check and the launch in $AVAILABILITY_DOMAIN; trying another option."
        excluded="$excluded $AVAILABILITY_DOMAIN"
        attempt=$((attempt + 1))
        continue
      fi
      printf '%s\n' "$out" | tail -40 >&2
      die "terraform apply failed (see output above). No retry loop is attempted for non-capacity errors."
    done
    instance_exists || die "Gave up after 3 capacity-related failures. Nothing was left behind; re-run later or see the capacity notes in README.md."
  fi

  SERVER_IP="$(tf_output public_ip)"
  [ -n "$SERVER_IP" ] || die "Terraform did not return a public IP"
  ok "Server: $SERVER_IP ($(tf_output shape), $(tf_output availability_domain))"

  # A freshly created instance has a new host key; forget the old one.
  local id_file="$KEYS_DIR/instance-id" current
  current="$(tf_output instance_id)"
  if [ -f "$id_file" ] && [ "$(cat "$id_file")" != "$current" ]; then
    rm -f "$KNOWN_HOSTS_FILE"
  fi
  mkdir -p "$KEYS_DIR"; printf '%s' "$current" > "$id_file"
}

resolve_server_ip() {
  if [ -n "$SERVER_IP" ]; then return; fi
  if have_cmd terraform && [ -d "$TF_DIR/.terraform" ]; then
    SERVER_IP="$(tf_output public_ip)"
  fi
  [ -n "$SERVER_IP" ] || die "No server known. Run ./deploy.sh (or ./deploy.sh infra) first, or set SERVER_IP=<ip> in deploy.env for a server you created yourself."
}

# -----------------------------------------------------------------------------
# 4. Application deployment
# -----------------------------------------------------------------------------
APP_KEYS="PROXY_ALLOWED_DOMAINS PROXY_UNLISTED_URL_MODE PROXY_SHOW_ALLOWLIST PROXY_BANNER ADMIN_USERNAME ADMIN_PASSWORD SESSION_SECRET SESSION_TTL SESSION_MAX RATE_LIMIT RATE_LIMIT_WINDOW ADMIN_RATE_LIMIT MAX_RESPONSE_SIZE MAX_REQUEST_SIZE REQUEST_TIMEOUT CONNECT_TIMEOUT TRANSFER_TIMEOUT MAX_CONCURRENT_UPSTREAM LOG_LEVEL DOMAIN ACME_EMAIL"

# Compose the server-side .env: deploy.env values win, otherwise keep what the
# server already has (so generated secrets survive redeploys), otherwise
# generate secrets / fall back to application defaults.
build_remote_env() {
  local existing
  existing="$(remote "$SERVER_IP" "cat $APP_DIR/.env 2>/dev/null" || true)"
  existing_value() { printf '%s\n' "$existing" | sed -n "s/^$1=//p" | head -1; }

  local key value
  printf '# Generated by deploy.sh on %s — edit deploy.env locally instead of this file\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'NODE_ENV=production\nTRUST_PROXY=true\n'
  for key in $APP_KEYS; do
    value="${!key:-}"
    if [ -z "$value" ]; then value="$(existing_value "$key")"; fi
    if [ -z "$value" ]; then
      case "$key" in
        SESSION_SECRET) value="$(random_secret)" ;;
        ADMIN_PASSWORD)
          if [ -n "${ADMIN_USERNAME:-$(existing_value ADMIN_USERNAME)}" ]; then
            value="$(random_password)"; GENERATED_ADMIN_PASSWORD="$value"
          fi ;;
      esac
    fi
    [ -n "$value" ] && printf '%s=%s\n' "$key" "$value"
  done
}

deploy_app() {
  resolve_server_ip
  log "Deploying the application to $SERVER_IP"

  log "Uploading project files"
  tar -czf - \
    --exclude='./.git' --exclude='./node_modules' --exclude='./data' --exclude='./coverage' \
    --exclude='./.env' --exclude='./.env.*' --exclude='./deploy.env' \
    --exclude='./infra/keys' --exclude='./infra/terraform' \
    . | remote "$SERVER_IP" "mkdir -p $APP_DIR && tar -xzf - -C $APP_DIR && find $APP_DIR -name '*.sh' -exec chmod +x {} +"
  ok "Files uploaded"

  log "Writing server configuration (secrets never leave the server)"
  # build_remote_env must run in this shell (not a pipeline) so that
  # GENERATED_ADMIN_PASSWORD is visible to print_summary.
  local envfile
  envfile="$(mktemp)"
  build_remote_env > "$envfile"
  remote "$SERVER_IP" "umask 077 && cat > $APP_DIR/.env && chmod 600 $APP_DIR/.env" < "$envfile"
  rm -f "$envfile"
  ok "Configuration written to $APP_DIR/.env"

  log "Building and starting containers on the server"
  remote "$SERVER_IP" "APP_DIR=$APP_DIR bash -s" < infra/scripts/remote-deploy.sh
}

# -----------------------------------------------------------------------------
# 5. Verification from this machine
# -----------------------------------------------------------------------------
public_base_url() {
  if [ -n "${DOMAIN:-}" ]; then echo "https://$DOMAIN"; else echo "http://$SERVER_IP"; fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo "000"; }

verify_deployment() {
  resolve_server_ip
  local base; base="$(public_base_url)"
  log "Verifying $base from this machine"

  if [ -n "${DOMAIN:-}" ]; then
    local resolved
    resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    if [ -z "$resolved" ] && have_cmd nslookup; then resolved="$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address/ {a=$2} END {print a}')"; fi
    if [ -n "$resolved" ] && [ "$resolved" != "$SERVER_IP" ]; then
      warn "DNS: $DOMAIN resolves to $resolved but the server is $SERVER_IP. Point an A record at $SERVER_IP; Let's Encrypt cannot issue a certificate until then."
    fi
  fi

  local code i
  for i in $(seq 1 24); do
    code="$(http_code "$base/health")"
    [ "$code" = "200" ] && break
    [ "$i" -eq 1 ] && printf 'Waiting for %s/health (HTTPS certificate issuance can take a minute)' "$base"
    printf '.'
    sleep 5
  done
  echo
  if [ "$code" != "200" ]; then
    warn "$base/health returned $code."
    if [ -n "${DOMAIN:-}" ]; then
      local ipcode; ipcode="$(http_code -H "Host: $DOMAIN" "http://$SERVER_IP/health" -L -k)"
      warn "Via the IP with Host header the app answers $ipcode. If DNS is not pointing at $SERVER_IP yet, fix that and run ./deploy.sh verify again."
    fi
    return 1
  fi
  ok "Health: $(curl -s --max-time 20 "$base/health" | head -c 160)"

  # Allowlist + SSRF checks against the live deployment.
  local first_domain; first_domain="$(printf '%s' "${PROXY_ALLOWED_DOMAINS:-}" | tr ',' '\n' | grep -v '^\*' | head -1 | tr -d '[:space:]')"
  if [ -n "$first_domain" ]; then
    code="$(http_code -L "$base/open?url=https://$first_domain/")"
    case "$code" in 200|30*) ok "Allowlisted site $first_domain: HTTP $code" ;; *) warn "Allowlisted site $first_domain returned $code" ;; esac
  fi
  code="$(http_code "$base/open?url=https://definitely-not-allowed.example/")"
  if [ "$code" = "403" ]; then ok "Unlisted domain is refused (403)"; else warn "Unlisted domain returned $code (expected 403)"; fi
  for target in "http://169.254.169.254/latest/meta-data/" "http://127.0.0.1/" "http://localhost:8080/" "http://10.0.0.1/"; do
    code="$(http_code "$base/open?url=$target")"
    case "$code" in 400|403) ok "SSRF target $target refused ($code)" ;; *) warn "SSRF target $target returned $code (expected 400/403)" ;; esac
  done
  code="$(http_code "$base/admin")"
  case "$code" in 302|404) ok "Admin area is protected ($code without login)" ;; *) warn "/admin returned $code without login" ;; esac
}

print_summary() {
  resolve_server_ip
  local base; base="$(public_base_url)"
  hr
  printf '%s%sAnonView is deployed%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
  hr
  printf '  Public URL    : %s\n' "$base"
  [ -z "${DOMAIN:-}" ] && printf '                  (plain HTTP on the IP — set DOMAIN in deploy.env for HTTPS)\n'
  printf '  Health check  : %s/health\n' "$base"
  printf '  Admin         : %s/admin  (user: %s)\n' "$base" "${ADMIN_USERNAME:-<admin disabled>}"
  if [ -n "$GENERATED_ADMIN_PASSWORD" ]; then
    printf '  Admin password: %s   <- generated now, shown only once\n' "$GENERATED_ADMIN_PASSWORD"
    printf '                  (later: ./deploy.sh ssh, then: grep ADMIN_PASSWORD %s/.env)\n' "$APP_DIR"
  fi
  printf '  SSH           : ssh -i %s %s@%s\n' "$SSH_KEY_PATH" "$SSH_USER" "$SERVER_IP"
  printf '  Update app    : ./deploy.sh app\n'
  printf '  Diagnostics   : ./deploy.sh status   |   logs: ./deploy.sh logs\n'
  hr
}

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------
# Sourcing the script with DEPLOY_SH_LIBRARY_MODE=1 exposes the functions for tests.
if [ -n "${DEPLOY_SH_LIBRARY_MODE:-}" ]; then return 0 2>/dev/null || exit 0; fi

case "$COMMAND" in
  all)
    check_prereqs; ensure_ssh_key; check_oci_auth; provision_infra
    bash infra/scripts/wait-for-ssh.sh "$SERVER_IP" 900
    deploy_app; verify_deployment || true; print_summary ;;
  infra)
    check_prereqs; ensure_ssh_key; check_oci_auth; provision_infra
    bash infra/scripts/wait-for-ssh.sh "$SERVER_IP" 900
    ok "Server ready: ssh -i $SSH_KEY_PATH $SSH_USER@$SERVER_IP" ;;
  app)
    check_prereqs; ensure_ssh_key; deploy_app; verify_deployment || true; print_summary ;;
  verify)
    check_prereqs; verify_deployment ;;
  status)
    check_prereqs; resolve_server_ip
    remote "$SERVER_IP" "APP_DIR=$APP_DIR bash -s" < infra/scripts/remote-diagnostics.sh ;;
  logs)
    check_prereqs; resolve_server_ip
    remote "$SERVER_IP" -t "cd $APP_DIR && docker compose logs -f --tail=100" ;;
  ssh)
    check_prereqs; resolve_server_ip
    # shellcheck disable=SC2046
    exec ssh $(ssh_opts) "$SSH_USER@$SERVER_IP" ;;
  ip)
    load_deploy_env; resolve_server_ip; echo "$SERVER_IP" ;;
  *)
    usage 1 ;;
esac
