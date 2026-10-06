#!/usr/bin/env python3
"""
transcode_av1_to_h264.py — 掃描 VIDEO_DIR 內 mp4, 把 AV1/VP9/HEVC 自動轉成 H.264。

問題脈絡:
  之前的 pipeline 下載 YouTube 影片時用 `-c:v copy` (不重新編碼),
  所以 YouTube 預設下載的 AV1 mp4 直接進 VIDEO_DIR。
  iOS Safari / 舊 Android Chrome 不支援 AV1 → video.error → tv 端立刻切歌。
  本腳本把已存在的 AV1/VP9/HEVC mp4 批次重編成 libx264,
  同時保留原始檔 (備份到 .bak.<timestamp>) 給復原用。

用法:
  python transcode_av1_to_h264.py                  # 乾跑 (dry run, 只列出需要轉的)
  python transcode_av1_to_h264.py --apply          # 真的執行轉檔
  python transcode_av1_to_h264.py --apply VIDEO_DIR
  python transcode_av1_to_h264.py --apply --keep-original   # 保留原始 mp4 (備份成 .bak)
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("transcode-av1")

# 要轉檔的 codec (不支援的瀏覽器相容性差)
NEEDS_TRANSCODE = {"av1", "av01", "vp9", "vp09", "hevc", "h265", "hvc1"}


def probe_codec_name(mp4_path: Path) -> str:
    """ffprobe 第一個視訊軌的 codec_name, 失敗回空字串"""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=nw=1:nk=1",
        str(mp4_path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout or ""
        return out.strip().lower()
    except Exception as e:
        log.warning("ffprobe 失敗 %s: %s", mp4_path.name, e)
        return ""


def transcode_to_h264(src: Path, keep_original: bool) -> bool:
    """
    把 src 轉成 libx264 H.264, 直接覆蓋原檔 (或保留 .bak)。
    回傳 True = 成功。
    """
    tmp = src.with_name(src.stem + ".transcoding.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src),
        "-map", "0:v:0",
        "-map", "0:a?",          # 若有音軌就保留 (KTV mp4 通常無音, 為保險加 ? 處理)
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",   # iOS 嚴格要求
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        str(tmp),
    ]
    log.info("轉檔中: %s", src.name)
    log.debug("ffmpeg cmd: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if proc.returncode != 0:
        log.error("ffmpeg 失敗 rc=%s stderr=%s", proc.returncode, (proc.stderr or "")[-500:])
        if tmp.exists():
            tmp.unlink()
        return False
    if not tmp.exists() or tmp.stat().st_size == 0:
        log.error("轉檔產出為空: %s", src.name)
        if tmp.exists():
            tmp.unlink()
        return False

    if keep_original:
        bak = src.with_suffix(src.suffix + f".bak.{int(time.time())}")
        shutil.move(str(src), str(bak))
        log.info("保留原始: %s", bak.name)
    else:
        src.unlink()

    shutil.move(str(tmp), str(src))
    new_size_mb = src.stat().st_size / 1024 / 1024
    log.info("轉檔完成: %s (%.1f MB)", src.name, new_size_mb)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="VIDEO_DIR 內 mp4 → AV1/VP9/HEVC 自動轉 H.264")
    ap.add_argument(
        "video_dir",
        nargs="?",
        default=os.environ.get("VIDEO_DIR", "/ktv-data/processed"),
        help="VIDEO_DIR 位置 (預設 /ktv-data/processed 或 $VIDEO_DIR)",
    )
    ap.add_argument("--apply", action="store_true", help="預設是 dry-run, 加此參數才真的轉")
    ap.add_argument("--keep-original", action="store_true", help="保留原始檔 (備份成 .bak.<ts>)")
    ap.add_argument("--limit", type=int, default=0, help="最多處理 N 個檔 (0 = 不限)")
    args = ap.parse_args()

    video_dir = Path(args.video_dir)
    if not video_dir.is_dir():
        log.error("VIDEO_DIR 不存在: %s", video_dir)
        return 2

    # 找出所有 mp4 (排除備份 .bak / 暫存 .transcoding.tmp)
    mp4_files = sorted([
        p for p in video_dir.iterdir()
        if p.suffix == ".mp4"
        and ".bak." not in p.name
        and ".transcoding.tmp" not in p.name
    ])
    log.info("VIDEO_DIR=%s 共 %d 個 mp4", video_dir, len(mp4_files))

    # 第一輪: ffprobe codec, 列出需要轉檔的
    needs: list[tuple[Path, str]] = []
    for p in mp4_files:
        codec = probe_codec_name(p)
        if codec in NEEDS_TRANSCODE:
            needs.append((p, codec))
            log.info("需轉檔: %s (codec=%s)", p.name, codec)
        else:
            log.debug("跳過: %s (codec=%s)", p.name, codec or "?")

    log.info("=== 總計 %d 個需要轉檔 (共 %d mp4) ===", len(needs), len(mp4_files))
    if not args.apply:
        log.info("DRY-RUN 模式 (沒加 --apply), 沒實際改動。加 --apply 才真的轉。")
        return 0

    if args.limit > 0:
        needs = needs[: args.limit]
        log.info("--limit=%d, 只處理前 %d 個", args.limit, len(needs))

    ok = 0
    fail = 0
    for p, codec in needs:
        if transcode_to_h264(p, args.keep_original):
            ok += 1
        else:
            fail += 1
    log.info("=== 結果: 成功 %d / 失敗 %d ===", ok, fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())