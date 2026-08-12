#!/bin/bash
# Deploy KTV HTTPS proxy to NAS
set -e

NAS_HOST="192.168.31.47"
REMOTE_DIR="/home/vibe/ktv-vod"
PROXY_SCRIPT="ktv-https-proxy.js"
NAS_SCRIPT="${REMOTE_DIR}/${PROXY_SCRIPT}"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22)

echo "Deploying KTV HTTPS proxy..."

# 1. Copy proxy script
SSHPASS='05050505' rsync -avz \
  -e "ssh ${SSH_OPTS[*]}" \
  --checksum \
  "${PROXY_SCRIPT}" \
  "vibe@${NAS_HOST}:${REMOTE_DIR}/"

# 2. Copy certs (needs sudo on NAS)
SSHPASS='05050505' ssh "${SSH_OPTS[@]}" "vibe@${NAS_HOST}" \
  "echo '05050505' | sudo -S bash -c 'cat /var/lib/tailscale/certs/vibe-nas.taila67710.ts.net.crt > /tmp/ts-cert.crt && cat /var/lib/tailscale/certs/vibe-nas.taila67710.ts.net.key > /tmp/ts-cert.key && chmod 644 /tmp/ts-cert.crt /tmp/ts-cert.key'"

# 3. Restart service
SSHPASS='05050505' ssh "${SSH_OPTS[@]}" "vibe@${NAS_HOST}" \
  "systemctl --user restart ktv-https-proxy && sleep 1 && systemctl --user status ktv-https-proxy | head -5"

echo "Done. KTV URL: https://vibe-nas.taila67710.ts.net:8444/ktv/mobile.html"
