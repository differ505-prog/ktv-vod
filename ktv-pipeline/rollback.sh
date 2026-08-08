#!/usr/bin/env bash
#
# rollback.sh — 還原上一次的 deploy (用備份的 .bak 檔)
#
# 使用:
#   bash rollback.sh                                # 自動找最新的 bak
#   bash rollback.sh ktv-pipeline 20260726_144153   # 指定容器 + 時間戳
#   NAS_HOST=vibe@192.168.31.47 bash rollback.sh    # 指定 NAS
#

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${GREEN}[rollback]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }

NAS_HOST="${NAS_HOST:-vibe@vibe-nas.taila67710.ts.net}"
NAS_PORT="${NAS_PORT:-22}"
CONTAINER_NAME="${1:-}"
TS="${2:-}"
APP_DIR="/app"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$NAS_PORT")

# ============================================================
# 1. 找容器
# ============================================================
if [[ -z "$CONTAINER_NAME" ]]; then
    info "列舉 NAS 容器 ..."
    ssh "${SSH_OPTS[@]}" "$NAS_HOST" "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"
    GUESS=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" "docker ps --format '{{.Names}}' | grep -E '^ktv[-_]?pipeline$' || true")
    if [[ -n "$GUESS" ]]; then
        CONTAINER_NAME="$GUESS"
        info "自動選容器: $CONTAINER_NAME"
    else
        read -rp "請輸入目標容器名稱: " CONTAINER_NAME
        [[ -z "$CONTAINER_NAME" ]] && { err "沒容器名稱,中斷"; exit 1; }
    fi
fi

# 確認容器存在
if ! ssh "${SSH_OPTS[@]}" "$NAS_HOST" "docker ps --format '{{.Names}}' | grep -qx '$CONTAINER_NAME'"; then
    err "容器 '$CONTAINER_NAME' 沒在跑"
    exit 1
fi
info "目標容器: $CONTAINER_NAME ✓"

# ============================================================
# 2. 找時間戳
# ============================================================
if [[ -z "$TS" ]]; then
    info "找最新的備份時間戳 ..."
    ALL_BAK=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
        "docker exec $CONTAINER_NAME bash -c 'ls -1 $APP_DIR/*.bak.* 2>/dev/null'" || true)
    if [[ -z "$ALL_BAK" ]]; then
        err "容器內沒有任何 .bak 檔,沒東西可還原"
        exit 1
    fi
    echo "$ALL_BAK"
    # 取最新時間戳 (檔名最後一段)
    TS=$(echo "$ALL_BAK" | head -1 | sed -E 's/.*\.bak\.([0-9_]+)$/\1/')
    if [[ -z "$TS" ]]; then
        err "無法從 bak 檔名抽出時間戳,請手動指定"
        exit 1
    fi
    info "自動選時間戳: $TS"
fi

# ============================================================
# 3. 確認有 .bak
# ============================================================
info "確認備份檔存在 ..."
EXISTING=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
    "docker exec $CONTAINER_NAME bash -c 'ls -1 $APP_DIR/*.bak.$TS 2>/dev/null'" || true)

if [[ -z "$EXISTING" ]]; then
    err "找不到備份:$APP_DIR/*.bak.$TS"
    err "請確認時間戳正確,或手動跑:"
    err "  ssh $NAS_HOST 'docker exec $CONTAINER_NAME ls $APP_DIR/'"
    exit 1
fi

info "找到備份:"
echo "$EXISTING" | sed 's/^/  /'

# ============================================================
# 4. 確認
# ============================================================
echo ""
warn "即將把以下檔案從 .bak.$TS 還原成現行版本:"
echo "$EXISTING" | sed -E "s|\\.bak\\.$TS\$||" | sed 's/^/  /'
echo ""
read -rp "確定還原嗎? (yes/N): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
    info "取消"
    exit 0
fi

# ============================================================
# 5. 還原
# ============================================================
info "開始還原 ..."
ssh "${SSH_OPTS[@]}" "$NAS_HOST" bash <<EOF
set -e
for bak_file in \$(ls -1 $APP_DIR/*.bak.$TS); do
    real_file="\${bak_file%.bak.$TS}"
    if docker exec "$CONTAINER_NAME" test -f "\$bak_file"; then
        # 把當前壞版另存 .broken.$TS,留證據
        if docker exec "$CONTAINER_NAME" test -f "\$real_file"; then
            docker exec "$CONTAINER_NAME" cp "\$real_file" "\${real_file}.broken.$TS"
        fi
        docker exec "$CONTAINER_NAME" cp "\$bak_file" "\$real_file"
        echo "  ✓ \$(basename \$bak_file) → \$(basename \$real_file)"
    fi
done
EOF

info "=========================================="
info "還原完成 ✓"
info "還原前當下版本備份在: .broken.$TS"
info "=========================================="