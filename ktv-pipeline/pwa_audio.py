#!/usr/bin/env python3
"""
PWA audio extraction: 把 mp4 抽成 iOS PWA 背景播放用的 .m4a。

為什麼需要這個?
  iOS Safari 的 <audio> element **只吃 plain AAC/MP3 container**,
  不支援 mp4 容器裡的 AAC。所以即使 tv.html 切 audio-mode 用 <audio>,
  如果 src=*.mp4, iOS 會回「格式不支援」而整個黑畫。
  → 必須預先抽成 .m4a (這就是一個 plain AAC in MP4 container 但只有音軌)。

怎麼抽:
  - audio-original.m4a = mp4 的 L+R mixed → mono (原唱)
  - audio-vocal-off.m4a = mp4 的 L (伴奏 stereo → mono)

Pipeline 的 mp4 是 L=伴奏, R=人聲 (見 main.py stage_mix_and_encode),所以:

  ffmpeg -i in.mp4 -map 0:a:0 -ac 2 -filter_complex \
    "[0:a:0]pan=mono|c0=0.5*c0+0.5*c1[orig]" \
    -map "[orig]" -c:a aac -b:a 192k audio-original.m4a

  ffmpeg -i in.mp4 -map 0:a:0 -ac 1 -filter_complex \
    "[0:a:0]pan=mono|c0=c0[voc]" \
    -map "[voc]" -c:a aac -b:a 192k audio-vocal-off.m4a

執行:
  python3 pwa_audio.py --video-dir /Volumes/KTV/Videos --output-dir /Volumes/KTV/Audio
  或在 NAS 上跑 ssh batch。
"""
import argparse
import subprocess
import sys
from pathlib import Path
import json
import time


def extract_one(mp4_path: Path, out_dir: Path) -> dict:
    """抽出一首歌的兩個 .m4a,回傳 result dict。"""
    name = mp4_path.stem
    out_orig = out_dir / f"{name}.m4a"
    out_voc = out_dir / f"{name}-vocal-off.m4a"

    # 若已存在且 mtime 比 mp4 新 → 跳過 (idempotent)
    try:
        if out_orig.exists() and out_orig.stat().st_mtime >= mp4_path.stat().st_mtime \
           and out_voc.exists() and out_voc.stat().st_mtime >= mp4_path.stat().st_mtime:
            return {"name": name, "skipped": True}
    except Exception:
        pass

    # 1) audio-original.m4a (L+R → mono,完整原唱)
    # 用 filter_complex + map [a]:避免 mp4 muxer 帶第二 audio track。
    # -vn:no video,  -f mp4:強制 mp4 muxer,即便無 video stream。
    cmd_orig = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(mp4_path),
        "-filter_complex", "[0:a:0]pan=mono|c0=0.5*c0+0.5*c1[a]",
        "-map", "[a]",
        "-c:a", "aac", "-b:a", "192k",
        "-vn", "-f", "mp4",
        str(out_orig),
    ]
    r1 = subprocess.run(cmd_orig, capture_output=True, text=True, timeout=180)

    # 2) audio-vocal-off.m4a (L → mono,僅伴奏)
    cmd_voc = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(mp4_path),
        "-af", "pan=mono|c0=c0",
        "-c:a", "aac", "-b:a", "192k",
        "-vn", "-f", "mp4",
        str(out_voc),
    ]
    r2 = subprocess.run(cmd_voc, capture_output=True, text=True, timeout=180)

    ok = r1.returncode == 0 and r2.returncode == 0
    return {
        "name": name,
        "ok": ok,
        "orig_size": out_orig.stat().st_size if out_orig.exists() else 0,
        "voc_size": out_voc.stat().st_size if out_voc.exists() else 0,
        "orig_err": r1.stderr if not r1.returncode == 0 else None,
        "voc_err": r2.stderr if not r2.returncode == 0 else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=0, help="只處理前 N 個,0=全部")
    parser.add_argument("--report", type=str, default="", help="輸 JSON 報告到這檔路")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)

    mp4s = sorted(args.video_dir.glob("*.mp4"))
    if args.limit > 0:
        mp4s = mp4s[:args.limit]

    print(f"[pwa-audio] 處理 {len(mp4s)} 個 mp4 → {args.output_dir}")
    results = []
    t0 = time.time()
    for i, mp4 in enumerate(mp4s, 1):
        try:
            r = extract_one(mp4, args.output_dir)
            results.append(r)
            if i % 20 == 0 or i == len(mp4s):
                elapsed = time.time() - t0
                print(f"  [{i}/{len(mp4s)}] {r['name']} ok={r.get('ok')} skipped={r.get('skipped')} ({elapsed:.1f}s)")
        except subprocess.TimeoutExpired:
            print(f"  [{i}/{len(mp4s)}] TIMEOUT: {mp4.name}")
            results.append({"name": mp4.stem, "ok": False, "err": "timeout"})
        except Exception as e:
            print(f"  [{i}/{len(mp4s)}] ERROR: {mp4.name}: {e}")
            results.append({"name": mp4.stem, "ok": False, "err": str(e)})

    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"[pwa-audio] 完成 {sum(1 for r in results if r.get('ok'))}/{len(results)} 首")


if __name__ == "__main__":
    main()
