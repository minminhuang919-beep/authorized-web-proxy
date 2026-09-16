#!/usr/bin/env bash
# Offline self-test for deploy.sh: exercises the file upload and server .env
# composition against a *local* fake server directory (no SSH, no OCI).
# Run: bash infra/scripts/selftest-deploy.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fake_server="$(mktemp -d)"
trap 'rm -rf "$fake_server"' EXIT

export DEPLOY_ENV_FILE="$fake_server/deploy.env"
cat > "$DEPLOY_ENV_FILE" <<EOF
PROXY_ALLOWED_DOMAINS=example.com,*.example.org
ADMIN_USERNAME=admin
DOMAIN=proxy.example.net
ACME_EMAIL=ops@example.net
RATE_LIMIT=120
APP_DIR=$fake_server/opt/anonview
SERVER_IP=203.0.113.10
SSH_KEY_PATH=$fake_server/key
EOF
ssh-keygen -q -t ed25519 -N "" -f "$fake_server/key"

export DEPLOY_SH_LIBRARY_MODE=1
# shellcheck source=../../deploy.sh
. ./deploy.sh app
unset DEPLOY_SH_LIBRARY_MODE

# Replace SSH with local execution.
remote() { shift; bash -c "$*"; }

check_prereqs >/dev/null
resolve_server_ip

echo "==> upload"
tar -czf - \
  --exclude='./.git' --exclude='./node_modules' --exclude='./data' --exclude='./coverage' \
  --exclude='./.env' --exclude='./.env.*' --exclude='./deploy.env' \
  --exclude='./infra/keys' --exclude='./infra/terraform' \
  . | remote "$SERVER_IP" "mkdir -p $APP_DIR && tar -xzf - -C $APP_DIR && find $APP_DIR -name '*.sh' -exec chmod +x {} +"
for f in package.json src/server.js docker-compose.yml Dockerfile deploy/caddy/Caddyfile infra/scripts/remote-deploy.sh; do
  [ -f "$APP_DIR/$f" ] || { echo "MISSING after upload: $f"; exit 1; }
done
for f in node_modules .git infra/terraform deploy.env .env; do
  [ ! -e "$APP_DIR/$f" ] || { echo "MUST NOT be uploaded: $f"; exit 1; }
done
echo " ✔ upload contains the app and excludes secrets/state"

echo "==> first .env generation"
build_remote_env > "$fake_server/env1"
remote "$SERVER_IP" "umask 077 && cat > $APP_DIR/.env" < "$fake_server/env1"
env1="$(cat "$APP_DIR/.env")"
grep -q '^NODE_ENV=production$' <<<"$env1"
grep -q '^TRUST_PROXY=true$' <<<"$env1"
grep -q '^PROXY_ALLOWED_DOMAINS=example.com,\*.example.org$' <<<"$env1"
grep -q '^DOMAIN=proxy.example.net$' <<<"$env1"
grep -q '^RATE_LIMIT=120$' <<<"$env1"
grep -Eq '^SESSION_SECRET=[0-9a-f]{64}$' <<<"$env1"
grep -Eq '^ADMIN_PASSWORD=[A-HJ-NP-Za-km-z2-9]{20}$' <<<"$env1"
[ -n "$GENERATED_ADMIN_PASSWORD" ]
secret1="$(sed -n 's/^SESSION_SECRET=//p' <<<"$env1")"
pass1="$(sed -n 's/^ADMIN_PASSWORD=//p' <<<"$env1")"
echo " ✔ secrets generated, settings copied"

echo "==> second run keeps generated secrets, applies changed settings"
GENERATED_ADMIN_PASSWORD=""
RATE_LIMIT=300
build_remote_env > "$fake_server/env2"
remote "$SERVER_IP" "umask 077 && cat > $APP_DIR/.env" < "$fake_server/env2"
env2="$(cat "$APP_DIR/.env")"
[ "$(sed -n 's/^SESSION_SECRET=//p' <<<"$env2")" = "$secret1" ] || { echo "SESSION_SECRET was regenerated"; exit 1; }
[ "$(sed -n 's/^ADMIN_PASSWORD=//p' <<<"$env2")" = "$pass1" ] || { echo "ADMIN_PASSWORD was regenerated"; exit 1; }
grep -q '^RATE_LIMIT=300$' <<<"$env2"
[ -z "$GENERATED_ADMIN_PASSWORD" ]
echo " ✔ redeploy is idempotent for secrets"

echo "==> the generated .env is accepted by the application's config loader"
(
  cd "$APP_DIR"
  node -e "
    process.loadEnvFile('.env');
    const { loadConfig } = await import('./src/config.js');
    const c = loadConfig(process.env);
    if (!c.admin.enabled || c.rateLimit !== 300 || !c.trustProxy || c.allowedDomains.length !== 2) throw new Error('unexpected config ' + JSON.stringify(c));
    console.log(' ✔ config loads: admin enabled, allowlist', c.allowedDomains.join(','));
  " --input-type=module
)
echo "✔ deploy.sh self-test passed"
