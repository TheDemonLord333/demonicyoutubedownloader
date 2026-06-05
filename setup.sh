#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Demonic YouTube Downloader — Server Setup Script
#  Run as root (or with sudo) on a fresh Ubuntu/Debian server.
#  Usage: sudo bash setup.sh YOUR_DOMAIN
# ─────────────────────────────────────────────────────────────

set -e

DOMAIN="${1:?Usage: sudo bash setup.sh YOUR_DOMAIN}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_PORT=3003

echo "=== [1/6] Installing system packages ==="
apt-get update -q
apt-get install -y nginx certbot python3-certbot-nginx curl

echo "=== [2/6] Installing Node.js 20 (if missing) ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "=== [3/6] Installing npm dependencies ==="
cd "$APP_DIR"
npm install --production

echo "=== [4/6] Configuring Nginx for $DOMAIN ==="
NGINX_CONF="/etc/nginx/sites-available/demonic-downloader"
cp "$APP_DIR/nginx.conf" "$NGINX_CONF"
sed -i "s/YOUR_DOMAIN/$DOMAIN/g" "$NGINX_CONF"

# Enable site
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/demonic-downloader
# Remove default if present
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

echo "=== [5/6] Obtaining SSL certificate with Certbot ==="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --redirect

echo "=== [6/6] Creating systemd service ==="
cat > /etc/systemd/system/demonic-downloader.service <<EOF
[Unit]
Description=Demonic YouTube Downloader
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=demonic-downloader

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now demonic-downloader

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Demonic YouTube Downloader is LIVE!                ║"
echo "║   https://$DOMAIN                                    ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  systemctl status demonic-downloader"
echo "  journalctl -u demonic-downloader -f"
echo "  systemctl restart demonic-downloader"
