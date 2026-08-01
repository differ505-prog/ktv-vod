#!/usr/bin/env python3
"""
batch_backfill.py — 把已存在的 _ktv.mp4 補上 metadata .json

設計:
  - 不下載影片、不跑 demucs、不呼叫 YouTube API
  - 從檔名解析 (sanitize_filename 後) 切出歌名 / 歌手
  - 轉拼音 (沒網路也能跑)
  - 產生的 .json 給 Node 中控直接讀

用法:
  python batch_backfill.py /ktv-data/processed/

回傳 0 表示全部補完, 1 表示部分失敗
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

# 確保可 import metadata.py (同目錄)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from metadata import (
    SongMetadata,
    parse_yt_title,
    sanitize_filename,
    to_pinyin,
    write_metadata_file,
)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("batch_backfill")


def _ffprobe_duration(mp4_path: Path) -> int | None:
    """用 ffprobe 量 mp4 時長 (秒),失敗回 None。"""
    try:
        import subprocess
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(mp4_path),
            ],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return int(float(r.stdout.strip()))
    except Exception:
        pass
    return None


def build_from_filename(mp4_path: Path) -> SongMetadata:
    """
    用 _ktv.mp4 的檔名推 metadata:
       周杰倫_夜曲_ktv.mp4 -> title=夜曲, artist=周杰倫
       周杰倫 - 夜曲_ktv.mp4 -> title=夜曲, artist=周杰倫
    """
    stem = mp4_path.stem.replace("_ktv", "").replace("_vocal_off", "")

    # 用 sanitize 的反向 — 把「_」變回可能的分隔,再做 parse_yt_title
    # 直接試兩種: (a) 整個 stem 是 raw title; (b) stem 是「歌手_歌名_…」換成「-」格式
    raw_title = stem.replace("_", " - ", 1).replace("_", " ")  # 「_」先轉一次 " - "
    parsed_title, parsed_artist = parse_yt_title(raw_title)

    duration_s = _ffprobe_duration(mp4_path)

    return SongMetadata(
        title=parsed_title,
        artist=parsed_artist,
        raw_title=stem,
        channel=None,
        album=None,
        cover=None,
        duration=duration_s,
        pinyin_title=to_pinyin(parsed_title),
        pinyin_artist=to_pinyin(parsed_artist) if parsed_artist else "",
        youtube_id=None,
        source="local",
    )


def main(processed_dir: str | os.PathLike, dry_run: bool = False) -> int:
    p = Path(processed_dir)
    if not p.exists():
        log.error(f"目錄不存在: {p}")
        return 1

    # 找所有 _ktv.mp4 (排除 _vocal_off 變體)
    mp4s = sorted(mp4 for mp4 in p.glob("*_ktv.mp4") if "_vocal_off" not in mp4.stem)
    log.info(f"找到 {len(mp4s)} 首歌 (排除 _vocal_off)")

    if not mp4s:
        log.warning("沒有任何 _ktv.mp4 可處理")
        return 0

    ok = 0
    skip = 0
    fail = []

    for mp4 in mp4s:
        sanitized_name = mp4.stem  # e.g. "周杰倫_夜曲_ktv" -> basename 給 metadata

        # 已經有 metadata 的就跳過
        meta_path = p / f"{mp4.stem.replace('_ktv', '')}.json"
        if meta_path.exists():
            log.debug(f"[skip] 已有 metadata: {meta_path.name}")
            skip += 1
            continue

        try:
            metadata = build_from_filename(mp4)
            if dry_run:
                log.info(f"[dry-run] {mp4.name} → title={metadata.title!r}, artist={metadata.artist!r}")
            else:
                # 寫到 sanitized_stem.json
                sanitized_stem = mp4.stem.replace("_ktv", "")
                target = p / f"{sanitized_stem}.json"
                with open(target, "w", encoding="utf-8") as f:
                    json.dump(metadata.to_dict(), f, ensure_ascii=False, indent=2)
                ok += 1
                log.info(
                    f"[ok] {mp4.name[:50]}... → {metadata.artist or '?'} - {metadata.title}"
                )
        except Exception as e:
            log.warning(f"[fail] {mp4.name}: {e}")
            fail.append(mp4.name)

    log.info("=" * 50)
    log.info(f"完成: 補 {ok} 首 / 跳過 {skip} 首 / 失敗 {len(fail)} 首")
    if fail:
        for n in fail[:5]:
            log.info(f"  ! {n}")
    return 0 if not fail else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python batch_backfill.py <processed_dir> [--dry-run]")
        sys.exit(1)

    dry = "--dry-run" in sys.argv
    target = sys.argv[1]
    sys.exit(main(target, dry_run=dry))
