"""
音訊對齊 helpers (字幕偏移修正 7/26)

這模組只依賴 Python stdlib (wave / struct / math / logging),
可獨立 import 與測試,不需要 demucs/yt_dlp/torch。

被 main.py 的 stage_separate / stage_mix_and_encode 呼叫:
  - trim_wav_to_duration: 層 1 — 杜絕 demucs 預熱 padding
  - leading_silence_seconds: 層 3 — 量測 wav 開頭 silence
  - get_wav_duration_s: 量 wav 實際時長
"""
from __future__ import annotations

import logging
import struct
import wave
from pathlib import Path

logger = logging.getLogger("ktv.alignment")

# 預設 demucs samplerate (Hz)
DEFAULT_DEMUCS_SR = 44100


def get_wav_samples(path: Path) -> int:
    """用 wave (stdlib) 讀 wav 檔的樣本數 (= 每聲道 frames)。"""
    with wave.open(str(path), "rb") as w:
        return w.getnframes()


def get_wav_duration_s(path: Path, samplerate: int = DEFAULT_DEMUCS_SR) -> float:
    """從 wav 檔頭算出實際時長 (秒)。"""
    return get_wav_samples(path) / samplerate


def leading_silence_seconds(
    path: Path,
    samplerate: int = DEFAULT_DEMUCS_SR,
    db_threshold: float = -35.0,
) -> float:
    """量測 wav 開頭 silence 的長度 (秒)。

    Demucs 預熱會在 output 開頭 padding 0.5~1.5s silence，這個 helper
    計算「前幾個 sample 的 RMS 直到超過 db_threshold 為止」的時長，
    給 stage_mix_and_encode 砍掉用。

    退回 0.0 表示無法量測 (讀檔失敗 / 不是 PCM wav)。
    """
    try:
        with wave.open(str(path), "rb") as w:
            nchannels = w.getnchannels()
            sampwidth = w.getsampwidth()
            nframes = w.getnframes()
            if sampwidth != 2:
                # 不是 PCM 16-bit,跳過
                return 0.0
            # 一次讀 0.05s 的 chunk
            chunk_frames = max(1, int(samplerate * 0.05))
            threshold_amp = 10 ** (db_threshold / 20.0)  # -35dB ≈ 0.0178
            threshold_sq = (threshold_amp * 32768) ** 2  # 32768 = 16-bit 最大振幅
            samples_read = 0
            while samples_read < nframes:
                frames_to_read = min(chunk_frames, nframes - samples_read)
                raw = w.readframes(frames_to_read)
                fmt = f"<{frames_to_read * nchannels}h"
                vals = struct.unpack(fmt, raw)
                sum_sq = sum(v * v for v in vals)
                rms_sq = sum_sq / len(vals) if vals else 0
                if rms_sq > threshold_sq:
                    return samples_read / samplerate
                samples_read += frames_to_read
            return float(nframes) / samplerate  # 整檔都是 silence
    except Exception as e:
        logger.warning(f"[對齊] 量測 leading silence 失敗 ({path.name}): {e}")
        return 0.0


def trim_wav_to_duration(
    path: Path,
    target_duration_s: float,
    samplerate: int = DEFAULT_DEMUCS_SR,
) -> None:
    """用 wave 模組直接覆寫 wav 檔,裁切到目標時長。

    Demucs 內部 padding 會讓 wav 比原音訊長,用此 helper 砍尾。
    若 target 比檔案長,則 no-op (取 min)。
    """
    try:
        with wave.open(str(path), "rb") as w_in:
            nchannels = w_in.getnchannels()
            sampwidth = w_in.getsampwidth()
            framerate = w_in.getframerate()
            target_frames = min(w_in.getnframes(), int(target_duration_s * framerate))
            w_in.setpos(0)
            frames = w_in.readframes(target_frames)
        with wave.open(str(path), "wb") as w_out:
            w_out.setnchannels(nchannels)
            w_out.setsampwidth(sampwidth)
            w_out.setframerate(framerate)
            w_out.writeframes(frames)
    except Exception as e:
        logger.warning(f"[對齊] trim_wav_to_duration 失敗 ({path.name}): {e}")


def build_atrim_filter(audio_skip_s: float) -> str:
    """根據要砍掉的 leading silence,產生 ffmpeg filter 片段。

    若 audio_skip_s <= 0.05,回傳空字串 (不砍)。
    否則回傳 'atrim=start=X,asetpts=PTS-STARTPTS' (不帶尾端逗號,由 caller 拼接到 aformat 後)。

    注意:這裡不加尾端逗號是因為 ffmpeg filter graph 會把 ',' 後的下一個東西當 filter 名,
    若呼叫端用 '{trim}[label]' 拼接,中間有 ',' 反而會被解析成空 filter。
    """
    if audio_skip_s <= 0.05:
        return ""
    return f"atrim=start={audio_skip_s:.3f},asetpts=PTS-STARTPTS"


def compute_audio_skip(no_vocals_path: Path, vocals_path: Path) -> float:
    """計算兩個 wav 共同的 leading silence (取小的那個,保守不砍過頭)。

    若量測失敗則回傳 0.0。
    """
    ll_no_vocals = leading_silence_seconds(no_vocals_path, DEFAULT_DEMUCS_SR)
    ll_vocals = leading_silence_seconds(vocals_path, DEFAULT_DEMUCS_SR)
    audio_skip_s = min(ll_no_vocals, ll_vocals)
    if audio_skip_s > 0.05:
        logger.info(
            f"[對齊] 偵測到 leading silence: "
            f"伴奏={ll_no_vocals:.2f}s, 人聲={ll_vocals:.2f}s → "
            f"將砍掉音訊前 {audio_skip_s:.2f}s"
        )
        return audio_skip_s
    return 0.0