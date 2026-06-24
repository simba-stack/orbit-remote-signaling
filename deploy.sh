#!/usr/bin/env bash
# Orbit Remote — one-shot deploy of signaling + coturn on a Russian VPS.
# Run on a fresh Ubuntu 22/24 as root:
#   curl -fsSL https://raw.githubusercontent.com/simba-stack/orbit-remote-signaling/main/deploy.sh -o d.sh && bash d.sh
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

HOST="v3169940.hosted-by-vdsina.ru"
IP="138.16.173.208"
TURN_USER="orbit"
TURN_PASS="Orb1tRuTurn7xQz"

apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw docker.io apt-transport-https debian-keyring debian-archive-keyring

# --- Node 20 ---
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# --- Caddy (automatic HTTPS) ---
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

# --- Signaling app ---
rm -rf /opt/orbit-sig
git clone https://github.com/simba-stack/orbit-remote-signaling /opt/orbit-sig
cd /opt/orbit-sig
npm install --omit=dev || npm install || true

# Node listens on 0.0.0.0:8080 so BOTH wss (via Caddy) and plain ws://IP:8080 work.
cat >/opt/orbit-sig/.env <<EOF
PORT=8080
HOST=0.0.0.0
NODE_ENV=production
TURN_URLS=turn:${IP}:3478?transport=udp,turn:${IP}:3478?transport=tcp
TURN_USERNAME=${TURN_USER}
TURN_PASSWORD=${TURN_PASS}
EOF

cat >/etc/systemd/system/orbit-sig.service <<EOF
[Unit]
Description=Orbit signaling
After=network.target
[Service]
WorkingDirectory=/opt/orbit-sig
EnvironmentFile=/opt/orbit-sig/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now orbit-sig

# --- Caddy: TLS + reverse-proxy the websocket/API to the node app ---
cat >/etc/caddy/Caddyfile <<EOF
${HOST} {
	reverse_proxy /ws 127.0.0.1:8080
	reverse_proxy /health 127.0.0.1:8080
	reverse_proxy /ice-servers 127.0.0.1:8080
	respond "Orbit signaling OK" 200
}
EOF
systemctl restart caddy

# --- coturn (plain TURN over UDP+TCP, no TLS needed) ---
docker rm -f coturn 2>/dev/null || true
docker run -d --name coturn --restart always --network host coturn/coturn:4.6 \
	-n --no-cli --no-tls --no-dtls \
	--realm="${HOST}" --fingerprint --lt-cred-mech \
	--listening-port=3478 \
	--min-port=49160 --max-port=49200 \
	--external-ip="${IP}" \
	--user="${TURN_USER}:${TURN_PASS}"

# --- firewall ---
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8080/tcp
ufw allow 3478
ufw allow 49160:49200/udp
ufw --force enable || true

sleep 3
echo "==== health (local) ===="
curl -s http://127.0.0.1:8080/health || true
echo
echo "==== caddy status ===="
systemctl is-active caddy || true
echo "==== signaling status ===="
systemctl is-active orbit-sig || true
echo "==== coturn ===="
docker ps --filter name=coturn --format '{{.Status}}' || true
echo
echo "==== ORBIT_DEPLOY_DONE ===="
