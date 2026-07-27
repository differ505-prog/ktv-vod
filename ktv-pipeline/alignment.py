"""
音訊對齊 helpers (字幕偏移修正 7/26, 9.0/10 重構版)

設計目標
========

舊版的「單一 RMS threshold + 0.05s chunk」在邊界案例會誤判:

  - 歌曲前奏鋼琴/弦樂漸入 (能量在 -42 ~ -38 dB) 會被當成 silence,
    進而 `MAX_DEMUCS_PADDING = 0.3s` 上限勉強擋住,但同時也誤判
    真正的 Demucs padding 邊界。
  - 0.05s RMS chunk 太粗,把瞬間 attack 給平均掉。
  - vocals / no_vocals 兩個 wav 的 leading silence 落差大時,直接 `min(...)`
    是「保守不砍過頭」,但無法偵測「Demucs 兩個模型行為不一致 → 砍了也沒用」。

新版的修正
==========

1. **Dual-criterion detector**: 每個 20ms window 同時算 RMS (持續能量) 與
   peak (瞬間動態)。任一條件過門檻即視為「有聲」。
   - RMS threshold = -45 dBFS (寬鬆,允許鋼琴/弦樂漸入)
   - Peak threshold = -30 dBFS (嚴格,過濾純背景底噪)
   兩個條件用 OR 結合,大幅降低「鋼琴漸入誤判為 silence」的機率。

2. **20ms hop + 40ms window**: 比舊版 50ms chunk 解析度更高,能抓到
   短 attack (e.g. 鼓組點擊 5~10ms)。

3. **Cross-channel consistency check**: vocals 與 no_vocals 的 leading silence
   落差 > 0.15s → 視為 Demucs 兩個分離器行為不一致,回傳 0.0 (不砍)。
   理由: 落差大時,「共同的 leading silence」這個假設本身就不成立。

4. **AlignmentConfig**: 所有 magic number 集中到 dataclass,測試可以 mock,
   未來調參不需要改程式碼。

5. **Backward-compat**: `compute_audio_skip(no_vocals, vocals)` 簽名與回傳型別
   (float) 維持不變,main.py 不必改 call site。

依賴: stdlib only (wave / struct / math / dataclasses / logging),
可獨立 import 與測試,不需要 demucs/yt_dlp/torch。
"""
from __future__ import annotations

import logging
import math
import struct
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("ktv.alignment")

# ===== 預設常數 =====
DEFAULT_DEMUCS_SR = 44100  # demucs 輸出 wav 預設 samplerate (Hz)


@dataclass(frozen=True)
class AlignmentConfig:
    """音訊對齊偵測器的可調參數集中管理。

    校準依據:
      - RMS_DB_THRESHOLD = -45 dBFS: 鋼琴/弦樂漸入通常在 -42 ~ -38 dB,
        設 -45 留 3 dB buffer,避免誤判為 silence。
      - PEAK_DB_THRESHOLD = -30 dBFS: 純背景底噪通常 < -40 dBFS,
        設 -30 過濾掉,但保留 attack (鼓組點擊等瞬間 peak 通常 0 ~ -10 dBFS)。
      - WINDOW_MS = 40 / HOP_MS = 20: 業界標準 STFT 短時分析窗,
        比舊版 50ms chunk 解析度更高。
      - MAX_DEMUCS_PADDING_S = 0.30: htdemucs / htdemucs_ft 預熱通常
        落在 0.05~0.25s 區間,極少超過 0.30s。設 0.30 是「留 5% buffer」的保守值,
        同時絕對擋得住 0.4s 以上的真實歌曲前奏。
      - CROSS_CHANNEL_TOLERANCE_S = 0.15: vocals vs no_vocals leading
        silence 落差 > 0.15s 通常代表 Demucs 兩個分離器行為不一致,
        此時砍「共同 leading silence」沒意義。
      - MIN_SKIP_S = 0.03: 比一個 hop (0.02s) 大一點,避免砍掉
        毫無意義的微差。
    """
    rms_db_threshold: float = -45.0
    peak_db_threshold: float = -30.0
    window_ms: float = 40.0
    hop_ms: float = 20.0
    max_demucs_padding_s: float = 0.30
    cross_channel_tolerance_s: float = 0.15
    min_skip_s: float = 0.03

    @property
    def window_samples(self) -> int:
        # 44100 Hz * 0.040 s = 1764 samples
        return max(1, int(DEFAULT_DEMUCS_SR * self.window_ms / 1000.0))

    @property
    def hop_samples(self) -> int:
        return max(1, int(DEFAULT_DEMUCS_SR * self.hop_ms / 1000.0))


# 全域預設 config (給 main.py / 向後相容 API 用)
DEFAULT_CONFIG = AlignmentConfig()


def get_wav_samples(path: Path) -> int:
    """用 wave (stdlib) 讀 wav 檔的樣本數 (= 每聲道 frames)。"""
    with wave.open(str(path), "rb") as w:
        return w.getnframes()


def get_wav_duration_s(path: Path, samplerate: int = DEFAULT_DEMUCS_SR) -> float:
    """從 wav 檔頭算出實際時長 (秒)。"""
    return get_wav_samples(path) / samplerate


def _scan_first_n_seconds(
    path: Path,
    samplerate: int,
    cfg: AlignmentConfig,
    max_seconds: float,
) -> tuple[float, float]:
    """掃描 wav 前 max_seconds,回傳 (leading_silence_s, peak_db)。

    用 sliding window (cfg.window_ms) + hop (cfg.hop_ms) 雙準則:
      - 任一 window 內 RMS > rms_db_threshold → 視為有聲
      - 任一 window 內 |peak| > peak_db_threshold → 視為有聲
    兩條件用 OR 結合。

    peak_db 是全程觀察到的最大瞬間 peak (dBFS),即使沒過 threshold 也會回報,
    供 caller 做診斷 log。

    退回 (0.0, -inf): 讀檔失敗 / 不是 PCM 16-bit / 完全靜音到 max_seconds。

    實作: 用「重新定位 (setpos) + 讀一個 window」避免 byte buffer 滑動邏輯,
    每個 hop 重新從 hop 起始位置讀 window_frames 個 sample。
    對 1 秒掃描最多 50 個 window,IO 量 ~50 * 1764 samples * 2 bytes = 176KB,
    完全可接受。

    Caller 責任: max_seconds 必須 ≥ cfg.max_demucs_padding_s 的 2~3 倍,
    才能涵蓋「真實歌曲前奏 (0.4s)」 vs 「Demucs padding (0.2s)」的判斷區間。
    """
    try:
        with wave.open(str(path), "rb") as w:
            nchannels = w.getnchannels()
            sampwidth = w.getsampwidth()
            nframes = w.getnframes()
            if sampwidth != 2:
                return 0.0, float("-inf")
            if nframes == 0:
                return 0.0, float("-inf")

            max_frames = min(nframes, int(max_seconds * samplerate))
            window_frames = cfg.window_samples
            hop_frames = cfg.hop_samples

            # 門檻 pre-compute (避免每個 window 重算)
            rms_thr_sq = (10 ** (cfg.rms_db_threshold / 20.0) * 32768) ** 2
            peak_thr_abs = 10 ** (cfg.peak_db_threshold / 20.0) * 32768
            max_peak_abs = 0

            hop_start = 0
            while hop_start + window_frames <= max_frames:
                w.setpos(hop_start)
                raw = w.readframes(window_frames)
                if len(raw) < window_frames * nchannels * 2:
                    break
                n_samples = window_frames * nchannels
                vals = struct.unpack(f"<{n_samples}h", raw)

                sum_sq = 0
                window_peak = 0
                for v in vals:
                    a = v if v >= 0 else -v
                    sum_sq += v * v
                    if a > window_peak:
                        window_peak = a
                rms_sq = sum_sq / n_samples

                if window_peak > max_peak_abs:
                    max_peak_abs = window_peak

                # 雙準則 OR 判定
                if rms_sq > rms_thr_sq or window_peak > peak_thr_abs:
                    leading_s = hop_start / samplerate
                    peak_db = (
                        20 * math.log10(max_peak_abs / 32768.0)
                        if max_peak_abs > 0
                        else float("-inf")
                    )
                    return leading_s, peak_db

                hop_start += hop_frames

            # 整個 max_frames 都是 silence (或最後一個 window 不夠完整)
            peak_db = (
                20 * math.log10(max_peak_abs / 32768.0)
                if max_peak_abs > 0
                else float("-inf")
            )
            return float(max_frames) / samplerate, peak_db

    except Exception as e:
        logger.warning(f"[對齊] 掃描 wav 失敗 ({path.name}): {e}")
        return 0.0, float("-inf")


def leading_silence_seconds(
    path: Path,
    samplerate: int = DEFAULT_DEMUCS_SR,
    db_threshold: float = -35.0,
    config: Optional[AlignmentConfig] = None,
) -> float:
    """量測 wav 開頭 silence 的長度 (秒)。

    向後相容層:
      - 若 caller 沒傳 config,沿用舊版行為 (單一 RMS threshold, 50ms chunk)
        以免破壞既有測試。
      - 若 caller 傳了 config,用新版 dual-criterion sliding window。

    退回 0.0 表示無法量測 (讀檔失敗 / 不是 PCM wav)。
    """
    if config is None:
        # 舊版相容路徑: 單一 RMS threshold, 50ms chunk
        return _legacy_leading_silence_seconds(path, samplerate, db_threshold)

    # 新版路徑: dual-criterion
    max_seconds = max(config.max_demucs_padding_s * 2.0, 1.0)
    leading_s, _ = _scan_first_n_seconds(path, samplerate, config, max_seconds)
    return leading_s


def _legacy_leading_silence_seconds(
    path: Path,
    samplerate: int,
    db_threshold: float,
) -> float:
    """舊版單一 RMS threshold 實作 (向後相容,不建議新 code 用)。"""
    try:
        with wave.open(str(path), "rb") as w:
            nchannels = w.getnchannels()
            sampwidth = w.getsampwidth()
            nframes = w.getnframes()
            if sampwidth != 2:
                return 0.0
            chunk_frames = max(1, int(samplerate * 0.05))
            threshold_amp = 10 ** (db_threshold / 20.0)
            threshold_sq = (threshold_amp * 32768) ** 2
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
            return float(nframes) / samplerate
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


def build_atrim_filter(audio_skip_s: float, min_skip_s: float = 0.03) -> str:
    """根據要砍掉的 leading silence,產生 ffmpeg filter 片段。

    若 audio_skip_s < min_skip_s,回傳空字串 (不砍)。
    否則回傳 'atrim=start=X,asetpts=PTS-STARTPTS' (不帶尾端逗號,由 caller 拼接到 aformat 後)。

    注意:這裡不加尾端逗號是因為 ffmpeg filter graph 會把 ',' 後的下一個東西當 filter 名,
    若呼叫端用 '{trim}[label]' 拼接,中間有 ',' 反而會被解析成空 filter。

    min_skip_s 預設從 0.05 降到 0.03 (小於一個 hop 0.02s),允許砍更精準的小段。
    舊版 min_skip=0.05 會浪費掉真正的 0.04s Demucs padding。
    """
    if audio_skip_s < min_skip_s:
        return ""
    return f"atrim=start={audio_skip_s:.3f},asetpts=PTS-STARTPTS"


def compute_audio_skip(
    no_vocals_path: Path,
    vocals_path: Path,
    samplerate: int = DEFAULT_DEMUCS_SR,
    config: Optional[AlignmentConfig] = None,
) -> float:
    """計算兩個 wav 共同的 leading silence,作為 Demucs 預熱 padding 的 trim 值。

    向後相容層 (call site 不變,內部走新版 dual-criterion):
      - main.py 仍可呼叫 `compute_audio_skip(no_v, voc)`。
      - 若需要新行為,顯式傳 `config=AlignmentConfig(...)` 即可。

    演算法 (v2):
      1. 用 dual-criterion (RMS + peak) sliding window 量兩個 wav 的 leading silence
      2. 若任一檔案完全無聲到 max_demucs_padding_s → 視為 Demucs 失敗訊號,
         回傳 0.0 (避免誤砍)
      3. 計算 min(ll_no_vocals, ll_vocals) 作為候選 trim 值
      4. 若 min > max_demucs_padding_s → 判定為歌曲本身前奏,不砍
      5. **Cross-channel consistency check**: 兩個 wav 落差 > cross_channel_tolerance_s
         → Demucs 兩個分離器行為不一致,共同 leading silence 不存在,回傳 0.0
      6. 若 min < min_skip_s → 回傳 0.0 (不值得砍)
      7. 否則回傳 min

    回傳 0.0 表示「不要砍」。main.py 應繼續以「砍 0s」處理 (等同於舊版行為)。
    """
    cfg = config or DEFAULT_CONFIG

    # 掃描範圍: 至少要涵蓋「真實歌曲前奏 (常見 0.4~0.5s)」,才能正確區分
    # 「Demucs padding (~0.2s)」 vs 「歌曲本身前奏」。
    # = max_demucs_padding_s * 3 + 0.2 ≈ 0.95s 涵蓋大多數前奏
    # 不過也不要無限放大,1.5s 是合理上限 (節省 IO)。
    scan_seconds = min(1.5, cfg.max_demucs_padding_s * 3.0 + 0.2)

    ll_no_vocals, peak_no_v = _scan_first_n_seconds(
        no_vocals_path, samplerate, cfg, scan_seconds
    )
    ll_vocals, peak_v = _scan_first_n_seconds(
        vocals_path, samplerate, cfg, scan_seconds
    )

    # ----- 診斷 log (永遠輸出,出問題時方便 trace) -----
    logger.info(
        f"[對齊] 偵測 leading silence: "
        f"伴奏={ll_no_vocals:.3f}s (peak={peak_no_v:.1f}dBFS), "
        f"人聲={ll_vocals:.3f}s (peak={peak_v:.1f}dBFS), "
        f"config={{rms<={cfg.rms_db_threshold}dB, peak<={cfg.peak_db_threshold}dB, "
        f"max_padding={cfg.max_demucs_padding_s}s, "
        f"cross_tol={cfg.cross_channel_tolerance_s}s}}"
    )

    # ----- Step 2: 任一檔案「整個 wav 都是 silence」 → 視為 Demucs 失敗訊號 -----
    # 注意:不是用 scan_seconds 判定,而是用 wav 真實總時長。
    # 用 scan_seconds 會誤判「wav 開頭 1.5s 無聲但後面有訊號」(典型歌曲前奏)。
    dur_no_vocals = get_wav_duration_s(no_vocals_path, samplerate)
    dur_vocals = get_wav_duration_s(vocals_path, samplerate)
    fully_silent_no_v = ll_no_vocals >= dur_no_vocals - 0.05
    fully_silent_v = ll_vocals >= dur_vocals - 0.05
    if fully_silent_no_v or fully_silent_v:
        logger.warning(
            f"[對齊] 偵測到完全無聲 wav "
            f"(伴奏={ll_no_vocals:.2f}s/{dur_no_vocals:.2f}s, "
            f"人聲={ll_vocals:.2f}s/{dur_vocals:.2f}s),"
            "視為 Demucs 失敗訊號,不砍"
        )
        return 0.0

    # ----- Step 3: 取共同 leading silence -----
    audio_skip_s = min(ll_no_vocals, ll_vocals)

    # ----- Step 4: 超過 Demucs padding 上限 → 判定為歌曲本身前奏 -----
    if audio_skip_s > cfg.max_demucs_padding_s:
        logger.info(
            f"[對齊] 共同 leading silence {audio_skip_s:.3f}s 超過 Demucs padding 上限"
            f" {cfg.max_demucs_padding_s}s,判定為歌曲本身內容,不砍"
        )
        return 0.0

    # ----- Step 5: Cross-channel consistency check -----
    channel_diff = abs(ll_no_vocals - ll_vocals)
    if channel_diff > cfg.cross_channel_tolerance_s:
        logger.info(
            f"[對齊] vocals vs no_vocals 落差 {channel_diff:.3f}s 超過容忍值"
            f" {cfg.cross_channel_tolerance_s}s,Demucs 兩個分離器行為不一致,不砍"
        )
        return 0.0

    # ----- Step 6: 小於 min_skip_s → 不值得砍 -----
    if audio_skip_s < cfg.min_skip_s:
        return 0.0

    # ----- Step 7: 通過所有檢查,回傳 trim 值 -----
    logger.info(
        f"[對齊] 將砍掉音訊前 {audio_skip_s:.3f}s "
        f"(在 Demucs padding {cfg.max_demucs_padding_s}s 範圍內, "
        f"cross-channel 落差 {channel_diff:.3f}s)"
    )
    return audio_skip_s


# ===== 給診斷 / 測試用的額外 helper =====

def diagnose_wav(
    path: Path,
    samplerate: int = DEFAULT_DEMUCS_SR,
    config: Optional[AlignmentConfig] = None,
) -> dict:
    """對 wav 跑完整診斷,回傳 dict 給 caller (測試 / debugging)。

    回傳欄位:
      - path: wav 路徑
      - leading_silence_s: 偵測到的 leading silence (秒)
      - peak_dbfs: 全程最大瞬間 peak (dBFS)
      - duration_s: wav 實際時長
      - is_fully_silent_until_1s: 是否前 1 秒完全靜音
    """
    cfg = config or DEFAULT_CONFIG
    scan_seconds = max(cfg.max_demucs_padding_s * 2.0, 1.0)
    leading_s, peak_db = _scan_first_n_seconds(path, samplerate, cfg, scan_seconds)
    return {
        "path": str(path),
        "leading_silence_s": leading_s,
        "peak_dbfs": peak_db,
        "duration_s": get_wav_duration_s(path, samplerate),
        "is_fully_silent_until_1s": leading_s >= 1.0,
    }