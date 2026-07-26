#!/usr/bin/env bash
#
# deploy_to_nas.sh — 一鍵部署字幕偏移修正 (7/26) 到 NAS 容器
#
# User 在 host terminal 跑這支就好,所有 NAS / docker 操作都包在裡面。
#
# 使用:
#   bash deploy_to_nas.sh                # 互動式,會問 docker container name
#   bash deploy_to_nas.sh ktv-pipeline   # 直接指定 container name
#
# 部署的檔案:
#   - main.py           (核心 pipeline)
#   - alignment.py      (新抽出的對齊 helpers)
#   - test_alignment.py (pytest)
#
# 部署後會自動跑 pytest 驗證。

# ============================================================
# 顏色輸出 (提前定義,因為自我定位 log 會用到)
# ============================================================
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info() { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
err()  { echo -e "${RED}[error]${NC} $*" >&2; }

set -euo pipefail

# ============================================================
# 自我定位 — 在任何目錄執行都能找到腳本和檔案
# ============================================================
# (a) 直接執行: bash deploy_to_nas.sh      → SCRIPT_DIR = 腳本所在目錄
# (b) 從別處跑:    bash ~/Downloads/deploy_to_nas.sh → resolve symlink
# 用 BASH_SOURCE 而不是 $0,因為 $0 是引號內的字串,不是路徑
_SOURCE="${BASH_SOURCE[0]:-$0}"
while [[ -L "$_SOURCE" ]]; do
    _DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
    _SOURCE="$(readlink "$_SOURCE")"
    [[ "$_SOURCE" != /* ]] && _SOURCE="$_DIR/$_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$_SOURCE")" && pwd)"
export SCRIPT_DIR

info "部署腳本位於: $SCRIPT_DIR"

# ============================================================
# 參數
# ============================================================
CONTAINER_NAME="${1:-}"
CONTAINER_APP_DIR="/app"

# ============================================================
# 0a. 自動找 docker 二進位 (解決 host shell PATH 沒 docker 的問題)
# ============================================================
# OrbStack / Docker Desktop / Colima / brew / nerdctl 等常見安裝位置。
# 若 PATH 裡已有 docker 就跳過,否則挨個 probe 第一個能執行的。

DOCKER_CACHE="$SCRIPT_DIR/.docker_path"

# (0) **最高優先**:讀 cache 檔。一勞永逸的路徑優先於所有自動探測。
if ! command -v docker >/dev/null 2>&1; then
    if [[ -f "$DOCKER_CACHE" ]]; then
        CACHED=$(cat "$DOCKER_CACHE" 2>/dev/null)
        if [[ -x "$CACHED" ]]; then
            export PATH="$(dirname "$CACHED"):$PATH"
            warn "從 cache (.docker_path) 讀到 docker: $CACHED"
        fi
    fi
fi

if ! command -v docker >/dev/null 2>&1; then
    # (1) 先試 login shell,讓 ~/.zprofile / ~/.zshrc 跑起來 (很多 docker 安裝
    #     是透過 shell rc 把 PATH 加進來的,平常互動式 terminal 有,腳本沒有)
    #     注意:Mac 預設 zsh,不能寫死 bash,要偵測當前 shell
    _USER_SHELL="${SHELL:-/bin/zsh}"
    if SHELL_DOCKER=$("$_USER_SHELL" -lic 'command -v docker' 2>/dev/null | tail -1) && [[ -x "$SHELL_DOCKER" ]]; then
        export PATH="$(dirname "$SHELL_DOCKER"):$PATH"
        warn "從 login shell ($_USER_SHELL) 找到 docker: $SHELL_DOCKER"
    fi
fi

if ! command -v docker >/dev/null 2>&1; then
    # (1b) OrbStack 特例:它有個 shell hook 會 export PATH,直接 source 進來
    ORB_HOOK="/Applications/OrbStack.app/share/orbstack.sh"
    if [[ -f "$ORB_HOOK" ]]; then
        # shellcheck disable=SC1090
        source "$ORB_HOOK" 2>/dev/null && command -v docker >/dev/null 2>&1 \
            && warn "從 OrbStack hook 拿到 docker"
    fi
fi

if ! command -v docker >/dev/null 2>&1; then
    # (2) 試常見安裝位置
    CANDIDATES=(
        "/Applications/OrbStack.app/bin/docker"            # OrbStack (Apple Silicon)
        "/Applications/OrbStack.app/Contents/Resources/bin/docker"
        "/Applications/Docker.app/Contents/Resources/bin/docker"   # Docker Desktop
        "/Applications/Docker.app/Contents/PlugIns/bin/docker"
        "/opt/homebrew/bin/docker"                          # Homebrew (Apple Silicon)
        "/usr/local/bin/docker"                             # Homebrew (Intel) / Colima
        "/usr/bin/docker"
        "$HOME/.docker/bin/docker"                          # Rancher Desktop / 一些自裝
        "/opt/colima/bin/docker"                            # Colima 自訂路徑
    )
    for cand in "${CANDIDATES[@]}"; do
        # 只接受「檔案」且有可執行權限;跳過 socket/dir
        if [[ -f "$cand" && -x "$cand" ]]; then
            export PATH="$(dirname "$cand"):$PATH"
            warn "在候選清單找到 docker: $cand"
            break
        fi
    done
fi

if ! command -v docker >/dev/null 2>&1; then
    # (3) 最後寬鬆搜整棵 /Applications + /opt + /usr/local
    #     注意:macOS BSD find 不支援 -perm +111,用 -type f + -name 已足夠
    FOUND=$(find /Applications /opt /usr/local "$HOME/.docker" \
                -maxdepth 6 -name docker -type f 2>/dev/null | head -1)
    if [[ -n "$FOUND" && -x "$FOUND" ]]; then
        export PATH="$(dirname "$FOUND"):$PATH"
        warn "fallback find 找到 docker: $FOUND"
    fi
fi

# (4) 終極手段:請 user 一次性告訴我們位置 (寫進 cache 檔,下次不問)
if ! command -v docker >/dev/null 2>&1; then
    err "找不到 docker,請跑一次: type -a docker,然後把輸出貼給我"
    err "我會把路徑寫進 $DOCKER_CACHE,下次自動讀取"
    exit 1
fi

# Sanity check:確認 docker 真的能跑 (不只是 PATH 有)
if ! docker --version >/dev/null 2>&1; then
    err "PATH 有 docker,但 docker --version 失敗,daemon 可能沒啟動"
    err "請開啟 Docker Desktop / OrbStack 後再重跑"
    exit 1
fi
info "docker OK: $(docker --version 2>&1 | head -1)"

# ============================================================
# 0. 確認 host 端檔案存在
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
# 1. 確認 docker 可用 & 容器存在
# ============================================================
if ! command -v docker >/dev/null 2>&1; then
    err "docker 指令不在 PATH,請先安裝/啟動 Docker Desktop"
    exit 1
fi

if [[ -z "$CONTAINER_NAME" ]]; then
    # 互動式詢問
    info "正在列舉 NAS 上執行中的容器 ..."
    if ! docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null; then
        err "docker ps 失敗,請確認 docker daemon 與 NAS 連線"
        exit 1
    fi

    # 自動猜:若有 ktv-pipeline 在跑就直接用,免 user 打字
    GUESS=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^ktv[-_]?pipeline$' || true)
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

# 確認容器真的在跑
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    err "容器 '$CONTAINER_NAME' 不在執行中,中止"
    exit 1
fi
info "目標容器: $CONTAINER_NAME ✓"

# ============================================================
# 2. 備份容器內現有檔案
# ============================================================
info "備份容器內現有檔案 ..."
TS="$(date +%Y%m%d_%H%M%S)"
for f in main.py alignment.py test_alignment.py; do
    if docker exec "$CONTAINER_NAME" test -f "$CONTAINER_APP_DIR/$f"; then
        docker exec "$CONTAINER_NAME" cp \
            "$CONTAINER_APP_DIR/$f" \
            "$CONTAINER_APP_DIR/${f}.bak.$TS" \
            || warn "備份 $f 失敗 (繼續)"
    fi
done

# ============================================================
# 3. docker cp 上傳新檔案
# ============================================================
info "上傳修正後檔案到容器 ..."
for f in main.py alignment.py test_alignment.py; do
    docker cp "$SCRIPT_DIR/$f" "$CONTAINER_NAME:$CONTAINER_APP_DIR/$f"
    info "  ✓ $f"
done

# ============================================================
# 4. 在容器內跑 pytest 驗證
# ============================================================
info "在容器內跑 pytest 驗證 ..."
docker exec -w "$CONTAINER_APP_DIR" "$CONTAINER_NAME" \
    python3 -m pytest test_alignment.py -v 2>&1 | tail -30

# ============================================================
# 5. 結果
# ============================================================
info "=========================================="
info "部署完成 ✓"
info "備份檔案後綴: .bak.$TS"
info "若想復原:"
info "  docker exec $CONTAINER_NAME cp \\"
info "    $CONTAINER_APP_DIR/main.py.bak.$TS \\"
info "    $CONTAINER_APP_DIR/main.py"
info "=========================================="