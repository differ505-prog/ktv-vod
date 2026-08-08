#!/usr/bin/env bash
# =========================================================
# Funnel watchdog — 確保 https://vibe-nas.taila67710.ts.net/tv.html 與 mobile.html
# 跟 worldmonitor 對外都活著。掛了自動重設。
#
# 用法:
#   安裝: bash ktv-pipeline/install_funnel_watchdog.sh
#   卸載: bash ktv-pipeline/install_funnel_watchdog.sh --remove
#   立即跑一次: systemctl start funnel-watchdog.service
#   看狀態: systemctl status funnel-watchdog.timer
#   看 log:   journalctl -u funnel-watchdog.service -n 50
#
# 設計 (2026-08-07):
#   - 對外服務:
#       port 443   → http://localhost:3001   (KTV 主站, port 鎖死 3001)
#       port 10000 → http://localhost:8081   (worldmonitor)
#   - 檢查: 公開 HTTPS + 本地 3001
#   - 修復: tailscale serve reset → 重新加 2 條 funnel
#   - 通知: 寫 /var/log/funnel-watchdog.log 帶時間戳
#   - 頻率: 每 5 分鐘 (systemd timer)
# =========================================================
set -euo pipefail

LOG_FILE="/var/log/funnel-watchdog.log"
EXPECTED_FUNNELS=(
    "443:http://localhost:3001"
    "10000:http://localhost:8081"
)
CHECK_URLS=(
    "https://vibe-nas.taila67710.ts.net/tv.html"
    "https://vibe-nas.taila67710.ts.net/mobile.html"
)
LOCAL_URLS=(
    "http://localhost:3001/tv.html"
    "http://localhost:3001/mobile.html"
)

log() {
    local ts
    ts="$(date -Iseconds)"
    echo "[$ts] $*" | tee -a "$LOG_FILE" >&2
}

check() {
    local rc=0
    for url in "${CHECK_URLS[@]}"; do
        local code
        code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "$url" || echo "000")"
        if [[ "$code" != "200" ]]; then
            log "FAIL: $url -> $code"
            rc=1
        fi
    done
    for url in "${LOCAL_URLS[@]}"; do
        local code
        code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 4 "$url" || echo "000")"
        if [[ "$code" != "200" ]]; then
            log "FAIL(local): $url -> $code"
            rc=1
        fi
    done
    return "$rc"
}

repair() {
    log "REPAIR: tailscale serve reset + 重新設定 Funnel"
    if echo "05050505" | sudo -S tailscale set --operator="$(whoami)" 2>/dev/null; then
        log "  operator 設定完成"
    fi
    # 把所有 reset / add 的 stdout/stderr 都進 log (原本會被 || true 吞掉)
    {
        echo "05050505" | sudo -S tailscale serve reset 2>&1
        echo "05050505" | sudo -S tailscale funnel reset 2>&1
    } | sed "s/^/  /" | tee -a "$LOG_FILE" || true
    for spec in "${EXPECTED_FUNNELS[@]}"; do
        local port="${spec%%:*}"
        local target="${spec##*:}"
        log "  add: --https=${port} -> ${target}"
        if echo "05050505" | sudo -S tailscale funnel --bg --https="${port}" "${target}" 2>&1 \
            | sed "s/^/    /" | tee -a "$LOG_FILE"; then
            log "  add OK: ${port} -> ${target}"
        else
            log "  add FAILED: ${port} -> ${target} (rc=$?)"
        fi
    done
    sleep 5
    if check; then
        log "REPAIR OK: 全部回 200"
    else
        log "REPAIR FAILED: 修完仍然掛, 請手動看 tailscale funnel status"
    fi
}

log "=== check 開始 ==="
if check; then
    log "OK: 全部 200"
    exit 0
fi
log "KO: 有項目掛了, 進入 repair"
repair