#!/usr/bin/env bash
# =========================================================
# Funnel watchdog — 確保 KTV 對外路徑 (/ktv/*) 活著
#
# 2026-08-09 修憲：
#   - KTV 對外網址從 :10001/tv.html 改成 :443/ktv/tv.html（路徑分流）
#   - 中央 manifest (funnel_manifest.json) 也對應改成 :443 → nginx
#   - watchdog 仍然保留 reclaim 能力（透過 funnel_manager.sh）
#   - 頻率: 每 5 分鐘 (systemd timer)
#
# 用法:
#   安裝: bash ktv-pipeline/install_funnel_watchdog.sh
#   卸載: bash ktv-pipeline/install_funnel_watchdog.sh --remove
#   立即跑一次: systemctl start funnel-watchdog.service
#   看狀態: systemctl status funnel-watchdog.timer
#   看 log:   tail -f /var/log/funnel-watchdog.log
#
# 設計 (2026-08-08 修憲):
#   - 中央 funnel_manager.sh 持有 reset 權限（用 flock /var/run/funnel-manager.lock 互斥）
#   - watchdog 只負責「KTV 自己掛了嗎」檢查；要不要 reset 由 manager 內部搶 lock 決定
#   - 這樣避免和 worldmonitor / 任何其他專案的 watchdog 互踩 reset
#   - manifest: ktv-pipeline/funnel_manifest.json
#   - 頻率: 每 5 分鐘 (systemd timer)
# =========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGER="${SCRIPT_DIR}/funnel_manager.sh"
LOG_FILE="/var/log/funnel-watchdog.log"

# 2026-08-12：對外網址改為 Node.js proxy :8444/ktv/*
KTV_URLS=(
    "https://vibe-nas.taila67710.ts.net:8444/ktv/tv.html"
    "https://vibe-nas.taila67710.ts.net:8444/ktv/mobile.html"
)
KTV_LOCAL="http://localhost:3001/tv.html"

log() {
    local ts
    ts="$(date -Iseconds)"
    echo "[$ts] $*" | tee -a "$LOG_FILE" >&2
}

check_ktv() {
    local rc=0
    for url in "${KTV_URLS[@]}"; do
        local code
        code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "$url" || echo 000)"
        if [[ "$code" != "200" ]]; then
            log "FAIL: $url -> $code"
            rc=1
        fi
    done
    local lcode
    lcode="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 4 "$KTV_LOCAL" || echo 000)"
    if [[ "$lcode" != "200" ]]; then
        log "FAIL(local): $KTV_LOCAL -> $lcode"
        rc=1
    fi
    return $rc
}

log "=== KTV watchdog check 開始 ==="
if check_ktv; then
    log "OK: KTV 全部 200"
    exit 0
fi
log "KO: KTV 有項目掛了, 委派 funnel_manager.sh (內部 flock 互斥)"
"$MANAGER" --rebuild 2>&1 | sed 's/^/  mgr: /' | tee -a "$LOG_FILE"

sleep 5
if check_ktv; then
    log "POST-CHECK OK: KTV 補回 200"
else
    log "POST-CHECK FAIL: KTV 仍掛, 等下個週期 (5 分鐘)"
fi
