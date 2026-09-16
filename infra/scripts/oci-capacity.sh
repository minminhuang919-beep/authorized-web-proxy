#!/usr/bin/env bash
# Find an availability domain (and shape configuration) with free capacity
# for the requested Always Free shape, using OCI's Compute Capacity Report
# API. This avoids blindly creating instances and hitting
# "Out of host capacity" errors.
#
# Usage: oci-capacity.sh <compartment-ocid> <tenancy-ocid> <region>
# Prints KEY=VALUE lines (AVAILABILITY_DOMAIN, SHAPE, OCPUS, MEMORY_GB) on
# stdout when something is available; exits 3 when nothing is.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

compartment="$1"
tenancy="$2"
region="$3"
profile="${OCI_PROFILE:-DEFAULT}"

need_cmd oci "install the OCI CLI to run capacity checks"

# Availability domains of the home region, newline separated.
mapfile -t ads < <(oci --profile "$profile" --region "$region" iam availability-domain list \
  --compartment-id "$tenancy" --query 'join(`"\n"`, data[].name)' --raw-output 2>/dev/null)
[ "${#ads[@]}" -gt 0 ] || die "Could not list availability domains in $region"
# Availability domains where a launch just failed can be excluded by the caller.
if [ -n "${EXCLUDE_ADS:-}" ]; then
  filtered=()
  for ad in "${ads[@]}"; do
    case " $EXCLUDE_ADS " in *" $ad "*) ;; *) filtered+=("$ad") ;; esac
  done
  ads=("${filtered[@]}")
  [ "${#ads[@]}" -gt 0 ] || die "All availability domains were excluded after failed launches"
fi
log "Availability domains in $region: ${ads[*]}" >&2

# Candidate configurations, in order of preference. The requested size comes
# first; smaller A1 sizes are tried because a host may have room for fewer
# cores. The x86 Always Free micro shape is only tried when explicitly allowed.
candidates=()
if [ "$INSTANCE_SHAPE" = "VM.Standard.A1.Flex" ]; then
  candidates+=("VM.Standard.A1.Flex|$INSTANCE_OCPUS|$INSTANCE_MEMORY_GB")
  if [ "$INSTANCE_OCPUS" -gt 1 ]; then
    candidates+=("VM.Standard.A1.Flex|1|6")
  fi
else
  candidates+=("$INSTANCE_SHAPE|$INSTANCE_OCPUS|$INSTANCE_MEMORY_GB")
fi
if [ "${ALLOW_X86_FALLBACK,,}" = "true" ] && [ "$INSTANCE_SHAPE" != "VM.Standard.E2.1.Micro" ]; then
  candidates+=("VM.Standard.E2.1.Micro|1|1")
fi

report() { # report <ad> <shape> <ocpus> <mem> → availability status
  local ad="$1" shape="$2" ocpus="$3" mem="$4" body
  if [[ "$shape" == *.Flex ]]; then
    body="[{\"instanceShape\":\"$shape\",\"instanceShapeConfig\":{\"ocpus\":$ocpus,\"memoryInGBs\":$mem}}]"
  else
    body="[{\"instanceShape\":\"$shape\"}]"
  fi
  oci --profile "$profile" --region "$region" compute compute-capacity-report create \
    --compartment-id "$compartment" --availability-domain "$ad" \
    --shape-availabilities "$body" \
    --query 'data."shape-availabilities"[0]."availability-status"' --raw-output 2>/dev/null || echo "ERROR"
}

hr >&2
summary=()
for candidate in "${candidates[@]}"; do
  IFS='|' read -r shape ocpus mem <<< "$candidate"
  for ad in "${ads[@]}"; do
    status="$(report "$ad" "$shape" "$ocpus" "$mem")"
    printf '  %-34s %-26s %s\n' "$shape ${ocpus}x OCPU ${mem} GB" "$ad" "$status" >&2
    summary+=("$shape ${ocpus}/${mem}GB @ $ad: $status")
    if [ "$status" = "AVAILABLE" ]; then
      hr >&2
      ok "Capacity available: $shape (${ocpus} OCPU, ${mem} GB) in $ad" >&2
      printf 'AVAILABILITY_DOMAIN=%s\nSHAPE=%s\nOCPUS=%s\nMEMORY_GB=%s\n' "$ad" "$shape" "$ocpus" "$mem"
      exit 0
    fi
  done
done
hr >&2

cat >&2 <<EOF

${C_RED}${C_BOLD}No Always Free capacity is available right now.${C_RESET}

Checked configurations:
$(printf '  - %s\n' "${summary[@]}")

What this means
  Oracle's Always Free Ampere A1 hosts are heavily oversubscribed in most
  regions. "OUT_OF_HOST_CAPACITY" is not an error in your setup — the region
  simply has no free ARM cores at the moment. Nothing was created.

What you can do
  1. Simply re-run ./deploy.sh later (capacity is released and taken all day;
     early mornings in the region's local time tend to be better). The script
     never creates instances blindly, so retrying is safe and cheap.
  2. Upgrade the account to Pay As You Go (adds a card, but Always Free
     resources stay free). PAYG tenancies get capacity far more often.
  3. Allow the x86 fallback: set ALLOW_X86_FALLBACK=true in deploy.env to use
     the Always Free VM.Standard.E2.1.Micro shape (1/8 OCPU, 1 GB RAM). The
     application image is multi-arch, so it runs there too — just slower.
  4. Check https://cloud.oracle.com → Compute → Instances → Create instance
     to see the live capacity message for your home region.
EOF
exit 3
