#!/usr/bin/env bash
# Publish droplet inventory at http://107.170.15.179:8080/ops-health.json for TCD.
# From a workstation:
#   scp scripts/vps/install-ops-health.sh root@107.170.15.179:/tmp/
#   ssh root@107.170.15.179 bash /tmp/install-ops-health.sh
set -euo pipefail

HOST="${EXTERNAL_IP:-107.170.15.179}"
BASE=/opt/sarechild
mkdir -p "$BASE/monitoring" "$BASE/staging"

cat >"$BASE/monitoring/write-ops-health.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
HOST="${EXTERNAL_IP:-107.170.15.179}"
OUT=/opt/sarechild/staging/ops-health.json
eval $(df -B1 / | awk 'NR==2 {printf "disk_total=%s disk_used=%s disk_avail=%s disk_pct=%s\n", $2, $3, $4, $5}')
disk_pct=${disk_pct%%%}
mem_total=$(awk '/MemTotal/ {print $2*1024}' /proc/meminfo)
mem_avail=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo)
l1=$(cut -d' ' -f1 /proc/loadavg)
l5=$(cut -d' ' -f2 /proc/loadavg)
l15=$(cut -d' ' -f3 /proc/loadavg)
svc() { systemctl is-active --quiet "$1" && echo true || echo false; }
uptime_s=$(awk '{print int($1)}' /proc/uptime)
now_ms=$(($(date +%s) * 1000))
cat >"$OUT.tmp" <<JSON
{
  "ok": true,
  "provider": "digitalocean",
  "host": "$HOST",
  "updatedAtMs": $now_ms,
  "uptimeSec": $uptime_s,
  "disk": { "totalBytes": $disk_total, "usedBytes": $disk_used, "availBytes": $disk_avail, "percent": "$disk_pct" },
  "memory": { "totalBytes": $mem_total, "availableBytes": $mem_avail },
  "load": { "one": $l1, "five": $l5, "fifteen": $l15 },
  "services": {
    "coturn": $(svc coturn),
    "nginx": $(svc nginx),
    "docker": $(svc docker)
  },
  "roles": [
    "coturn-turn",
    "parent-web-staging",
    "apk-download-mirror",
    "ffmpeg-media-worker",
    "firestore-backup-templates",
    "outbound-health-cron"
  ],
  "ports": { "ssh": 22, "turn": 3478, "turns": 5349, "staging": 8080 }
}
JSON
mv "$OUT.tmp" "$OUT"
EOS

chmod +x "$BASE/monitoring/write-ops-health.sh"
EXTERNAL_IP="$HOST" "$BASE/monitoring/write-ops-health.sh"
(crontab -l 2>/dev/null | grep -v write-ops-health.sh || true; echo "* * * * * EXTERNAL_IP=$HOST $BASE/monitoring/write-ops-health.sh") | crontab -
echo "ops-health installed → http://${HOST}:8080/ops-health.json"
