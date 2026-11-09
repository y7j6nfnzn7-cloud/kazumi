#!/bin/bash
# Optional HTTPS for the Oracle VM via Cloudflare Tunnel (free, no card).
# Gives a public https://<tunnel-id>.cfargotunnel.com URL without opening
# any inbound port (tunnel is outbound-only) and without buying a domain.
# HTTPS is what iPhone Safari needs for "Add to Home Screen" PWA install.
#
# Prerequisites (needs the USER, one time, in a browser):
#   1. A Cloudflare account (free). Log in at dash.cloudflare.com with
#      Google (a2263382141@gmail.com). Free plan only, no card, no marketing.
#   2. Run `cloudflared tunnel login` on the VM and open the printed URL
#      in the browser to authorize it (creates ~/.cloudflared/cert.pem).
#   3. If the account has no domain, the tunnel's own
#      https://<tunnel-id>.cfargotunnel.com address is used (verify it
#      opens; if it 404s, a domain is required — do NOT buy one without
#      the user's explicit confirmation).
#
# Usage on the VM (after login step 2):
#   sudo bash cloudflared-tunnel.sh            # creates tunnel + systemd service
#   # then check: curl -s -o /dev/null -w '%{http_code}\n' https://<id>.cfargotunnel.com/
set -euo pipefail

if [ ! -f ~/.cloudflared/cert.pem ]; then
  echo "ERROR: ~/.cloudflared/cert.pem missing — run 'cloudflared tunnel login' first" >&2
  echo "and open the printed URL in a browser (Google login, free plan only)." >&2
  exit 1
fi

# Install cloudflared if missing (ARM64 .deb from Cloudflare).
if ! command -v cloudflared >/dev/null 2>&1; then
  cd /tmp
  curl -L -o cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  dpkg -i cloudflared.deb || apt-get install -f -y
fi

TUNNEL_NAME="kazumiweb"
if [ ! -f ~/.cloudflared/*.json ] || ! cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$0 ~ n {print $1; exit}')"
if [ -z "$TUNNEL_ID" ]; then
  echo "ERROR: could not find tunnel $TUNNEL_NAME" >&2
  exit 1
fi

# Route the tunnel to the local proxy front door (port 10000).
cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_ID.cfargotunnel.com" 2>/dev/null || true

mkdir -p /etc/cloudflared
cat > /etc/cloudflared/config.yml <<EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $TUNNEL_ID.cfargotunnel.com
    service: http://127.0.0.1:10000
  - service: http_status:404
EOF

cloudflared service install || true
systemctl enable cloudflared 2>/dev/null || true
systemctl restart cloudflared 2>/dev/null || cloudflared tunnel run "$TUNNEL_NAME" &
echo "Tunnel URL: https://$TUNNEL_ID.cfargotunnel.com"
echo "Verify: curl -s -o /dev/null -w 'homepage HTTP %{http_code}\n' https://$TUNNEL_ID.cfargotunnel.com/"
