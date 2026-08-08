#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy-public.sh
# 把 public/ sync 到 NAS。先試家裡區網 IP，連不上就走 Tailscale IP。
#
# 用法（在 repo root）：
#   bash scripts/deploy-public.sh                # 全部 public/
#   bash scripts/deploy-public.sh public/tv.js   # 單檔
#
# 環境變數覆寫：
#   NAS_LAN_HOST=192.168.31.47        # 家裡區網 IP
#   NAS_TS_HOST=vibe-nas              # Tailscale magic DNS（也可直接用 100.x.x.x）
#   NAS_USER=vibe                     # SSH user
#   NAS_PASS=05050505                 # 密碼（建議放 ~/.netrc 或 sshpass 環境變數）
#   NAS_PROJECT=/home/vibe/ktv-vod    # NAS 上 repo 路徑
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────
NAS_LAN_HOST="${NAS_LAN_HOST:-192.168.31.47}"
NAS_TS_HOST="${NAS_TS_HOST:-vibe-nas}"          # Tailscale magic DNS，會被解析成 100.x
NAS_USER="${NAS_USER:-vibe}"
NAS_PASS="${NAS_PASS:-05050505}"
NAS_PROJECT="${NAS_PROJECT:-/home/vibe/ktv-vod}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-public/}"
SRC_ABS="$REPO_ROOT/$SRC"

if [[ ! -e "$SRC_ABS" ]]; then
  echo "❌ Source not found: $SRC_ABS" >&2
  exit 1
fi

# rsync 路徑結尾 slash 規則：
#   - 目錄要加 /  → rsync 會 sync 內容（不會保留 dir name）
#   - 單檔不加   → rsync 直接傳該檔
SRC_TRAIL=""
if [[ -d "$SRC_ABS" ]]; then
  SRC_TRAIL="/"
fi

# ── helpers ──────────────────────────────────────────────────────────────────
SSH_BASE_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22 -o ConnectTimeout=5 -o BatchMode=no)

probe_ssh() {
  local host="$1"
  if nc -z -w 3 "$host" 22 2>/dev/null; then
    return 0
  fi
  return 1
}

# ── pick host ────────────────────────────────────────────────────────────────
echo "🔎 Probing NAS hosts..."
PICKED=""
if probe_ssh "$NAS_LAN_HOST"; then
  PICKED="$NAS_LAN_HOST"
  ROUTE="LAN (家裡區網)"
elif probe_ssh "$NAS_TS_HOST"; then
  PICKED="$NAS_TS_HOST"
  ROUTE="Tailscale (出門)"
else
  echo "❌ 兩個 host 都連不上：" >&2
  echo "   - LAN:  $NAS_LAN_HOST (要嘛不在家裡 WiFi)" >&2
  echo "   - TS:   $NAS_TS_HOST (要嘛 Tailscale 沒登入)" >&2
  echo "" >&2
  echo "確認方式：" >&2
  echo "   tailscale status                       # 看 NAS 是不是 active" >&2
  echo "   ifconfig en0 | grep 'inet '            # 看你在哪個網段" >&2
  exit 2
fi

# 目標路徑：目錄加 /（保持內容平鋪到目的地目錄），單檔不動
DEST_TRAIL=""
if [[ -d "$SRC_ABS" ]]; then
  DEST_TRAIL="/"
fi
DEST="$NAS_USER@$PICKED:$NAS_PROJECT/$SRC${DEST_TRAIL}"
echo "✅ Route: $ROUTE ($PICKED)"

# ── check sshpass ────────────────────────────────────────────────────────────
if ! command -v sshpass >/dev/null 2>&1; then
  echo "❌ sshpass 沒裝。brew install sshpass" >&2
  exit 3
fi

# ── rsync ────────────────────────────────────────────────────────────────────
echo "📦 Syncing $SRC → $DEST"
SSHPASS="$NAS_PASS" rsync -avz \
  -e "ssh ${SSH_BASE_OPTS[*]}" \
  --checksum \
  --exclude='.DS_Store' \
  "${SRC_ABS}${SRC_TRAIL}" \
  "$DEST"

echo ""
echo "🎉 Done. public/ 是 volume mount，不用重啟容器。"
echo "   瀏覽器記得 Cmd+Shift+R (硬重整) 才能拿到新版。"