#!/usr/bin/env bash
# SareChild VPS bootstrap â€” run as root on 107.170.15.179 (or set EXTERNAL_IP).
# Usage: scp scripts/vps/bootstrap.sh root@HOST:/tmp/ && ssh root@HOST bash /tmp/bootstrap.sh
set -euo pipefail

EXTERNAL_IP="${EXTERNAL_IP:-107.170.15.179}"
REALM="${TURN_REALM:-sarechild.turn}"
TURN_USER="${TURN_USERNAME:-sarechild}"
BASE="/opt/sarechild"
ENV_FILE="$BASE/.env"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq coturn ufw nginx ffmpeg curl git ca-certificates openssl \
  openjdk-17-jdk-headless nodejs npm docker.io docker-compose-plugin 2>/dev/null || \
  apt-get install -y -qq coturn ufw nginx ffmpeg curl git ca-certificates openssl \
  openjdk-17-jdk-headless nodejs npm docker.io

mkdir -p "$BASE"/{staging,build,media-worker,backup,monitoring}
chmod 711 "$BASE"

if [[ ! -f "$ENV_FILE" ]]; then
  TURN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  cat >"$ENV_FILE" <<EOF
# Server-only secrets â€” never commit to git
EXTERNAL_IP=$EXTERNAL_IP
TURN_REALM=$REALM
TURN_USERNAME=$TURN_USER
TURN_PASSWORD=$TURN_PASSWORD
EOF
  chmod 600 "$ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

write_turn_conf() {
  local conf=/etc/turnserver.conf
  cat >"$conf" <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=$EXTERNAL_IP
external-ip=$EXTERNAL_IP
realm=$REALM
server-name=$REALM
fingerprint
lt-cred-mech
user=$TURN_USERNAME:$TURN_PASSWORD
no-cli
no-multicast-peers
no-loopback-peers
no-tlsv1
no-tlsv1_1
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=240.0.0.0-255.255.255.255
min-port=49152
max-port=65535
verbose
EOF
  chmod 640 "$conf"
}
write_turn_conf
sed -i 's/^#TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null || echo 'TURNSERVER_ENABLED=1' >>/etc/default/coturn
systemctl enable coturn
systemctl restart coturn

ufw --force reset || true
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 5349/tcp
ufw allow 5349/udp
ufw allow 49152:65535/udp
ufw allow 8080/tcp
ufw --force enable

cat >"$BASE/staging/index.html" <<'HTML'
<!DOCTYPE html><html><head><meta charset="utf-8"><title>SareChild staging</title></head>
<body><h1>SareChild parent-web staging</h1>
<p>rsync parent-web/dist/ to /opt/sarechild/staging/</p></body></html>
HTML

cat >/etc/nginx/sites-available/sarechild-staging <<'NGINX'
server {
    listen 8080 default_server;
    listen [::]:8080 default_server;
    server_name _;
    root /opt/sarechild/staging;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /downloads/ {
        proxy_pass https://sarechild-media-proxy.neuereatec.workers.dev/downloads/;
        proxy_ssl_server_name on;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/sarechild-staging /etc/nginx/sites-enabled/sarechild-staging
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

cat >"$BASE/build/README.md" <<'MD'
# Self-hosted GitHub Actions runner â€” see docs/VPS_OPS.md
MD

cat >"$BASE/media-worker/transcode.js" <<'JS'
#!/usr/bin/env node
import { spawn } from 'node:child_process';
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('Usage: node transcode.js <in> <out.mp4>'); process.exit(1); }
spawn('ffmpeg', ['-y','-i',input,'-vf','scale=-2:720','-c:v','libx264','-c:a','aac',output], {stdio:'inherit'});
JS
chmod +x "$BASE/media-worker/transcode.js"

cat >"$BASE/backup/firestore-export.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="${FIRESTORE_PROJECT_ID:-safechild-f34ac}"
BUCKET="${FIRESTORE_EXPORT_BUCKET:-}"
if [[ -z "$BUCKET" ]]; then echo "Set FIRESTORE_EXPORT_BUCKET; see docs/VPS_OPS.md"; exit 1; fi
gcloud firestore export "$BUCKET" --project="$PROJECT_ID"
SH
chmod +x "$BASE/backup/firestore-export.sh"

cat >"$BASE/monitoring/healthcheck.sh" <<'SH'
#!/usr/bin/env bash
for u in https://safechild-f34ac.web.app https://sarechild-media-proxy.neuereatec.workers.dev/platform-health; do
  curl -fsS -o /dev/null -m 30 "$u" && echo "$(date -Is) OK $u" || echo "$(date -Is) FAIL $u"
done >>/var/log/sarechild-health.log
SH
chmod +x "$BASE/monitoring/healthcheck.sh"
(crontab -l 2>/dev/null | grep -v healthcheck.sh; echo "*/5 * * * * $BASE/monitoring/healthcheck.sh") | crontab -

if command -v docker >/dev/null; then
  systemctl enable docker 2>/dev/null || true
  systemctl start docker 2>/dev/null || true
  mkdir -p "$BASE/monitoring/uptime-kuma"
  docker run -d --name uptime-kuma --restart unless-stopped -p 127.0.0.1:3001:3001 \
    -v "$BASE/monitoring/uptime-kuma:/app/data" louislam/uptime-kuma:1 2>/dev/null || true
fi

echo "=== bootstrap complete ==="
echo "TURN: turn:${EXTERNAL_IP}:3478 user=$TURN_USERNAME (password in $ENV_FILE)"