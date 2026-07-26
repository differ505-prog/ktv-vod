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

echo "[entrypoint] 切換到 ktv user 啟動: $*"
# 3. 切換到 ktv user 執行 CMD
exec gosu ktv "$@"
