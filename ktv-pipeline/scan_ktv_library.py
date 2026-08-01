"""快速掃描現存 mp4 開頭的「影片靜止 + 音訊無聲」長度。

對齊舊版 alignment.py 的「Demucs padding 誤判」場景:
當年舊版會把 mp4 開頭一段誤判為「前奏靜音」並 trim 掉,
導致「影片先有畫面 → 才有人聲/伴奏」,客戶看 0.5s~8s 影音不同步。

此腳本從 mp4 抽出音訊,掃前 1.5s 看實際 silence 區間,
並交叉比對「影片在 0.5s 內是否有非黑幀 (即影片真的開播)」。

判定規則:
  - audio_leading_silence_s > 0.3s → 警告 (可能延遲)
  - audio_leading_silence_s > 1.0s → 確認延遲 (絕對值過大)
  - video_first_change_s vs audio_leading_silence_s 的差 (delay_estimate_s):
      > 0.3s 表示「影片比音訊早開始」→ 確認影音不同步
"""
import json
import subprocess
import sys
import wave
import struct
import math
import os
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

REMOTE_BASE = "/ktv-data/processed"
THRESHOLD_WARN = 0.30
THRESHOLD_FAIL = 1.00


def scan_mp4(mp4_path: Path) -> dict:
    """抽 mp4 音訊 + 掃描前 N 秒 + 比對影片首幀變化時間。"""
    name = mp4_path.name
    result = {
        "name": name,
        "audio_leading_silence_s": None,
        "video_first_change_s": None,
        "delay_estimate_s": None,
        "verdict": "UNKNOWN",
        "error": None,
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            audio_wav = tmp / "audio.wav"
            # 抽音訊 (PCM 16-bit mono 44.1k)
            subprocess.run([
                "ffmpeg", "-y", "-i", str(mp4_path),
                "-vn", "-ac", "1", "-ar", "44100", "-f", "wav",
                str(audio_wav)
            ], check=True, capture_output=True, timeout=60)

            # 量音訊 leading silence (用 alignment.py 同樣的雙準則)
            audio_leading = scan_wav_leading(audio_wav)

            # 用 ffmpeg 黑幀偵測定影片「第一個非黑幀」的時間
            # 黑幀門檻: -30dB pixel difference
            video_change = detect_video_first_nonblack(mp4_path)

            result["audio_leading_silence_s"] = round(audio_leading, 3)
            result["video_first_change_s"] = round(video_change, 3) if video_change is not None else None
            # 延遲估算: 影片比音訊早開始 → delay_estimate = video_change - audio_leading
            if video_change is not None and audio_leading is not None:
                # 影片應該跟著音訊開始;若影片變化遠早於音訊變化,就是「畫先音後」
                delay = audio_leading - video_change
                result["delay_estimate_s"] = round(delay, 3)

                if delay > THRESHOLD_FAIL:
                    result["verdict"] = "FAIL_DELAY"
                elif delay > THRESHOLD_WARN:
                    result["verdict"] = "WARN_DELAY"
                elif audio_leading > THRESHOLD_FAIL:
                    result["verdict"] = "FAIL_SILENCE"
                elif audio_leading > THRESHOLD_WARN:
                    result["verdict"] = "WARN_SILENCE"
                else:
                    result["verdict"] = "OK"
            else:
                # 沒有 video 資訊,只看 audio
                if audio_leading > THRESHOLD_FAIL:
                    result["verdict"] = "FAIL_SILENCE"
                elif audio_leading > THRESHOLD_WARN:
                    result["verdict"] = "WARN_SILENCE"
                else:
                    result["verdict"] = "OK"
    except subprocess.TimeoutExpired:
        result["error"] = "ffmpeg_timeout"
    except subprocess.CalledProcessError as e:
        result["error"] = f"ffmpeg_error: {e.stderr.decode()[:200] if e.stderr else 'unknown'}"
    except Exception as e:
        result["error"] = str(e)
    return result


def scan_wav_leading(wav_path: Path, max_seconds: float = 1.5) -> float:
    """雙準則掃描 wav 前 max_seconds,回傳 leading silence 長度 (秒)。
    模仿 alignment.py 的 RMS + peak 雙準則。
    """
    RMS_DB = -45.0
    PEAK_DB = -30.0
    SR = 44100
    WINDOW_MS = 40
    HOP_MS = 20

    with wave.open(str(wav_path), "rb") as w:
        nframes = w.getnframes()
        nchannels = w.getnchannels()
        if nframes == 0:
            return 0.0
        max_frames = min(nframes, int(max_seconds * SR))
        win = int(SR * WINDOW_MS / 1000)
        hop = int(SR * HOP_MS / 1000)
        rms_thr_sq = (10 ** (RMS_DB / 20.0) * 32768) ** 2
        peak_thr_abs = 10 ** (PEAK_DB / 20.0) * 32768

        hop_start = 0
        while hop_start + win <= max_frames:
            w.setpos(hop_start)
            raw = w.readframes(win)
            if len(raw) < win * nchannels * 2:
                break
            n_samples = win * nchannels
            vals = struct.unpack(f"<{n_samples}h", raw)
            sum_sq = 0
            peak = 0
            for v in vals:
                a = v if v >= 0 else -v
                sum_sq += v * v
                if a > peak:
                    peak = a
            rms_sq = sum_sq / n_samples
            if rms_sq > rms_thr_sq or peak > peak_thr_abs:
                return hop_start / SR
            hop_start += hop
        return float(max_frames) / SR


def detect_video_first_nonblack(mp4_path: Path) -> float:
    """用 ffmpeg blackframe detector 找影片第一個非黑幀的時間。
    黑幀 = 全畫面 < 30/255 亮度。
    """
    try:
        # ffmpeg blackframe filter: 輸出 black frame 的開始/結束時間
        proc = subprocess.run([
            "ffmpeg", "-i", str(mp4_path),
            "-vf", "blackframe=amount=30:threshold=32",
            "-f", "null", "-"
        ], capture_output=True, timeout=60)
        # stderr 格式: [blackframe @ ...] frame:0 pts:0 pts_time:0
        # 我們要的是「第一個非黑幀」的時間 = 0 (因為一開始通常就是黑幀)
        # 改成: 用 select 找第一個 non-black frame 的 pts
        proc2 = subprocess.run([
            "ffmpeg", "-i", str(mp4_path),
            "-vf", "select='gt(scene,0.05)',showinfo",
            "-f", "null", "-"
        ], capture_output=True, timeout=60)
        # showinfo 會印 n:0 pts:XXX pts_time:YYY ...
        # 取第一個 pts_time
        for line in proc2.stderr.decode(errors="ignore").splitlines():
            if "pts_time:" in line and "Parsed_showinfo" in line:
                # 格式: [Parsed_showinfo @ 0x...] n:0 pts:123 pts_time:0.520000 ...
                idx = line.find("pts_time:")
                if idx >= 0:
                    ts = line[idx + len("pts_time:"):].split()[0]
                    return float(ts)
        return 0.0  # 沒找到 (全黑影片或 scene detection 失敗)
    except Exception:
        return None


def main():
    # 透過 SSH 跑: 改成直接讀本地路徑 (scp 進來或跑在 NAS 上)
    # 為了單檔跑得起來,接受 stdin 路徑清單
    paths = [Path(p.strip()) for p in sys.stdin if p.strip()]
    results = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(scan_mp4, p): p for p in paths}
        for fut in as_completed(futures):
            results.append(fut.result())
    # 按 verdict 排序 (FAIL 先出)
    order = {"FAIL_DELAY": 0, "FAIL_SILENCE": 1, "WARN_DELAY": 2, "WARN_SILENCE": 3, "OK": 4, "UNKNOWN": 5}
    results.sort(key=lambda r: (order.get(r["verdict"], 5), r["name"]))
    # 輸出 TSV
    print("verdict\tname\taudio_leading\tdelay_estimate\tvideo_first\terror")
    for r in results:
        print(f"{r['verdict']}\t{r['name']}\t{r['audio_leading_silence_s']}\t{r['delay_estimate_s']}\t{r['video_first_change_s']}\t{r['error'] or ''}")


if __name__ == "__main__":
    main()