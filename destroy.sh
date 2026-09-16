#!/usr/bin/env bash
# =============================================================================
# destroy.sh — tear down the Oracle Cloud infrastructure created by deploy.sh.
#
# Destroys: the compute instance (and its boot volume, including the Docker
# volumes holding the admin allowlist and Caddy certificates), the reserved
# public IP, subnet, security list, route table, internet gateway and VCN.
# Requires explicit confirmation. Nothing outside the Terraform state is touched.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=infra/scripts/lib.sh
. infra/scripts/lib.sh

load_deploy_env
need_cmd terraform

[ -d "$TF_DIR/.terraform" ] || tf init -input=false >/dev/null
if ! tf state list >/dev/null 2>&1 || [ -z "$(tf state list 2>/dev/null)" ]; then
  ok "Terraform state is empty — there is nothing to destroy."
  exit 0
fi

log "Verifying Oracle Cloud authentication"
eval "$(bash infra/scripts/oci-check-auth.sh)"

ip="$(tf_output public_ip)"
name="$(tf_output instance_name)"
hr
printf '%s%sThe following resources will be PERMANENTLY deleted:%s\n' "$C_BOLD" "$C_RED" "$C_RESET"
hr
tf state list | sed 's/^/  /'
hr
printf '  Instance : %s (%s)\n' "${name:-?}" "${ip:-no ip}"
printf '  Region   : %s\n' "$REGION"
printf '\nThis includes the boot volume, the admin-managed allowlist and the TLS\ncertificates. This cannot be undone.\n\n'

if [ "${FORCE:-}" != "yes" ]; then
  printf 'Type the instance name (%s) to confirm: ' "${name:-$INSTANCE_NAME}"
  read -r answer
  if [ "$answer" != "${name:-$INSTANCE_NAME}" ]; then
    die "Confirmation did not match — aborting, nothing was changed."
  fi
fi

log "Destroying infrastructure"
tf destroy -input=false -auto-approve
rm -f "$KNOWN_HOSTS_FILE" "$KEYS_DIR/instance-id" "$TF_DIR/generated.auto.tfvars.json"
ok "All resources destroyed. Terraform state is now empty."
