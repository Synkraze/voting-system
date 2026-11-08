#!/usr/bin/env bash
#
# Deploy the voting app to the VPS: package the project, upload it, and swap it
# in on the server (backup -> unpack -> npm ci -> restart -> health check).
#
# Run from your own machine (Git Bash / WSL / Linux / macOS):
#     ./deploy/deploy.sh
#
# ssh will prompt for the root password. To avoid the prompt, add your SSH key
# to the server once (ssh-copy-id) or set up an ssh config Host entry.
#
# Overridable via environment variables:
#     VPS_HOST   target (default root@187.127.214.127)
#     APP_DIR    app directory on the server (default /opt/voting)
#     SERVICE    systemd unit name (default voting)
#     PORT       local port the app listens on (default 3000)
#
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@187.127.214.127}"
APP_DIR="${APP_DIR:-/opt/voting}"
SERVICE="${SERVICE:-voting}"
PORT="${PORT:-3000}"
# Don't fail on a missing/changed host key for this known server (set your own
# SSH_OPTS to override, e.g. to pin the key via a proper known_hosts entry).
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null}"

# Project root = the directory that holds src/ and public/ (one level up from this script).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
NAME="$(basename "$ROOT")"
TARBALL="$ROOT/../${NAME}-deploy.tgz"

cleanup() { rm -f "$TARBALL"; }
trap cleanup EXIT

echo "==> Packaging $ROOT (excluding node_modules, secrets, .git)"
tar -czf "$TARBALL" -C "$ROOT/.." \
  --exclude="$NAME/node_modules" \
  --exclude="$NAME/Deployment_Tar" \
  --exclude="$NAME/.git" \
  --exclude="$NAME/.env" \
  --exclude="$NAME/keys" \
  --exclude="$NAME/candidate pics" \
  --exclude="$NAME/Voting.zip" \
  --exclude="$NAME/${NAME}-deploy.tgz" \
  "$NAME"
echo "    $(du -h "$TARBALL" | cut -f1) packaged"

echo "==> Uploading to ${VPS_HOST}:/root/${NAME}-deploy.tgz"
scp $SSH_OPTS "$TARBALL" "${VPS_HOST}:/root/${NAME}-deploy.tgz"

echo "==> Deploying on ${VPS_HOST}"
# Config is passed as positional args so the heredoc below stays literal (no local expansion).
ssh $SSH_OPTS "$VPS_HOST" 'bash -s' -- "$APP_DIR" "$SERVICE" "$NAME" "$PORT" <<'REMOTE'
set -e
APP_DIR="$1"; SERVICE="$2"; NAME="$3"; PORT="$4"

systemctl stop "$SERVICE" 2>/dev/null || true

ts=$(date +%Y%m%d-%H%M%S)
cp -a "$APP_DIR" "${APP_DIR}.bak-$ts"
echo "    backup: ${APP_DIR}.bak-$ts"

# Preserve the irreplaceable, server-local state (NOT in the code tarball):
# the signing key, the .env, AND the candidate photos in uploads/.
cp "$APP_DIR/.env" /root/voting-env.keep 2>/dev/null || true
cp -a "$APP_DIR/keys" /root/voting-keys.keep 2>/dev/null || true
rm -rf /root/voting-uploads.keep
cp -a "$APP_DIR/uploads" /root/voting-uploads.keep 2>/dev/null || true

rm -rf /tmp/voting-new; mkdir -p /tmp/voting-new
tar xzf "/root/${NAME}-deploy.tgz" -C /tmp/voting-new

rm -rf "$APP_DIR"/*
cp -a "/tmp/voting-new/$NAME/." "$APP_DIR/"

[ -d /root/voting-keys.keep ] && cp -aT /root/voting-keys.keep "$APP_DIR/keys"
[ -d /root/voting-uploads.keep ] && mkdir -p "$APP_DIR/uploads" && cp -aT /root/voting-uploads.keep "$APP_DIR/uploads"
[ -f /root/voting-env.keep ] && cp /root/voting-env.keep "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true
chown -R voting:voting "$APP_DIR"

cd "$APP_DIR"
echo "    npm ci (rebuilds native deps on the server)"
sudo -u voting npm ci --omit=dev

systemctl reset-failed "$SERVICE" 2>/dev/null || true
systemctl start "$SERVICE"

# Wait for the app to answer before declaring success.
code=000
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/info" || true)
  [ "$code" = "200" ] && break
  sleep 2
done

echo "    service: $(systemctl is-active "$SERVICE")   /info: $code"
echo "    verify : $(curl -s "http://localhost:${PORT}/verify" || echo 'unreachable')"
nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "    nginx reloaded"

if [ "$code" != "200" ]; then
  echo "    !! app did not return 200 — check: journalctl -u ${SERVICE} -n 40 --no-pager"
  echo "    !! rollback: systemctl stop ${SERVICE} && rm -rf ${APP_DIR} && mv ${APP_DIR}.bak-${ts} ${APP_DIR} && systemctl start ${SERVICE}"
  exit 1
fi
REMOTE

echo "==> Done. Deployed $NAME to $VPS_HOST."
