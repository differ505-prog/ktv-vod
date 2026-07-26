"""
字幕偏移修正 (7/26) 的單元 + 整合測試。

測試對象 = 真的 production code (從 alignment.py import)。
不再 mirror,確保任何 alignment.py 邏輯改動都會被這個測試抓到。

分層:
  - unit tests: 直接驗 4 個 helper 的純邏輯
  - integration tests: 用 ffmpeg 跑真實合成管線 (silence + signal → mp4),
                       驗證輸出 mp4 開頭不是全無聲 (=「字幕偏移已修」)

跳過條件: 如果 ffmpeg 不在 PATH,整合測試會 skip (本地開發機沒裝也行)。
"""
from __future__ import annotations

import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

# ===== 真實 import (不再 mirror) =====
from alignment import (
    DEFAULT_DEMUCS_SR,
    build_atrim_filter,
    compute_audio_skip,
    get_wav_duration_s,
    get_wav_samples,
    leading_silence_seconds,
    trim_wav_to_duration,
)


# ============================================================
# fixtures: 建各種 wav
# ============================================================

@pytest.fixture
def silent_wav(tmp_path: Path) -> Path:
    """1.0 秒全無聲 wav。"""
    path = tmp_path / "silent.wav"
    sr = DEFAULT_DEMUCS_SR
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * sr)
    return path


@pytest.fixture
def signal_wav_03s_silence(tmp_path: Path) -> Path:
    """1.0s wav: 前 0.3s 無聲, 後 0.7s 方波 (振幅 16384 ≈ -6dBFS)。"""
    path = tmp_path / "signal.wav"
    sr = DEFAULT_DEMUCS_SR
    samples: list[int] = [0] * int(sr * 0.3)
    for i in range(int(sr * 0.7)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        samples.append(v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


@pytest.fixture
def short_signal_wav(tmp_path: Path) -> Path:
    """0.5s wav: 前 0.1s 無聲, 後 0.4s 方波。"""
    path = tmp_path / "short_signal.wav"
    sr = DEFAULT_DEMUCS_SR
    samples: list[int] = [0] * int(sr * 0.1)
    for i in range(int(sr * 0.4)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        samples.append(v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


def _make_sine_wav(path: Path, duration_s: float, freq_hz: float = 440.0, amp: int = 12000) -> None:
    """產生 sine wave wav (16-bit mono, 44100Hz)。"""
    import math
    sr = DEFAULT_DEMUCS_SR
    n = int(sr * duration_s)
    samples = []
    for i in range(n):
        v = int(amp * math.sin(2 * math.pi * freq_hz * i / sr))
        samples.append(v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def _make_silent_color_mp4(path: Path, duration_s: float = 2.0) -> None:
    """用 lavfi 產生 N 秒純色視訊 (無音軌),模擬「下載下來的 karaoke 視訊」。"""
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi",
        "-i", f"color=c=red:size=320x240:rate=30:duration={duration_s}",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"建立測試視訊失敗: {result.stderr}"


# ============================================================
# 層 1: trim_wav_to_duration
# ============================================================

def test_trim_shortens_long_file(silent_wav: Path):
    trim_wav_to_duration(silent_wav, 0.5)
    dur = get_wav_duration_s(silent_wav)
    assert abs(dur - 0.5) < 0.01, f"預期 ~0.5s,實際 {dur:.3f}s"


def test_trim_no_op_when_target_larger(silent_wav: Path):
    trim_wav_to_duration(silent_wav, 5.0)
    dur = get_wav_duration_s(silent_wav)
    assert abs(dur - 1.0) < 0.01, f"預期維持 ~1.0s,實際 {dur:.3f}s"


def test_trim_preserves_channels(silent_wav: Path):
    """trim 後 wav 仍是 mono/16bit (聲道數與 bit depth 不變)。"""
    trim_wav_to_duration(silent_wav, 0.3)
    with wave.open(str(silent_wav), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2


# ============================================================
# 層 3: leading_silence_seconds
# ============================================================

def test_leading_silence_detects_03s_silence(signal_wav_03s_silence: Path):
    ll = leading_silence_seconds(signal_wav_03s_silence)
    assert 0.25 < ll < 0.35, f"預期 ~0.3s,實際 {ll:.3f}s"


def test_leading_silence_returns_full_duration_for_pure_silent(silent_wav: Path):
    ll = leading_silence_seconds(silent_wav)
    assert abs(ll - 1.0) < 0.05, f"預期 ~1.0s,實際 {ll:.3f}s"


def test_leading_silence_handles_short_signal(short_signal_wav: Path):
    ll = leading_silence_seconds(short_signal_wav)
    assert 0.05 < ll < 0.15, f"預期 ~0.1s,實際 {ll:.3f}s"


def test_leading_silence_threshold_filters_quiet(tmp_path: Path):
    """0.2s 無聲 + 0.2s -40dBFS 微聲,在 -35dB threshold 下,微聲也算 silence。"""
    path = tmp_path / "quiet.wav"
    sr = DEFAULT_DEMUCS_SR
    amp = 327  # -40dBFS
    samples = [0] * int(sr * 0.2)
    for _ in range(int(sr * 0.2)):
        samples.append(amp)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))

    ll = leading_silence_seconds(path)
    assert ll > 0.3, f"預期視為 silence (>0.3s),實際 {ll:.3f}s"


def test_leading_silence_returns_zero_for_missing_file(tmp_path: Path):
    """讀檔失敗 → 回傳 0.0 (不 raise)。"""
    ll = leading_silence_seconds(tmp_path / "nonexistent.wav")
    assert ll == 0.0


# ============================================================
# helper: build_atrim_filter
# ============================================================

def test_build_atrim_filter_returns_empty_for_small_skip():
    assert build_atrim_filter(0.0) == ""
    assert build_atrim_filter(0.05) == ""
    assert build_atrim_filter(-1.0) == ""


def test_build_atrim_filter_returns_trim_for_large_skip():
    result = build_atrim_filter(0.5)
    assert "atrim=start=0.500" in result
    assert "asetpts=PTS-STARTPTS" in result


# ============================================================
# helper: compute_audio_skip
# ============================================================

def test_compute_audio_skip_returns_min_of_two(tmp_path: Path):
    """伴奏 1.2s silence / 人聲 0.8s silence → 取小 (0.8)。"""
    sr = DEFAULT_DEMUCS_SR
    no_v = tmp_path / "no_v.wav"
    voc = tmp_path / "voc.wav"
    # 伴奏:1.2s 無聲 + 0.8s 方波
    s1 = [0] * int(sr * 1.2)
    for i in range(int(sr * 0.8)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        s1.append(v)
    with wave.open(str(no_v), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(s1)}h", *s1))
    # 人聲:0.8s 無聲 + 0.8s 方波
    s2 = [0] * int(sr * 0.8)
    for i in range(int(sr * 0.8)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        s2.append(v)
    with wave.open(str(voc), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(s2)}h", *s2))

    skip = compute_audio_skip(no_v, voc)
    assert 0.75 < skip < 0.85, f"預期 ~0.8s,實際 {skip:.3f}s"


def test_compute_audio_skip_returns_zero_when_both_clean(tmp_path: Path):
    """兩個 wav 都直接從頭有聲 → skip = 0.0。"""
    sr = DEFAULT_DEMUCS_SR
    no_v = tmp_path / "no_v_clean.wav"
    voc = tmp_path / "voc_clean.wav"
    _make_sine_wav(no_v, 1.0)
    _make_sine_wav(voc, 1.0)
    skip = compute_audio_skip(no_v, voc)
    assert skip == 0.0, f"預期 0.0,實際 {skip:.3f}s"


# ============================================================
# 整合 (需 ffmpeg): 模擬 demucs 開頭 padding + ffmpeg atrim
# ============================================================

@pytest.fixture(scope="module")
def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg 不在 PATH,跳過整合測試",
)
def test_demucs_padding_simulation_trim_only(tmp_path: Path):
    """模擬 demucs 預熱 padding (1s silence + 2s 真實音訊),trim 校正後長度正確。"""
    sr = DEFAULT_DEMUCS_SR
    sim_path = tmp_path / "sim_demucs_out.wav"
    samples: list[int] = [0] * int(sr * 1.0)
    for i in range(int(sr * 2.0)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        samples.append(v)
    with wave.open(str(sim_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))

    ll = leading_silence_seconds(sim_path)
    assert abs(ll - 1.0) < 0.05

    trim_wav_to_duration(sim_path, 2.0)
    dur = get_wav_duration_s(sim_path)
    assert abs(dur - 2.0) < 0.01


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None,
    reason="ffmpeg 不在 PATH,跳過整合測試",
)
def test_atrim_filter_cuts_leading_silence_in_mp4(tmp_path: Path):
    """
    端到端驗證「字幕偏移已修」:
    1) 產生 2.0s 純色視訊 (紅,無音軌) → video.mp4
    2) 產生 2.0s 伴奏 wav (前 0.3s 無聲,後 1.7s sine)
    3) 產生 2.0s 人聲 wav (前 0.3s 無聲,後 1.7s sine,不同頻率)
    4) 模擬 ffmpeg 合成:用 build_atrim_filter 算出 0.300s skip,
       真的跑 ffmpeg 把三者合併成 mp4
    5) 用 ffmpeg volumedetect 量輸出 mp4 前 0.2s 的 RMS
       若 > -30dB → 表示「開頭已被人聲/伴奏填滿」,字幕同步問題已修
    """
    sr = DEFAULT_DEMUCS_SR
    video = tmp_path / "video.mp4"
    no_v = tmp_path / "no_v.wav"
    voc = tmp_path / "voc.wav"
    output = tmp_path / "merged.mp4"

    _make_silent_color_mp4(video, duration_s=2.0)

    # 伴奏:0.3s 無聲 + 1.7s 440Hz sine
    samples_a = [0] * int(sr * 0.3)
    import math
    for i in range(int(sr * 1.7)):
        v = int(12000 * math.sin(2 * math.pi * 440.0 * i / sr))
        samples_a.append(v)
    with wave.open(str(no_v), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples_a)}h", *samples_a))

    # 人聲:0.3s 無聲 + 1.7s 880Hz sine
    samples_b = [0] * int(sr * 0.3)
    for i in range(int(sr * 1.7)):
        v = int(12000 * math.sin(2 * math.pi * 880.0 * i / sr))
        samples_b.append(v)
    with wave.open(str(voc), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples_b)}h", *samples_b))

    # 計算 skip
    skip = compute_audio_skip(no_v, voc)
    assert 0.25 < skip < 0.35, f"預期 ~0.3s skip,實際 {skip:.3f}s"
    trim = build_atrim_filter(skip)
    assert trim, "atrim filter 應為非空"

    # 真的跑 ffmpeg 合成
    a_cc = f"[1:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo,{trim}[a_cc];"
    v_cc = f"[2:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo,{trim}[v_cc];"
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video),
        "-i", str(no_v),
        "-i", str(voc),
        "-filter_complex",
        f"{a_cc}{v_cc}[a_cc][v_cc]amerge=inputs=2,pan=stereo|c0=c0|c1=c2[out]",
        "-map", "0:v",
        "-map", "[out]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        str(output),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    assert result.returncode == 0, f"ffmpeg 合成失敗:\n{result.stderr}"
    assert output.exists() and output.stat().st_size > 1000

    # 量前 0.2s 的 mean_volume
    detect_cmd = [
        "ffmpeg", "-i", str(output),
        "-af", "atrim=start=0:end=0.2,volumedetect",
        "-f", "null", "-",
    ]
    detect_result = subprocess.run(detect_cmd, capture_output=True, text=True)
    assert detect_result.returncode == 0, f"ffmpeg volumedetect 失敗:\n{detect_result.stderr}"
    stderr = detect_result.stderr

    # 解析 mean_volume (e.g. "mean_volume: -12.3 dB")
    import re
    m = re.search(r"mean_volume:\s*(-?\d+\.?\d*)\s*dB", stderr)
    assert m, f"找不到 mean_volume,輸出:\n{stderr[-800:]}"
    mean_db = float(m.group(1))
    # -30dB 是因為 sine 振幅 12000/32768 ≈ -8.7dBFS, stereo pan 後約 -12dBFS,
    # 即使有 atrim 切到開頭,前 0.2s 應該已被訊號填滿 → 不會低於 -30dB
    assert mean_db > -30.0, (
        f"mp4 開頭 0.2s mean_volume={mean_db}dB 過低,可能字幕偏移未修"
    )
    print(f"\n[整合測試] atrim 後 mp4 開頭 0.2s mean_volume = {mean_db:.1f}dB (✓)")