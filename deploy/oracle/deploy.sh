#!/bin/bash
# Oracle Cloud Always Free (Singapore) — KazumiWeb one-shot deploy.
# Run ON the Oracle VM (Ubuntu 24.04, Ampere A1 ARM, 1 OCPU / 6 GB)
# as a user with sudo. It is idempotent: safe to re-run after a code push.
#
# What it does:
#   1. installs runtime deps (xvfb, libwebkit2gtk-4.1, libayatana-appindicator3,
#      python3, ffmpeg, curl, git)
#   2. downloads upstream KazumiWeb v0.2.0 linux-arm64 tarball, verifies sha256
#   3. installs it to /opt/kazumiweb, overlays this repo's web/ + subs/
#      (custom frontend, subtitle sidecar) and start script
#   4. installs + enables the kazumiweb systemd service (auto-restart)
#   5. opens firewall ports (ufw) for SSH/HTTP/HTTPS
#
# Usage:
#   git clone https://github.com/y7j6nfnzn7-cloud/kazumi.git ~/kazumi
#   cd ~/kazumi/deploy/oracle && sudo bash deploy.sh
#   # then: ./reinstall-rules.sh http://<vm-public-ip>:10000   (or the tunnel URL)
set -euo pipefail

APP_DIR="/opt/kazumiweb"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARBALL_URL="https://github.com/0Chencc/KazumiWeb/releases/download/v0.2.0/KazumiWeb-v0.2.0-linux-arm64.tar.gz"
# sha256 recorded 2026-11-09 when the tarball was fetched and verified
# (ELF64 AArch64, layout identical to the x64 release).
TARBALL_SHA256="3bd29fc438bd6d880b38d0af5e49260ef8cde4ce3aae2f07f3f55d638f6384c4"

echo "== 1/5 apt deps =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
  xvfb libwebkit2gtk-4.1-0 libayatana-appindicator3-1 \
  curl ca-certificates python3 ffmpeg git ufw

echo "== 2/5 upstream arm64 tarball =="
mkdir -p /tmp/kazumi-dl
cd /tmp/kazumi-dl
if [ ! -f KazumiWeb-v0.2.0-linux-arm64.tar.gz ]; then
  curl -L -o KazumiWeb-v0.2.0-linux-arm64.tar.gz "$TARBALL_URL"
fi
echo "$TARBALL_SHA256  KazumiWeb-v0.2.0-linux-arm64.tar.gz" | sha256sum -c -

echo "== 3/5 install to $APP_DIR =="
mkdir -p "$APP_DIR"
tar -xzf KazumiWeb-v0.2.0-linux-arm64.tar.gz -C "$APP_DIR" --strip-components=1 --no-same-owner
chmod +x "$APP_DIR/kazumi_web"
# Overlay this repo's custom frontend + subtitle sidecar (same as Dockerfile).
cp -r "$REPO_DIR/web/." "$APP_DIR/web/"
cp -r "$REPO_DIR/subs/." "$APP_DIR/subs/"
cp "$REPO_DIR/deploy/oracle/run.sh" "$APP_DIR/run.sh"
cp "$REPO_DIR/deploy/oracle/kazumiweb.service" /etc/systemd/system/kazumiweb.service
chmod +x "$APP_DIR/run.sh"
# VTT subtitle cache + skip-report files live under subs/; keep them.
mkdir -p "$APP_DIR/subs/cache"
# Rules are installed at runtime via API and wiped on redeploy — they are
# NOT stored here. Run reinstall-rules.sh after the service is up.

echo "== 4/5 systemd service =="
systemctl daemon-reload
systemctl enable kazumiweb.service
systemctl restart kazumiweb.service
sleep 3
systemctl status kazumiweb.service --no-pager | head -20

echo "== 5/5 firewall =="
ufw allow 22/tcp  || true
ufw allow 80/tcp  || true
ufw allow 443/tcp || true
ufw allow 10000/tcp || true
ufw --force enable || true

echo
echo "== done =="
echo "Check: curl -s -o /dev/null -w 'homepage HTTP %{http_code}\n' http://127.0.0.1:10000/"
echo "Then reinstall rules: $REPO_DIR/deploy/oracle/reinstall-rules.sh http://<vm-public-ip>:10000"
echo "For HTTPS (recommended for iPhone Add-to-Home-Screen), see cloudflared-tunnel.sh"
