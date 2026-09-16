#!/usr/bin/env bash
# Verify Oracle Cloud authentication and discover tenancy / home region.
#
# Prints KEY=VALUE lines on stdout (TENANCY_OCID, HOME_REGION, REGION,
# COMPARTMENT_OCID, TENANCY_NAME) for consumption by deploy.sh; all
# human-readable messages go to stderr. Exits non-zero with precise
# instructions when credentials are missing.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

profile="${OCI_PROFILE:-DEFAULT}"

missing_credentials() {
  cat >&2 <<EOF

${C_RED}${C_BOLD}Oracle Cloud credentials are not available on this machine.${C_RESET}

I cannot create an Oracle account or sign up for you. To let the automation
provision the server, provide API-key credentials for your tenancy:

  1. Sign in to https://cloud.oracle.com → Profile (top right) → "My profile"
     → "API keys" → "Add API key" → "Generate API key pair".
     Download the PRIVATE key (e.g. ~/.oci/oci_api_key.pem) and click "Add".
  2. Copy the "Configuration file preview" Oracle shows you into
     ~/.oci/config (create the folder if needed). It looks like:

        [DEFAULT]
        user=ocid1.user.oc1..aaaa...
        fingerprint=aa:bb:cc:...
        tenancy=ocid1.tenancy.oc1..aaaa...
        region=eu-frankfurt-1
        key_file=~/.oci/oci_api_key.pem

  3. Make the private key readable only by you (chmod 600 on Linux/macOS).
  4. Install the OCI CLI (used for capacity checks) and Terraform:
        Windows:  winget install Oracle.OCI-CLI ; winget install Hashicorp.Terraform
        macOS:    brew install oci-cli terraform
        Linux:    see README.md → "Creating OCI credentials"
  5. Re-run ./deploy.sh

Detected state:
  config file : $OCI_CONFIG_FILE  ($( [ -f "$OCI_CONFIG_FILE" ] && echo present || echo missing ))
  profile     : $profile
  oci CLI     : $( have_cmd oci && echo present || echo missing )
  terraform   : $( have_cmd terraform && echo present || echo missing )
EOF
  exit 2
}

[ -f "$OCI_CONFIG_FILE" ] || missing_credentials

tenancy="$(oci_config_value "$profile" tenancy || true)"
region="$(oci_config_value "$profile" region || true)"
user="$(oci_config_value "$profile" user || true)"
key_file="$(oci_config_value "$profile" key_file || true)"
key_file="${key_file/#\~/$HOME}"

if [ -z "$tenancy" ] || [ -z "$user" ] || [ -z "$key_file" ]; then
  warn "Profile [$profile] in $OCI_CONFIG_FILE is incomplete (need user, tenancy, key_file, fingerprint, region)."
  missing_credentials
fi
[ -f "$key_file" ] || { warn "Private key referenced by key_file does not exist: $key_file"; missing_credentials; }

log "OCI config found: profile [$profile], tenancy ${tenancy:0:28}…, region ${region:-?}" >&2

have_cmd oci || {
  warn "The OCI CLI is not installed. It is required for the auth check and the A1 capacity check."
  missing_credentials
}

# Live authentication check.
tenancy_name="$(oci --profile "$profile" iam tenancy get --tenancy-id "$tenancy" --query 'data.name' --raw-output 2>/tmp/oci-auth-err.$$ || true)"
if [ -z "$tenancy_name" ]; then
  warn "Authentication against OCI failed:"
  sed 's/^/    /' /tmp/oci-auth-err.$$ >&2 || true
  rm -f /tmp/oci-auth-err.$$
  cat >&2 <<EOF

  Common causes: wrong fingerprint, private key not matching the uploaded
  public key, a user without permissions, or a clock that is off by more
  than 5 minutes.
EOF
  exit 2
fi
rm -f /tmp/oci-auth-err.$$
ok "Authenticated to tenancy \"$tenancy_name\"" >&2

home_region="$(oci --profile "$profile" iam region-subscription list --tenancy-id "$tenancy" \
  --query 'data[?"is-home-region"] | [0]."region-name"' --raw-output 2>/dev/null || true)"
[ -n "$home_region" ] && [ "$home_region" != "null" ] || home_region="$region"

target_region="${OCI_REGION:-$home_region}"
if [ "$target_region" != "$home_region" ]; then
  warn "OCI_REGION=$target_region differs from the home region $home_region. Always Free compute is only available in the home region."
fi
ok "Home region: $home_region (deploying to $target_region)" >&2

compartment="${OCI_COMPARTMENT_OCID:-$tenancy}"

printf 'TENANCY_OCID=%s\n' "$tenancy"
printf 'TENANCY_NAME=%s\n' "$tenancy_name"
printf 'HOME_REGION=%s\n' "$home_region"
printf 'REGION=%s\n' "$target_region"
printf 'COMPARTMENT_OCID=%s\n' "$compartment"
printf 'OCI_USER_OCID=%s\n' "$user"
