#!/bin/sh
# =========================================================
# KTV Brain 容器 entrypoint
#
# 為什麼需要這個腳本:
#   TRASH_DIR (/ktv-data/_Trash) 在 named volume 內,而 /ktv-data 是 root owned。
#   container 預設 USER ktv 無法 mkdir 新子目錄。
#   node server.js 又必須以 ktv user 跑 (useradd 建立的安全帳號)。
#
# 解法:
#   1. 以 root 身份 (docker 預設) 建立 TRASH_DIR
#   2. chown ktv:ktv 給 server 寫
#   3. 用 gosu 切換到 ktv,exec 真正的 CMD (node server.js)
# =========================================================

set -e

# 1. 確保 TRASH_DIR 存在且 ktv user 可寫
if [ -n "$TRASH_DIR" ] && [ ! -d "$TRASH_DIR" ]; then
  echo "[entrypoint] 建立 TRASH_DIR: $TRASH_DIR"
  mkdir -p "$TRASH_DIR" 2>/dev/null || {
    echo "[entrypoint] WARN: 無法建立 $TRASH_DIR (可能權限不足),delete 功能會降級"
  }
fi

if [ -d "$TRASH_DIR" ]; then
  chown -R ktv:ktv "$TRASH_DIR" 2>/dev/null || {
    echo "[entrypoint] WARN: 無法 chown $TRASH_DIR,ktv user 可能寫不進"
  }
fi

# 2. 確保 VIDEO_DIR 也 ktv user 可寫 (Pipeline 寫入需要)
if [ -n "$VIDEO_DIR" ] && [ -d "$VIDEO_DIR" ]; then
  chown -R ktv:ktv "$VIDEO_DIR" 2>/dev/null || true
fi

# 2.5 確保 TV_CACHE_DIR 存在且 ktv 可寫
TV_CACHE_DIR="/ktv-data/tv_cache"
mkdir -p "$TV_CACHE_DIR" 2>/dev/null || true
chown -R ktv:ktv "$TV_CACHE_DIR" 2>/dev/null || true
touch /ktv-data/sync_config.json 2>/dev/null || true
chown ktv:ktv /ktv-data/sync_config.json 2>/dev/null || true

# 3. 容器內部以 root 啟動 node,放棄降權到 ktv。
#    原因（2026-09-14 修復）: /ktv-data 是 host mergerfs 透過 slave mount 傳進 container,
#    FUSE 連線是在 host 開機時建立,當時 /etc/fuse.conf 的 user_allow_other 未開,
#    所以 host 上唯一允許存取此 FUSE 的 UID 就是 mergerfs 啟動者（root）。
#    容器內即使把目錄 chown 給 ktv,FUSE 層仍會拒絕 ktv 的 readdir,
#    結果 VIDEO_DIR 永遠讀不到 → SONG_LIBRARY=0,前端看不到歌。
#    唯一安全的修法（不動 host mergerfs mount）是容器內不要降權,直接以 root 跑 node。
#    替代方案: 重啟 host mergerfs,但那會同時把所有 /mnt/storage 上的 Docker
#    volume mount 整個斷掉, blast radius 太大。
if [ "${KEEP_ROOT:-0}" = "1" ] || [ -f /ktv-data/.run-as-root ]; then
  echo "[entrypoint] 以 root 啟動: $* (KEEP_ROOT=1 或偵測到 .run-as-root flag)"
  exec "$@"
else
  # 預設路徑：仍降權 ktv（與原本行為一致）
  echo "[entrypoint] 切換到 ktv user 啟動: $*"
  exec gosu ktv "$@"
fi
