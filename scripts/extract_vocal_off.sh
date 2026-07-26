#!/usr/bin/env bash
#
# 為現有的 *_ktv.mp4 (L=伴奏, R=人聲) 抽出「純伴奏」版本。
# 產出 <name>_vocal_off.mp4：視訊直接 copy，音訊是 L 通道複製到 LR 兩聲道。
#
# 用法：
#   ./scripts/extract_vocal_off.sh              # 處理 videos/ 下所有 *_ktv.mp4
#   ./scripts/extract_vocal_off.sh videos/foo_ktv.mp4   # 處理單支
#
# 需求：videos/ 目錄可寫，ffmpeg >= 4.x
set -euo pipefail

VIDEO_DIR="${VIDEO_DIR:-./videos}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[extract_vocal_off] 找不到 ffmpeg，請先安裝" >&2
  exit 1
fi

mkdir -p "$VIDEO_DIR"

# 收集要處理的 mp4
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  # 把相對路徑轉成 VIDEO_DIR 內的檔名
  TARGETS=()
  while IFS= read -r f; do
    TARGETS+=("$f")
  done < <(find "$VIDEO_DIR" -maxdepth 1 -type f -name '*_ktv.mp4' | sort)
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "[extract_vocal_off] 找不到 *_ktv.mp4，沒事可做"
  exit 0
fi

for src in "${TARGETS[@]}"; do
  # 只處理 _ktv.mp4
  case "$src" in
    *_ktv.mp4) ;;
    *)
      echo "[extract_vocal_off] 跳過非 _ktv.mp4: $src"
      continue
      ;;
  esac

  base="${src%_ktv.mp4}"
  out="${base}_vocal_off.mp4"

  if [ -f "$out" ]; then
    echo "[extract_vocal_off] 已存在，跳過：$(basename "$out")"
    continue
  fi

  echo "[extract_vocal_off] $(basename "$src") → $(basename "$out")"
  # -i src       視訊 + 音訊
  # -map 0:v     直接 copy 視訊（不重編碼，速度秒回）
  # -filter_complex [0:a]pan=stereo|c0=c0|c1=c0[a]
  #   把 L channel 同時複製到 LR → 整支 mp4 是「雙聲道伴奏版」
  # -map [a]     使用 pan 處理過的音訊
  # -c:a aac -b:a 192k   重新編碼為 AAC
  # -shortest    取最短媒體（避免音訊比視訊長）
  # -movflags +faststart  改寫 moov box 到檔頭，網頁播放首幀更快
  ffmpeg -y -i "$src" \
    -map 0:v -c:v copy \
    -filter_complex "[0:a]pan=stereo|c0=c0|c1=c0[a]" \
    -map "[a]" -c:a aac -b:a 192k -ar 44100 -ac 2 \
    -shortest -movflags +faststart \
    "$out" \
    -loglevel error -stats

  if [ -f "$out" ]; then
    size_mb=$(du -m "$out" | cut -f1)
    echo "[extract_vocal_off] 完成：$(basename "$out") (${size_mb} MB)"
  else
    echo "[extract_vocal_off] 失敗：$out 未產出" >&2
    exit 1
  fi
done

echo "[extract_vocal_off] 全部完成 ✓"