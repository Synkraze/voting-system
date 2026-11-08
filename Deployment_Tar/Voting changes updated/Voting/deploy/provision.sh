#!/usr/bin/env bash
# One-shot provisioning for the Campus Election app on a fresh Ubuntu VPS.
# Run as root ON THE VPS, AFTER you have:
#   1. Uploaded the app to /opt/voting  (scp -r . root@IP:/opt/voting)
#   2. Created /opt/voting/.env with DATABASE_URL, SMTP_*, ADMIN_USER, ADMIN_PASS
#   3. Pointed voting.uwlelection.tech (A record) at this server's IP
#
# Usage:  sudo bash /opt/voting/deploy/provision.sh
set -euo pipefail

DOMAIN="voting.uwlelection.tech"
APP_DIR="/opt/voting"
CERTBOT_EMAIL="electionuwl@gmail.com"   # for Let's Encrypt expiry notices

echo "==> Checking app files..."
[ -f "$APP_DIR/package.json" ] || { echo "ERROR: $APP_DIR/package.json not found. Upload the app first."; exit 1; }
[ -f "$APP_DIR/.env" ]         || { echo "ERROR: $APP_DIR/.env not found. Create it first (DB/SMTP/admin)."; exit 1; }

echo "==> Installing Node 20, nginx, certbot..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y nginx certbot python3-certbot-nginx ufw

echo "==> Creating service user..."
id -u voting >/dev/null 2>&1 || adduser --system --group --home "$APP_DIR" voting
chown -R voting:voting "$APP_DIR"
chmod 600 "$APP_DIR/.env" || true

echo "==> Installing dependencies..."
cd "$APP_DIR"
sudo -u voting npm ci --omit=dev

echo "==> Generating signing key (once)..."
if [ ! -f "$APP_DIR/keys/server_ed25519.pem" ]; then
  sudo -u voting npm run keygen
else
  echo "    keys/server_ed25519.pem already exists — leaving it in place."
fi

echo "==> Installing systemd service..."
cat >/etc/systemd/system/voting.service <<UNIT
[Unit]
Description=Campus Election voting server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=voting
Group=voting
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now voting
sleep 2
systemctl --no-pager --full status voting | head -n 8 || true

echo "==> Configuring nginx..."
cat >/etc/nginx/sites-available/voting <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    client_max_body_size 5m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/voting /etc/nginx/sites-enabled/voting
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Firewall..."
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
yes | ufw enable || true

echo "==> Requesting HTTPS certificate (needs DNS pointing here already)..."
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect; then
  echo "    TLS installed."
else
  echo "    certbot failed — usually DNS not propagated yet. Re-run later:"
  echo "    sudo certbot --nginx -d $DOMAIN --agree-tos -m $CERTBOT_EMAIL --redirect"
fi

echo
echo "==> DONE."
echo "    App:    https://$DOMAIN/"
echo "    Admin:  https://$DOMAIN/admin.html  (login: PollAdmin)"
echo "    Logs:   journalctl -u voting -f"
