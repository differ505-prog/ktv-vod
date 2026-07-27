"""
字幕偏移修正 (7/26, 9.0/10 重構版) 的單元 + 整合測試。

測試對象 = 真的 production code (從 alignment.py import)。
不再 mirror,確保任何 alignment.py 邏輯改動都會被這個測試抓到。

分層:
  - 既有測試 (legacy path): 不傳 config → 走舊版單一 RMS 路徑 → 期望值不變
  - 新版測試 (v2 path): 傳 AlignmentConfig → 走 dual-criterion 路徑
  - 整合測試: 用 ffmpeg 跑真實合成管線 (silence + signal → mp4),
              驗證輸出 mp4 開頭不是全無聲 (=「字幕偏移已修」)

跳過條件: 如果 ffmpeg 不在 PATH,整合測試會 skip (本地開發機沒裝也行)。
"""
from __future__ import annotations

import math
import re
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest

# ===== 真實 import (不再 mirror) =====
from alignment import (
    DEFAULT_CONFIG,
    DEFAULT_DEMUCS_SR,
    AlignmentConfig,
    build_atrim_filter,
    compute_audio_skip,
    diagnose_wav,
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


def _make_sine_wav(
    path: Path,
    duration_s: float,
    freq_hz: float = 440.0,
    amp: int = 12000,
    leading_silence_s: float = 0.0,
) -> None:
    """產生 sine wave wav (16-bit mono, 44100Hz),可選 leading silence。"""
    sr = DEFAULT_DEMUCS_SR
    samples: list[int] = [0] * int(sr * leading_silence_s)
    for i in range(int(sr * duration_s)):
        v = int(amp * math.sin(2 * math.pi * freq_hz * i / sr))
        samples.append(v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def _make_piano_fade_in_wav(
    path: Path,
    silence_s: float = 0.4,
    fade_s: float = 0.3,
    sustain_s: float = 0.5,
    final_amp: int = 4000,  # ~ -18 dBFS peak,但 RMS 較低 (sine 風格)
) -> Path:
    """模擬「鋼琴/弦樂漸入」: 前 silence_s 全無聲,接下來 fade_s 線性 fade in,
    最後 sustain_s 維持 final_amp 的 sine。

    RMS 在 fade 期間: 約 0.4 * final_amp (~-28 dBFS),超過新 RMS threshold -45dBFS,
    但 PEAK 也跟著從 0 線性增加到 final_amp。

    注意:這是「弱能量漸入」的模擬,測新版 dual-criterion 不會把它誤判為 silence。
    """
    sr = DEFAULT_DEMUCS_SR
    n_silence = int(sr * silence_s)
    n_fade = int(sr * fade_s)
    n_sustain = int(sr * sustain_s)
    samples: list[int] = [0] * n_silence
    for i in range(n_fade):
        progress = (i + 1) / n_fade
        v = int(final_amp * progress * math.sin(2 * math.pi * 440.0 * i / sr))
        samples.append(v)
    for i in range(n_sustain):
        v = int(final_amp * math.sin(2 * math.pi * 440.0 * (i + n_fade) / sr))
        samples.append(v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return path


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
# 注意:這層測試不傳 config → 走舊版單一 RMS 路徑 (向後相容),
#       期望值與舊版一致。

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
    assert build_atrim_filter(0.02) == ""  # < 新的 min_skip_s = 0.03
    assert build_atrim_filter(-1.0) == ""


def test_build_atrim_filter_returns_trim_for_large_skip():
    result = build_atrim_filter(0.5)
    assert "atrim=start=0.500" in result
    assert "asetpts=PTS-STARTPTS" in result


def test_build_atrim_filter_respects_custom_min_skip():
    """caller 可自訂 min_skip_s (給測試或特殊場景用)。"""
    assert build_atrim_filter(0.04, min_skip_s=0.05) == ""
    assert build_atrim_filter(0.06, min_skip_s=0.05) != ""


# ============================================================
# helper: compute_audio_skip (legacy path, 既有測試相容)
# ============================================================

def test_compute_audio_skip_returns_min_of_two(tmp_path: Path):
    """伴奏 0.20s silence / 人聲 0.15s silence → 取小 (0.15)。
    兩個 wav 都「在 Demucs padding 範圍內」(≤ 0.25s),測試新版 min 邏輯。

    注意:舊測試故意用 1.2s/0.8s 是為了「碰過 max=0.3 上限」,但新版 max=0.25s
    會直接擋掉 → 那種極端案例現在由 test_v2_rejects_long_leading_silence_as_real_intro
    專門測試 (鋼琴漸入 0.4s 被正確判定為歌曲前奏)。"""
    sr = DEFAULT_DEMUCS_SR
    no_v = tmp_path / "no_v.wav"
    voc = tmp_path / "voc.wav"
    # 伴奏:0.20s 無聲 + 0.8s 方波
    s1 = [0] * int(sr * 0.20)
    for i in range(int(sr * 0.8)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        s1.append(v)
    with wave.open(str(no_v), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(s1)}h", *s1))
    # 人聲:0.15s 無聲 + 0.85s 方波
    s2 = [0] * int(sr * 0.15)
    for i in range(int(sr * 0.85)):
        v = 16384 if (i // 100) % 2 == 0 else -16384
        s2.append(v)
    with wave.open(str(voc), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(s2)}h", *s2))

    skip = compute_audio_skip(no_v, voc)
    # 放寬到 ±0.04s,容忍 window/hop 邊界
    assert 0.11 < skip < 0.20, f"預期 ~0.15s,實際 {skip:.3f}s"


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
# v2 (新版): AlignmentConfig + dual-criterion
# ============================================================

def test_v2_detects_demucs_padding_within_range(tmp_path: Path):
    """Demucs padding 0.18s (典型情況): 兩個 wav 都前 0.18s 無聲,
    → 應回傳 ~0.18s (在 max_demucs_padding_s=0.25 範圍內)。"""
    no_v = tmp_path / "no_v.wav"
    voc = tmp_path / "voc.wav"
    _make_sine_wav(no_v, 1.0, leading_silence_s=0.18)
    _make_sine_wav(voc, 1.0, freq_hz=880.0, leading_silence_s=0.18)

    skip = compute_audio_skip(no_v, voc, config=DEFAULT_CONFIG)
    # ±0.04s 容錯 (window/hop 邊界)
    assert 0.14 < skip < 0.22, f"預期 ~0.18s,實際 {skip:.3f}s"


def test_v2_rejects_long_leading_silence_as_real_intro(tmp_path: Path):
    """歌曲本身前奏 0.4s 漸入 (鋼琴/弦樂):
    - 舊版 -35dB threshold 會誤判為 silence (因為鋼琴漸入能量低)
    - 新版 dual-criterion (-45dB RMS + -30dB peak) 應該偵測到 peak
    → 不應該誤砍,但也不應該誤判成「0.4s silence」要砍。"""
    piano_path = _make_piano_fade_in_wav(
        tmp_path / "piano.wav",
        silence_s=0.4,
        fade_s=0.3,
        sustain_s=0.5,
        final_amp=4000,
    )
    # 同樣的鋼琴漸入 (人聲軌用相同設定模擬分離後的 vocals)
    voc_path = _make_piano_fade_in_wav(
        tmp_path / "piano_voc.wav",
        silence_s=0.4,
        fade_s=0.3,
        sustain_s=0.5,
        final_amp=3500,
    )

    # 先確認新版 dual-criterion 能正確量到 leading silence (~0.4s)
    diag_no_v = diagnose_wav(piano_path, config=DEFAULT_CONFIG)
    # leading silence 應該 ~0.4s (不是 0.0 或 1.2s)
    assert 0.35 < diag_no_v["leading_silence_s"] < 0.55, (
        f"新版 detector 應偵測到 ~0.4s 鋼琴漸入,實際 {diag_no_v['leading_silence_s']:.3f}s"
    )

    # 然後 compute_audio_skip 應該判定「超過 max_demucs_padding_s=0.25,不砍」
    skip = compute_audio_skip(piano_path, voc_path, config=DEFAULT_CONFIG)
    assert skip == 0.0, (
        f"鋼琴漸入 0.4s 應判定為歌曲前奏,不該砍,實際 skip={skip:.3f}s"
    )


def test_v2_cross_channel_inconsistency_returns_zero(tmp_path: Path):
    """vocals / no_vocals 落差 > cross_channel_tolerance_s (0.15s):
    Demucs 兩個分離器行為不一致 → 共同 leading silence 不存在 → 不砍。"""
    no_v = tmp_path / "no_v_inconsistent.wav"
    voc = tmp_path / "voc_inconsistent.wav"
    # 伴奏:0.10s silence (Demucs padding)
    _make_sine_wav(no_v, 1.0, leading_silence_s=0.10)
    # 人聲:0.40s silence (Demucs 在 vocals 軌預熱更長)
    _make_sine_wav(voc, 1.0, freq_hz=880.0, leading_silence_s=0.40)

    skip = compute_audio_skip(no_v, voc, config=DEFAULT_CONFIG)
    assert skip == 0.0, (
        f"cross-channel 落差 0.30s 超過 tolerance 0.15s,應回傳 0.0,實際 {skip:.3f}s"
    )


def test_v2_fully_silent_wav_returns_zero(tmp_path: Path):
    """任一 wav 完全無聲到 max_demucs_padding_s * 2 範圍:
    → Demucs 失敗訊號,不砍 (避免誤砍)。"""
    no_v = tmp_path / "no_v_silent.wav"
    voc = tmp_path / "voc_normal.wav"
    # 伴奏完全無聲
    with wave.open(str(no_v), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(DEFAULT_DEMUCS_SR)
        w.writeframes(b"\x00\x00" * DEFAULT_DEMUCS_SR)
    # 人聲正常
    _make_sine_wav(voc, 1.0, leading_silence_s=0.1)

    skip = compute_audio_skip(no_v, voc, config=DEFAULT_CONFIG)
    assert skip == 0.0, f"完全無聲 wav 應回傳 0.0,實際 {skip:.3f}s"


def test_v2_custom_config_overrides_defaults(tmp_path: Path):
    """caller 可自訂 AlignmentConfig 覆寫預設值。"""
    no_v = tmp_path / "no_v_custom.wav"
    voc = tmp_path / "voc_custom.wav"
    _make_sine_wav(no_v, 1.0, leading_silence_s=0.4)  # 超過預設 max=0.25
    _make_sine_wav(voc, 1.0, freq_hz=880.0, leading_silence_s=0.4)

    # 用更寬鬆的 config (max=0.5)
    custom_cfg = AlignmentConfig(max_demucs_padding_s=0.5)
    skip = compute_audio_skip(no_v, voc, config=custom_cfg)
    # 現在 0.4s 在範圍內 → 應回傳 ~0.4s
    assert 0.35 < skip < 0.45, (
        f"用 max=0.5 config,應砍 0.4s,實際 {skip:.3f}s"
    )


def test_v2_diagnose_wav_returns_full_info(tmp_path: Path):
    """diagnose_wav helper 應回傳完整診斷 dict。"""
    no_v = tmp_path / "no_v_diag.wav"
    _make_sine_wav(no_v, 1.0, leading_silence_s=0.15)

    diag = diagnose_wav(no_v, config=DEFAULT_CONFIG)
    assert "path" in diag
    assert "leading_silence_s" in diag
    assert "peak_dbfs" in diag
    assert "duration_s" in diag
    assert "is_fully_silent_until_1s" in diag
    assert 0.10 < diag["leading_silence_s"] < 0.20
    assert diag["duration_s"] > 1.0
    assert not diag["is_fully_silent_until_1s"]


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

    # 計算 skip (新版 dual-criterion)
    skip = compute_audio_skip(no_v, voc, config=DEFAULT_CONFIG)
    # ±0.05s 容錯 (window/hop 邊界)
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
    m = re.search(r"mean_volume:\s*(-?\d+\.?\d*)\s*dB", stderr)
    assert m, f"找不到 mean_volume,輸出:\n{stderr[-800:]}"
    mean_db = float(m.group(1))
    # -30dB 是因為 sine 振幅 12000/32768 ≈ -8.7dBFS, stereo pan 後約 -12dBFS,
    # 即使有 atrim 切到開頭,前 0.2s 應該已被訊號填滿 → 不會低於 -30dB
    assert mean_db > -30.0, (
        f"mp4 開頭 0.2s mean_volume={mean_db}dB 過低,可能字幕偏移未修"
    )
    print(f"\n[整合測試] atrim 後 mp4 開頭 0.2s mean_volume = {mean_db:.1f}dB (✓)")