#!/usr/bin/env bash
# =========================================================
# funnel_manager.sh — 中央 funnel manager
#   - 從 funnel_manifest.json 讀取所有 funnel 規則
#   - tailscale serve reset + tailscale funnel reset
#   - 把 manifest 裡的全部 tunnel 一次性重建
#   - 用 flock 互斥，避免和任何其它 watchdog 同時 reset
#
# 用法:
#   bash funnel_manager.sh                  # 重建 manifest 全部 funnel
#   bash funnel_manager.sh --check-only     # 只檢查狀態，不動設定
#   bash funnel_manager.sh --verify-only    # 重建後只 verify，不動
#
# 設計: 2026-08-08 修憲, 根治 tunnel watchdog 互踩。
# 2026-08-12 修憲: KTV 從 funnel 分離，經 Node.js proxy :8444 獨立出口。
# funnel_manager.sh 只管理 flowsight (:443) 和 worldmonitor (:10000) 兩個 funnel。
# =========================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/funnel_manifest.json"
LOCK_FILE="/var/run/funnel-manager.lock"
# 2026-08-09 修憲：log 改用 user-writable 路徑（vibe 無法寫 /var/log/）
LOG_FILE="$HOME/funnel-manager.log"

log() {
    local ts
    ts="$(date -Iseconds)"
    echo "[$ts] $*" | tee -a "$LOG_FILE" >&2
}

# --- arg parsing ---
MODE="rebuild"
for arg in "$@"; do
    case "$arg" in
        --check-only)    MODE="check" ;;
        --verify-only)   MODE="verify" ;;
        --rebuild|*)     MODE="rebuild" ;;
    esac
done

[[ -f "$MANIFEST" ]] || { log "FATAL: manifest 不存在: $MANIFEST"; exit 1; }

# --- 解析 manifest ---
# 不用 jq, 用 python3 確保相依性
ENTRIES=$(python3 - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
for f in m["funnels"]:
    print(f"{f['port']}|{f['target']}|{f['url']}")
PY
)
[[ -n "$ENTRIES" ]] || { log "FATAL: manifest 是空的"; exit 1; }

log "=== funnel_manager 啟動 (mode=$MODE) ==="
log "manifest 載入: $(echo "$ENTRIES" | wc -l | tr -d ' ') 條 tunnel"

check_one() {
    # arg: "url"
    local url="$1"
    local code
    code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "$url" || echo 000)"
    [[ "$code" == "200" ]]
}

do_check() {
    local rc=0
    while IFS='|' read -r port target url; do
        if check_one "$url"; then
            log "  OK   :$port  $url"
        else
            log "  FAIL :$port  $url"
            rc=1
        fi
    done <<< "$ENTRIES"
    return $rc
}

do_rebuild() {
    # ── 2026-08-09 加強：rebuild 前先記錄「搶劫事件」─────────────────
    # 抓現有 funnel 狀態，發現 manifest 沒列的 port（被外部強加）就 warn
    local pre_state
    pre_state="$(echo '05050505' | sudo -S tailscale funnel status 2>&1 || true)"
    if echo "$pre_state" | grep -q 'proxy http'; then
        local hijack_detected=0
        while IFS= read -r line; do
            local p t
            p="$(echo "$line" | grep -oE "https://[a-zA-Z0-9.-]+:[0-9]+" | head -1 | awk -F: '{print $NF}')"
            t="$(echo "$line" | grep -oE "proxy http://[^ ]+" | awk '{print $NF}')"
            # 檢查 (port, target) 是否在 manifest 裡
            if [ -n "$p" ] && [ -n "$t" ] && ! echo "$ENTRIES" | grep -q "^${p}|${t}|"; then
                log "HIJACK_DETECTED port=$p target=$t (not in manifest) - rebuild 將會清掉"
                hijack_detected=$((hijack_detected + 1))
            fi
        done <<< "$(echo "$pre_state" | grep 'proxy http')"
        if [ "$hijack_detected" -gt 0 ]; then
            log "REBUILD_TRIGGERED reason=manifest_mismatch count=$hijack_detected"
        fi
    fi

    log "RESET: tailscale serve reset"
    echo '05050505' | sudo -S tailscale serve reset 2>&1 | sed 's/^/  /' | tee -a "$LOG_FILE" || true
    log "RESET: tailscale funnel reset"
    echo '05050505' | sudo -S tailscale funnel reset 2>&1 | sed 's/^/  /' | tee -a "$LOG_FILE" || true

    local failed=0
    while IFS='|' read -r port target url; do
        log "ADD   :$port  ->  $target"
        if echo '05050505' | sudo -S tailscale funnel --bg --https="$port" "$target" 2>&1 \
            | sed 's/^/    /' | tee -a "$LOG_FILE"; then
            log "ADD OK  :$port"
        else
            log "ADD FAIL:$port (rc=$?)"
            failed=$((failed + 1))
        fi
    done <<< "$ENTRIES"

    sleep 5
    if do_check; then
        log "REBUILD OK: 全部回 200"
    else
        log "REBUILD PARTIAL: 有 tunnel 沒起來 (failed=$failed)"
    fi
}

# --- flock 互斥 ---
# 用 LOCK_FILE (=/var/run/funnel-manager.lock) 確保同一時間只有一個 process 在 reset。
# 搶不到 lock 等 30s, 拿到就跑 rebuild, 跑完自動釋放。
exec 9>"$LOCK_FILE"
if ! flock -w 30 9; then
    log "LOCK BUSY: 30s 內拿不到 lock, 放棄本次 reset (讓另一個 process 收尾)"
    exit 0
fi

case "$MODE" in
    check)
        do_check ;;
    verify)
        do_check ;;
    rebuild)
        do_rebuild ;;
esac
