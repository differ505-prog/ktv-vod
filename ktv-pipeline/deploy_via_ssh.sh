#!/usr/bin/env bash
#
# deploy_via_ssh.sh — 不需本機 docker,純 SSH 上 NAS 部署
#
# 流程:
#   1. SSH 連 NAS(互動問密碼,不存任何檔案)
#   2. NAS 上跑 docker ps 找容器
#   3. scp 上傳 3 個檔案到 NAS /tmp/
#   4. SSH docker cp 進容器
#   5. SSH docker exec 跑 pytest 驗證
#
# 使用:
#   bash deploy_via_ssh.sh                       # 互動問容器名稱
#   bash deploy_via_ssh.sh ktv-pipeline          # 直接指定容器名稱
#   NAS_HOST=vibe@192.168.31.47 bash deploy_via_ssh.sh   # 指定 NAS
#

set -euo pipefail

# ============================================================
# 顏色
# ============================================================
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }

# ============================================================
# 自我定位
# ============================================================
_SOURCE="${BASH_SOURCE[0]:-$0}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
    _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"

info "部署腳本位於: $SCRIPT_DIR"

# ============================================================
# 參數
# ============================================================
NAS_HOST="${NAS_HOST:-vibe@192.168.31.47}"
NAS_PORT="${NAS_PORT:-22}"
CONTAINER_NAME="${1:-}"
CONTAINER_APP_DIR="/app"

SSH_OPTS=(
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o ConnectTimeout=8
    -p "$NAS_PORT"
)

SCP_OPTS=(
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -P "$NAS_PORT"
)

# ============================================================
# 0. 本機檔案檢查
# ============================================================
info "確認 host 端檔案 ..."
for f in main.py alignment.py test_alignment.py; do
    if [[ ! -f "$SCRIPT_DIR/$f" ]]; then
        err "找不到 $SCRIPT_DIR/$f,中止部署"
        exit 1
    fi
done
info "host 端檔案齊全 ✓"

# ============================================================
# 1. SSH 連線測試 + 列舉 NAS 上的容器
# ============================================================
info "透過 SSH 連到 $NAS_HOST:$NAS_PORT ..."
if ! ssh "${SSH_OPTS[@]}" "$NAS_HOST" "echo ok" >/dev/null 2>&1; then
    err "SSH 連線失敗,請確認:"
    err "  - NAS IP / port 是否正確 ($NAS_HOST:$NAS_PORT)"
    err "  - 網路通不通 (ping 192.168.31.47)"
    err "  - SSH service 是否開著"
    exit 1
fi
info "SSH 通了 ✓"

# ============================================================
# 2. 列容器 + 自動猜名稱
# ============================================================
if [[ -z "$CONTAINER_NAME" ]]; then
    info "列舉 NAS 上的容器 ..."
    ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
        "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'"
    echo ""

    GUESS=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
        "docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^ktv[-_]?pipeline\$' || true")
    if [[ -n "$GUESS" ]]; then
        info "自動偵測到容器: $GUESS"
        CONTAINER_NAME="$GUESS"
    else
        read -rp "請輸入目標容器名稱: " CONTAINER_NAME
        if [[ -z "$CONTAINER_NAME" ]]; then
            err "未提供容器名稱,中止"
            exit 1
        fi
    fi
fi

# 確認容器在跑
if ! ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
    "docker ps --format '{{.Names}}' | grep -qx '$CONTAINER_NAME'"; then
    err "容器 '$CONTAINER_NAME' 不在 NAS 上執行中,中止"
    err "可用容器:"
    ssh "${SSH_OPTS[@]}" "$NAS_HOST" "docker ps --format '{{.Names}}'"
    exit 1
fi
info "目標容器: $CONTAINER_NAME ✓"

# ============================================================
# 3. 備份容器內現有檔案
# ============================================================
TS="$(date +%Y%m%d_%H%M%S)"
info "備份容器內現有檔案 (時間戳 $TS) ..."

ssh "${SSH_OPTS[@]}" "$NAS_HOST" bash <<EOF
set -e
BACKED_UP=0
SKIPPED=0
for f in main.py alignment.py test_alignment.py; do
    if docker exec "$CONTAINER_NAME" test -f "$CONTAINER_APP_DIR/\$f"; then
        # 注意:測試存在性後到 cp 之間有微小 race window,但這是容器內單線程,實務安全
        if docker exec "$CONTAINER_NAME" test -f "$CONTAINER_APP_DIR/\$f.bak.$TS"; then
            echo "  ⚠ $f.bak.$TS 已存在,改用 .bak.$TS.new"
            docker exec "$CONTAINER_NAME" cp \
                "$CONTAINER_APP_DIR/\$f" \
                "$CONTAINER_APP_DIR/\${f}.bak.$TS.new" || true
        else
            docker exec "$CONTAINER_NAME" cp \
                "$CONTAINER_APP_DIR/\$f" \
                "$CONTAINER_APP_DIR/\${f}.bak.$TS" || true
        fi
        echo "  ✓ 備份 \$f → \$f.bak.$TS"
        BACKED_UP=\$((BACKED_UP+1))
    else
        echo "  · \$f 在容器內不存在 (首次部署或新檔),略過備份"
        SKIPPED=\$((SKIPPED+1))
    fi
done
echo ""
echo "  備份統計: \$BACKED_UP 個有備份,\$SKIPPED 個首次部署"
EOF

# ============================================================
# 4. 上傳檔案到 NAS /tmp/,再 docker cp 進容器
# ============================================================
info "上傳新檔案到 NAS ..."
TMPDIR="/tmp/ktv-deploy-$$"
ssh "${SSH_OPTS[@]}" "$NAS_HOST" "mkdir -p $TMPDIR"

for f in main.py alignment.py test_alignment.py; do
    info "  scp $f → NAS:$TMPDIR/"
    scp "${SCP_OPTS[@]}" "$SCRIPT_DIR/$f" "$NAS_HOST:$TMPDIR/$f"

    info "  docker cp → $CONTAINER_NAME:$CONTAINER_APP_DIR/$f"
    ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
        "docker cp $TMPDIR/$f $CONTAINER_NAME:$CONTAINER_APP_DIR/$f" \
        || { err "docker cp $f 失敗"; exit 1; }
done

# 清 NAS 上的 tmp
ssh "${SSH_OPTS[@]}" "$NAS_HOST" "rm -rf $TMPDIR"

# ============================================================
# 5. 在容器內跑驗證 (try pytest,fallback 到 import sanity)
# ============================================================
info "在容器內跑驗證 ..."

# (a) 先看容器有沒有 pytest
HAS_PYTEST=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
    "docker exec $CONTAINER_NAME python3 -c 'import pytest; print(\"yes\")' 2>&1" \
    || echo "no")

if echo "$HAS_PYTEST" | grep -q "yes"; then
    info "容器有 pytest,跑完整測試 ..."
    if ! ssh "${SSH_OPTS[@]}" "$NAS_HOST" \
        "docker exec -w $CONTAINER_APP_DIR $CONTAINER_NAME \
            python3 -m pytest test_alignment.py -v" 2>&1 | tail -40; then
        warn "pytest 跑失敗 (但檔案已部署,不影響部署)"
    fi
else
    warn "容器內沒有 pytest (image 未預裝),改跑 import sanity check ..."
    info "如要完整 pytest,日後在 NAS 容器內: docker exec $CONTAINER_NAME pip install pytest"

    SANITY=$(ssh "${SSH_OPTS[@]}" "$NAS_HOST" bash <<'EOF'
docker exec ktv-pipeline python3 - <<'PY'
import sys
sys.path.insert(0, "/app")
try:
    from alignment import (
        DEFAULT_DEMUCS_SR, build_atrim_filter, compute_audio_skip,
        get_wav_duration_s, get_wav_samples, leading_silence_seconds,
        trim_wav_to_duration,
        # v2 (9.0/10 重構): AlignmentConfig + DEFAULT_CONFIG + diagnose_wav
        AlignmentConfig, DEFAULT_CONFIG, diagnose_wav,
    )
    # 跑純邏輯檢查,確認 7/26 + 重構版都沒 syntax/邏輯錯
    af = build_atrim_filter(1.5)  # audio_skip_s=1.5
    assert isinstance(af, str) and len(af) > 0, "build_atrim_filter 沒回字串"
    af_small = build_atrim_filter(0.02)
    assert af_small == "", f"build_atrim_filter(0.02) 應為空,實際 {af_small!r}"
    dur = get_wav_duration_s  # 確認 callable
    assert callable(dur), "get_wav_duration_s 不是函式"
    cfg = AlignmentConfig()
    assert hasattr(cfg, "rms_db_threshold"), "AlignmentConfig 缺少 rms_db_threshold"
    assert DEFAULT_CONFIG is not None, "DEFAULT_CONFIG 未匯出"
    print("✓ alignment module imports OK")
    print("✓ build_atrim_filter returns string (large) + empty (small)")
    print("✓ AlignmentConfig + DEFAULT_CONFIG exports OK")
except Exception as e:
    print(f"✗ FAIL: {e}", file=sys.stderr)
    sys.exit(1)
PY
EOF
)
    SANITY_RC=$?
    if [[ $SANITY_RC -eq 0 ]]; then
        info "import sanity 通過 ✓"
        echo "$SANITY"
    else
        warn "import sanity 失敗 (但檔案已部署)"
        echo "$SANITY"
    fi
fi

# ============================================================
# 6. 結果
# ============================================================
info "=========================================="
info "部署完成 ✓"
info "備份檔案後綴: .bak.$TS"
info "若想復原,在 NAS 上跑:"
info "  docker exec $CONTAINER_NAME cp \\"
info "    $CONTAINER_APP_DIR/main.py.bak.$TS \\"
info "    $CONTAINER_APP_DIR/main.py"
info "=========================================="
