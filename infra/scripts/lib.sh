#!/usr/bin/env bash
# Shared helpers for deploy.sh / destroy.sh and the infra scripts.
# Works in bash on Linux, macOS and Git Bash on Windows.

set -o pipefail

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034  # colour variables are used by the sourcing scripts
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

log()   { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()    { printf '%s ✔ %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s ! %s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf '%s ✖ %s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
hr()    { printf '%s\n' "----------------------------------------------------------------------"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1${2:+ — $2}"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$ROOT_DIR/infra/terraform"
KEYS_DIR="$ROOT_DIR/infra/keys"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT_DIR/deploy.env}"

# ---------------------------------------------------------------------------
# deploy.env loading (KEY=VALUE lines, # comments, no shell expansion)
# ---------------------------------------------------------------------------
load_deploy_env() {
  if [ ! -f "$DEPLOY_ENV_FILE" ]; then
    die "Missing $DEPLOY_ENV_FILE — copy deploy.env.example to deploy.env and fill it in."
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -z "$key" ] && continue
    # strip surrounding quotes
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Values already present in the environment win (CI overrides).
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$DEPLOY_ENV_FILE"

  # Defaults
  : "${OCI_PROFILE:=DEFAULT}"
  : "${INSTANCE_NAME:=anonview-proxy}"
  : "${INSTANCE_SHAPE:=VM.Standard.A1.Flex}"
  : "${INSTANCE_OCPUS:=2}"
  : "${INSTANCE_MEMORY_GB:=12}"
  : "${BOOT_VOLUME_GB:=50}"
  : "${ALLOW_X86_FALLBACK:=false}"
  : "${RESERVED_PUBLIC_IP:=true}"
  : "${SSH_KEY_PATH:=$HOME/.ssh/anonview}"
  : "${SSH_ALLOWED_CIDR:=0.0.0.0/0}"
  : "${SSH_USER:=ubuntu}"
  : "${APP_DIR:=/opt/anonview}"
  SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"
  export OCI_PROFILE INSTANCE_NAME INSTANCE_SHAPE INSTANCE_OCPUS INSTANCE_MEMORY_GB BOOT_VOLUME_GB ALLOW_X86_FALLBACK \
         RESERVED_PUBLIC_IP SSH_KEY_PATH SSH_ALLOWED_CIDR SSH_USER APP_DIR
}

# ---------------------------------------------------------------------------
# OCI config (~/.oci/config) parsing — no OCI CLI needed for this part
# ---------------------------------------------------------------------------
OCI_CONFIG_FILE="${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}"

oci_config_value() { # oci_config_value <profile> <key>
  local profile="$1" key="$2"
  [ -f "$OCI_CONFIG_FILE" ] || return 1
  awk -v profile="$profile" -v key="$key" '
    /^[[:space:]]*\[/ { in_section = ($0 ~ "^[[:space:]]*\\[" profile "\\][[:space:]]*$") ; next }
    in_section && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", ""); sub("[[:space:]]+$", ""); print; exit
    }' "$OCI_CONFIG_FILE"
}

# ---------------------------------------------------------------------------
# Terraform helpers
# ---------------------------------------------------------------------------
tf() { terraform -chdir="$TF_DIR" "$@"; }

tf_output() { # tf_output <name> → raw value or empty
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------
KNOWN_HOSTS_FILE="$KEYS_DIR/known_hosts"

ssh_opts() {
  mkdir -p "$KEYS_DIR"
  printf '%s' "-i $SSH_KEY_PATH -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KNOWN_HOSTS_FILE -o ConnectTimeout=15 -o ServerAliveInterval=30 -o LogLevel=ERROR"
}

remote() { # remote <ip> <command...>
  local ip="$1"; shift
  # shellcheck disable=SC2046
  ssh $(ssh_opts) "$SSH_USER@$ip" "$@"
}

# Generate a random secret without printing it anywhere.
random_secret() {
  if have_cmd openssl; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    die "No source of randomness available (need openssl or /dev/urandom)"
  fi
}

random_password() {
  # 20 chars from an unambiguous alphabet. `cut` (not `head -c`) so that no
  # writer in the pipeline is killed by SIGPIPE under `pipefail`.
  if have_cmd openssl; then
    openssl rand -base64 96 | tr -dc 'A-HJ-NP-Za-km-z2-9' | cut -c1-20
  else
    head -c 256 /dev/urandom | tr -dc 'A-HJ-NP-Za-km-z2-9' | cut -c1-20
  fi
}
