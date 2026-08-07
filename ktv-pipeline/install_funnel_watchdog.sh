#!/usr/bin/env bash
# =========================================================
# 安裝 / 移除 funnel watchdog 為 systemd timer
# =========================================================
set -euo pipefail

SSHPASS='05050505'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SCRIPT="${SCRIPT_DIR}/funnel_watchdog.sh"
SERVICE_NAME="funnel-watchdog"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
TIMER_FILE="/etc/systemd/system/${SERVICE_NAME}.timer"

[[ -f "$WATCHDOG_SCRIPT" ]] || { echo "找不到 $WATCHDOG_SCRIPT"; exit 1; }
chmod +x "$WATCHDOG_SCRIPT"

# 先 unmask (上次半殘狀態清掉)
echo "$SSHPASS" | sudo -S systemctl unmask "$SERVICE_NAME.service" 2>/dev/null || true
echo "$SSHPASS" | sudo -S systemctl stop "$SERVICE_NAME.timer" 2>/dev/null || true

if [[ "${1:-}" == "--remove" ]]; then
    echo "移除 systemd unit..."
    echo "$SSHPASS" | sudo -S systemctl disable "$SERVICE_NAME.timer" 2>/dev/null || true
    echo "$SSHPASS" | sudo -S rm -f "$SERVICE_FILE" "$TIMER_FILE"
    echo "$SSHPASS" | sudo -S systemctl daemon-reload
    echo "完成。log 留在 /var/log/funnel-watchdog.log"
    exit 0
fi

# 先把內容寫到 tmp,再 sudo cp (避免 heredoc 透過 sudo -S 時密碼 leak 到檔案)
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=KTV Funnel watchdog (vibe-nas.taila67710.ts.net)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $WATCHDOG_SCRIPT
StandardOutput=append:/var/log/funnel-watchdog.log
StandardError=append:/var/log/funnel-watchdog.log

[Install]
WantedBy=multi-user.target
EOF

cat > "$TMPDIR/${SERVICE_NAME}.timer" <<EOF
[Unit]
Description=每 5 分鐘檢查 Tailscale Funnel

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 用 sudo 拷過去 (分開呼叫,不混 stdin)
echo "$SSHPASS" | sudo -S cp "$TMPDIR/${SERVICE_NAME}.service" "$SERVICE_FILE"
echo "$SSHPASS" | sudo -S cp "$TMPDIR/${SERVICE_NAME}.timer" "$TIMER_FILE"
echo "$SSHPASS" | sudo -S touch /var/log/funnel-watchdog.log
echo "$SSHPASS" | sudo -S chmod 644 /var/log/funnel-watchdog.log
echo "$SSHPASS" | sudo -S systemctl daemon-reload
echo "$SSHPASS" | sudo -S systemctl enable --now "$SERVICE_NAME.timer"
echo "已啟用。檢查:"
echo "  systemctl status $SERVICE_NAME.timer"
echo "  journalctl -u $SERVICE_NAME.service -n 20"
echo "  tail -f /var/log/funnel-watchdog.log"