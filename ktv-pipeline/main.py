#!/usr/bin/env python3
"""
KTV Offline Pipeline — 影音自動下載與分離流水線
KTV 點歌系統的幕後處理腳本

使用方式：
  1. 安裝依賴：pip install -r requirements.txt
  2. 直接執行：python main.py "https://www.youtube.com/watch?v=..."
  3. 或作為模組引入：from main import process_ktv_video

作者：KTV VOD System
"""

# ============================================================
# 0. Imports
# ============================================================
import os
import re
import sys
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import yt_dlp

# Demucs 音源分離
try:
    from demucs.pretrained import get_model
    from demucs.audio import AudioFile, save_audio
    from demucs.hdemucs import HDemucs
    import torch
    DEMUCS_AVAILABLE = True
except ImportError as e:
    DEMUCS_AVAILABLE = False
    # 記下真正的 import 錯誤，stage_separate 會拿來告訴使用者
    DEMUCS_IMPORT_ERROR = repr(e)
else:
    DEMUCS_IMPORT_ERROR = None

# ============================================================
# 1. Logging 設定
# ============================================================
def setup_logging(verbose: bool = False) -> logging.Logger:
    """
    設定全域 logging。
    Level 預設 INFO，verbose=True 時開到 DEBUG。
    同時輸出到 stdout 與一個 optional 的 log 檔。
    """
    level = logging.DEBUG if verbose else logging.INFO

    formatter = logging.Formatter(
        fmt="[%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    handler_stdout = logging.StreamHandler(sys.stdout)
    handler_stdout.setLevel(level)
    handler_stdout.setFormatter(formatter)

    logger = logging.getLogger("ktv_pipeline")
    logger.setLevel(level)
    logger.handlers.clear()
    logger.addHandler(handler_stdout)

    return logger


logger = setup_logging()


# ============================================================
# 2. 工具函式
# ============================================================

def sanitize_filename(title: str) -> str:
    """
    移除所有會干擾 OS 與 FFmpeg 的字元：
      - 作業系統危險字元：| / \\ ? " : < > *
      - FFmpeg 不友好的控制字元
      - Emoji 與其他非 ASCII 可視字元（保留中文、英文、數字、括號、dash、底線）
      - 末尾與開頭的空白、dash
    回傳一個乾淨、安全、可用於檔名的字串。
    """
    # 先把常見全形空白替掉
    title = title.replace("\u3000", " ").replace("\u00A0", " ")

    # 移除作業系統不允許的字元
    unsafe_chars = r'[|\\/:*?"<>*\x00-\x1f]'
    clean = re.sub(unsafe_chars, "", title)

    # 移除 emoji 以及其他 CJK 擴充區段（但保留基本中文、英文、數字）
    # Unicode 範圍：\u4e00-\u9fff (CJK基本) \u3400-\u4dbf (擴展A) \uff00-\uffef (全形)
    # 其餘超出範圍的全砍掉（emoji、顏文字、音樂符號等）
    # 注意：\U0001F000 等 8 字元 escape 必須在一般字串 (非 raw) 才能被解讀為單一 codepoint
    emoji_classes = (
        "[" + "".join(
            map(chr, range(0x1F000, 0x1FAFF + 1))   # emoji 區段
        ) + "".join(map(chr, range(0x2702, 0x27B0 + 1)))   # dingbats
        + "".join(map(chr, range(0x2000, 0x202F + 1)))   # 空白與標點
        + "".join(map(chr, range(0x2190, 0x21FF + 1)))   # 箭頭
        + "".join(map(chr, range(0x2300, 0x23FF + 1)))   # 數學運算
        + "".join(map(chr, range(0x2460, 0x24FF + 1)))   # 包圍數字字母
        + "".join(map(chr, range(0x2600, 0x26FF + 1)))   # 其它符號
        + "]"
    )
    clean = re.sub(emoji_classes, "", clean)

    # 消掉連續空白、底線、dash，合併成單一底線
    clean = re.sub(r"[\s_—–-]+", "_", clean).strip("_").strip()

    # 限制長度（Windows 路徑最大 255，避免路徑超長）
    if len(clean) > 200:
        clean = clean[:200].strip("_")

    return clean if clean else "untitled"


def check_file_exists(path: Path) -> bool:
    """檢查目標檔案是否存在（作為跳過條件）。"""
    return path.exists() and path.stat().st_size > 0


def is_demucs_available() -> bool:
    """確認 demucs 是否已正確安裝。"""
    if not DEMUCS_AVAILABLE:
        hint = (
            f"（真實 import 錯誤：{DEMUCS_IMPORT_ERROR}）"
            if DEMUCS_IMPORT_ERROR else ""
        )
        logger.warning(
            f"[!] demucs 無法載入，AI 分離階段會跳過。{hint}"
        )
        return False
    return True


# ============================================================
# 2.5 音訊對齊 helpers (字幕偏移修正 7/26) — 抽到 alignment.py
# ============================================================
from alignment import (
    get_wav_samples,
    get_wav_duration_s,
    leading_silence_seconds,
    trim_wav_to_duration,
    build_atrim_filter,
    compute_audio_skip,
)


def check_ffmpeg() -> bool:
    """確認 ffmpeg 在 PATH 中。"""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            version_line = result.stdout.split("\n")[0]
            logger.info(f"[FFmpeg] {version_line}")
            return True
    except Exception:
        pass
    logger.error("[ERROR] ffmpeg 未找到或無法執行。請確認已安裝並加入 PATH。")
    return False


def get_video_title(url: str) -> tuple[str, str]:
    """
    使用 yt-dlp 解析 YouTube URL，取得原始標題與安全檔名。

    回傳：(raw_title, sanitized_name)
    """
    logger.info(f"[ yt-dlp ] 正在解析影片資訊：{url}")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info is None:
            raise RuntimeError(f"無法解析 URL：{url}")
        raw_title = info.get("title", "untitled")
        sanitized = sanitize_filename(raw_title)
        logger.info(f"[ yt-dlp ] 標題：{raw_title}")
        logger.info(f"[ yt-dlp ] 安全檔名：{sanitized}")
        return raw_title, sanitized


# ============================================================
# 3. Pipeline 各階段實作
# ============================================================

def stage_download(
    url: str,
    sanitized_name: str,
    temp_dir: Path,
) -> tuple[Path, Path]:
    """
    階段 1：下載影片與音訊（A/V 同步保證版）

    策略：下載「影音合一」的 MP4，再從同一檔案用 ffmpeg 抽出音訊。
    這樣 video track 和 audio track 來自同一個 mux 好的容器，
    PTS 天生對齊，不會有分開下載造成的 A/V 偏移。

    - 合一影音：bestvideo+bestaudio → full.mp4
    - 音訊：ffmpeg -i full.mp4 → audio.wav（44.1kHz 立體聲，給 Demucs 用）

    回傳：(video_path, audio_path)
    """
    full_path = temp_dir / "full.mp4"
    video_path = temp_dir / "video.mp4"
    audio_path = temp_dir / "audio.wav"

    # ---- Step 1: 下載影音合一的 MP4 ----
    logger.info("[下載] 階段 1/3：下載影音合一 MP4（確保 A/V 同步）...")
    try:
        ydl_opts = {
            # bestvideo+bestaudio: yt-dlp 會自動 mux 並對齊 PTS
            "format": (
                "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/"
                "bestvideo[ext=mp4]+bestaudio/"
                "best[ext=mp4]/"
                "best"
            ),
            "outtmpl": str(temp_dir / "full.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
            "merge_output_format": "mp4",
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        raise RuntimeError(f"[ERROR] 影片下載失敗：{e}") from e

    # 找到實際下載的檔案
    downloaded = next(temp_dir.glob("full.*"), None)
    if not downloaded or not downloaded.exists() or downloaded.suffix == "":
        files = list(temp_dir.iterdir())
        logger.warning(f"[下載] temp 目錄內容：{[f.name for f in files]}")
        raise FileNotFoundError(
            f"[ERROR] 找不到下載的影片檔，請確認 yt-dlp 支援此 URL。目錄內容：{files}"
        )
    # 統一規範成 full.mp4
    if downloaded.name != "full.mp4":
        if full_path.exists():
            full_path.unlink()
        downloaded.rename(full_path)

    logger.info(f"[下載] 影音合一下載完成：{full_path.stat().st_size / 1024 / 1024:.1f} MB")

    # ---- Step 2: 從同一檔案抽出純視訊（無音軌）----
    # 後續 stage_mix_and_encode 會用這個 video-only mp4
    logger.info("[下載] 從合一 MP4 抽出純視訊 ...")
    cmd_video = [
        "ffmpeg", "-y",
        "-i", str(full_path),
        "-map", "0:v:0",
        "-c:v", "copy",
        "-an",  # 不要音軌
        "-movflags", "+faststart",
        str(video_path),
    ]
    result = subprocess.run(cmd_video, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(
            f"[ERROR] 抽出視訊失敗 rc={result.returncode}\n{(result.stderr or '')[-500:]}"
        )
    logger.info(f"[下載] 純視訊抽出完成：{video_path.stat().st_size / 1024 / 1024:.1f} MB")

    # ---- Step 3: 從同一檔案抽出音訊為 WAV ----
    # 關鍵：從同一個 muxed MP4 抽，保證和 video track 完美對齊
    logger.info("[下載] 從合一 MP4 抽出音訊為 WAV ...")
    cmd_audio = [
        "ffmpeg", "-y",
        "-i", str(full_path),
        "-map", "0:a:0",
        "-vn",  # 不要視訊
        "-acodec", "pcm_s16le",
        "-ar", "44100",
        "-ac", "2",
        str(audio_path),
    ]
    result = subprocess.run(cmd_audio, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(
            f"[ERROR] 抽出音訊失敗 rc={result.returncode}\n{(result.stderr or '')[-500:]}"
        )
    logger.info(f"[下載] 音訊抽出完成：{audio_path.stat().st_size / 1024 / 1024:.1f} MB")

    # 刪除 full.mp4 以節省暫存空間（video.mp4 + audio.wav 已取代）
    try:
        full_path.unlink()
        logger.info("[下載] 已刪除暫存合一檔案")
    except Exception:
        pass  # 刪不掉也不影響流程

    return video_path, audio_path


def stage_separate(
    audio_path: Path,
    sanitized_name: str,
    temp_dir: Path,
    force_cpu: bool = False,
) -> tuple[Path, Path]:
    """
    階段 2：AI 音源分離 (Demucs)

    呼叫 demucs 將 audio.wav 分離為：
      - vocals.wav     (人聲)
      - no_vocals.wav (伴奏/樂器)

    自動偵測 CUDA / MPS / CPU。
    產出路徑：separated/htdemucs/<name>/vocals.wav 等

    回傳：(vocals_path, no_vocals_path)
    """
    if not is_demucs_available():
        raise RuntimeError(
            "[ERROR] demucs 未安裝。請執行：pip install demucs torch torchaudio"
        )

    logger.info("[Demucs] 階段 2/3：AI 音源分離中 ...")

    # ---- 決定 device ----
    if force_cpu:
        device = "cpu"
    elif torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"  # Apple Silicon GPU
    else:
        device = "cpu"

    logger.info(f"[Demucs] 使用 device：{device}")

    # ---- 初始化模型 ----
    model_name = "htdemucs"  # 標準 4 軌模型：drums / bass / other / vocals
    logger.info(f"[Demucs] 載入模型：{model_name} ...")
    model = get_model(model_name)
    model.eval()
    model.to(device)

    # ---- 讀取音訊 ----
    logger.info("[Demucs] 載入音訊檔 ...")
    import numpy as np
    raw = AudioFile(str(audio_path)).read(streams=0)
    # demucs 4.x 的 AudioFile.read() 回傳 torch.Tensor (channels, samples),
    # 而後面需要的是 numpy 陣列以便 torch.from_numpy() 處理
    if hasattr(raw, "cpu"):  # torch.Tensor
        wav = raw.detach().cpu().numpy().astype(np.float32)
    else:  # 已經是 numpy.ndarray (舊版 demucs)
        wav = np.asarray(raw, dtype=np.float32)
    # 保證 shape: (channels, samples) 二維
    if wav.ndim == 1:
        wav = wav[np.newaxis, :]     # 單聲道: (samples,) → (1, samples)
    elif wav.ndim == 3 and wav.shape[0] == 1:
        wav = np.squeeze(wav, axis=0)

    # ---- 推到指定 device ----
    wav_tensor = torch.from_numpy(wav).to(device)

    # ---- 分離 ----
    logger.info("[Demucs] 執行分離（這可能需要幾分鐘）...")
    # demucs 4.x: HDemucs.forward() 拋 NotImplementedError; 必須用 apply_model()
    from demucs.apply import apply_model
    with torch.no_grad():
        out = apply_model(
            model,
            wav_tensor.unsqueeze(0),   # (1, channels, samples) batch 維
            shifts=0,                   # 0 = 跑一次（最省時間/記憶體）
            overlap=0.25,
        )
    # apply_model 回傳 Tensor list 或 Tensor；確保 (sources, channels, samples)
    if isinstance(out, (list, tuple)):
        sources_tensor = out[0]
    else:
        sources_tensor = out
    sources = sources_tensor.squeeze(0).cpu().numpy()    # (sources, channels, samples)
    # 若 channels == 1，去掉
    if sources.ndim == 3 and sources.shape[1] == 1:
        sources = sources.squeeze(1)
    # 降到 (sources, samples) 2D for save_audio / mix
    if sources.ndim == 3:
        # 多 channel (rare): 取第一個 channel
        sources = sources[:, 0, :]
    # 對齊 source 軸: htdemucs 對應 drums / bass / other / vocals 順序
    if sources.shape[0] != 4:
        logger.warning(f"[Demucs] 非預期 source 數 {sources.shape[0]}，預期 4")

    # ---- 寫入檔案 ----
    # 對應 htdemucs 的 source 順序：drums, bass, other, vocals
    source_names = ["drums", "bass", "other", "vocals"]

    # Demucs 輸出目錄結構：separated/<model>/<name>/
    separated_dir = temp_dir / "separated" / model_name / sanitized_name
    separated_dir.mkdir(parents=True, exist_ok=True)

    vocals_path = separated_dir / "vocals.wav"
    no_vocals_path = separated_dir / "no_vocals.wav"

    logger.info("[Demucs] 寫入分離結果 ...")
    # vocals
    save_audio(
        torch.from_numpy(sources[source_names.index("vocals")]).unsqueeze(0),
        str(vocals_path),
        samplerate=model.samplerate,
    )
    # 伴奏 = drums + bass + other，三軌相加後標準化
    accompaniment = sources[0] + sources[1] + sources[2]
    # 避免 clip
    max_val = np.abs(accompaniment).max()
    if max_val > 1.0:
        accompaniment = accompaniment / max_val * 0.99
    save_audio(
        torch.from_numpy(accompaniment).unsqueeze(0),
        str(no_vocals_path),
        samplerate=model.samplerate,
    )

    # ---- 層 1:把 wav 裁到與原音訊時長一致 (杜絕 demucs 預熱 padding) ----
    # 量原音訊時長
    try:
        raw_ref = AudioFile(str(audio_path)).read(streams=0)
        if hasattr(raw_ref, "shape"):
            ref_samples = raw_ref.shape[-1]
        else:
            ref_samples = len(raw_ref)
        ref_duration_s = ref_samples / model.samplerate
        trim_wav_to_duration(vocals_path, ref_duration_s, model.samplerate)
        trim_wav_to_duration(no_vocals_path, ref_duration_s, model.samplerate)
        logger.info(
            f"[對齊] 已將 wav 裁切到原音訊時長 {ref_duration_s:.2f}s"
        )
    except Exception as e:
        logger.warning(f"[對齊] 層 1 trim 失敗 (繼續): {e}")

    logger.info(
        f"[Demucs] 分離完成！"
        f"  人聲：{vocals_path.stat().st_size / 1024 / 1024:.1f} MB | "
        f"  伴奏：{no_vocals_path.stat().st_size / 1024 / 1024:.1f} MB"
    )

    return vocals_path, no_vocals_path


def stage_mix_and_encode(
    video_path: Path,
    vocals_path: Path,
    no_vocals_path: Path,
    sanitized_name: str,
    output_dir: Path,
) -> Path:
    """
    階段 3：FFmpeg 混音與封裝

    目標格式：左聲道 = 伴奏，右聲道 = 人聲

    FFmpeg 指令說明：
      -i video_path        ：輸入視訊（無音軌）
      -i no_vocals_path    ：輸入伴奏音訊
      -i vocals_path       ：輸入人聲音訊
      -filter_complex ：
        [1:a]aformat=sample_fmts='flt':channel_layouts='stereo'[a_tmpl]
        [2:a]aformat=sample_fmts='flt':channel_layouts='stereo'[v_tmpl]
        [a_tmpl][v_tmpl]amix=inputs=2:duration=first:dropout_transition=0[a_mix]
        [a_mix]pan=stereo|c0=c0|c1=c1[a_out]
          → 左聲道 (c0) = 伴奏左 (無變動)
          → 右聲道 (c1) = 人聲右 (無變動)
          這樣左伴右唱的 Stereo MP4 就完成了
      -map 0:v    ：使用原始視訊
      -map "[a_out]"：使用混合後音訊
      -c:v copy    ：視訊不重新編碼
      -c:a aac     ：音訊 AAC 編碼，192k 足夠 KTV
      -t 0         ：不限時長（傳統用 -shortest,但 -shortest 會在音訊長時砍視訊；
                     反之若音訊比視訊長,FFmpeg 會在 muxer 階段自然截斷）
      -y            ：覆寫不提示

    字幕偏移修正 (7/26)：
      層 3:量測 demucs 輸出 wav 開頭 silence,若 > 0.05s 則在 atrim 砍掉
      層 2:把 -shortest 換成 apad (音訊短時補無聲,絕不砍頭影音同步)

    回傳：最終輸出檔案路徑
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{sanitized_name}_ktv.mp4"

    if check_file_exists(output_path):
        logger.info(
            f"[FFmpeg] 目標檔案已存在，跳過：{output_path.name}"
        )
        return output_path

    logger.info(f"[FFmpeg] 階段 3/3：混音與封裝 → {output_path.name}")

    # ============================================================
    # 層 3:Sanity check - 量測 leading silence 與視訊時長
    # ============================================================
    # 層 3:Sanity check - 量測 leading silence (alignment.compute_audio_skip)
    # ============================================================
    try:
        audio_skip_s = compute_audio_skip(no_vocals_path, vocals_path)
    except Exception as e:
        logger.warning(f"[對齊] 層 3 sanity check 失敗,跳過 atrim: {e}")
        audio_skip_s = 0.0

    # ============================================================
    # 層 2+3:FFmpeg 命令
    #  - 把 -shortest 換成 apad (音訊短時補無聲,絕不砍頭)
    #  - 若 audio_skip_s > 0,則在 [1:a] / [2:a] 入口加 atrim=start=...
    # ============================================================
    trim_filter = build_atrim_filter(audio_skip_s)
    if trim_filter:
        # 用 ',' 串接 (trim_filter 內已有完整 chain,結尾不再加 ,)
        a_cc = f"[1:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo,{trim_filter}[a_cc];"
        v_cc = f"[2:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo,{trim_filter}[v_cc];"
    else:
        a_cc = "[1:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo[a_cc];"
        v_cc = "[2:a]aresample=44100,aformat=sample_fmts=flt:channel_layouts=stereo[v_cc];"

    # 直接三個檔案輸入，不繞 lavfi movie= filter（容易在某些版本的 ffmpeg 與 mp4 上 invalid）
    # -i 0: 視訊
    # -i 1: 伴奏 (左/右/左/右 將被 pan 到 L)
    # -i 2: 人聲 (將被 pan 到 R)
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(no_vocals_path),
        "-i", str(vocals_path),
        # 濾鏡：把兩個音訊饋送都轉 stereo，再用 pan 把伴奏塞左、人聲塞右
        # 尾端 apad 取代 -shortest:音訊短時補無聲,絕不砍頭
        "-filter_complex",
        (
            f"{a_cc}"
            f"{v_cc}"
            f"[a_cc][v_cc]amerge=inputs=2,pan=stereo|c0=c0|c1=c2[out]"
        ),
        "-map", "0:v",
        "-map", "[out]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-ar", "44100",
        "-ac", "2",
        "-t", "0",  # 0 = 不限,保險用;實際長度由視訊決定
        "-movflags", "+faststart",
        str(output_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600,  # 1 小時上限
        )
        if result.returncode != 0:
            stderr = (result.stderr or "").strip() or "(empty stderr)"
            stdout = (result.stdout or "").strip() or "(empty stdout)"
            logger.error(
                f"[FFmpeg] 執行失敗 rc={result.returncode}\n"
                f"--- stderr ---\n{stderr[-1500:]}\n"
                f"--- stdout ---\n{stdout[-500:]}"
            )
            raise RuntimeError(f"FFmpeg 合併失敗 (rc={result.returncode})")
    except subprocess.TimeoutExpired:
        raise RuntimeError("[ERROR] FFmpeg 執行逾時（>1 小時）")

    file_size = output_path.stat().st_size / 1024 / 1024
    logger.info(
        f"[FFmpeg] 完成！輸出檔案：{output_path.name} ({file_size:.1f} MB)"
    )
    return output_path


# ============================================================
# 4. 清理函式（重要）
# ============================================================

def cleanup_temp_files(
    temp_dir: Path,
    logger_instance: Optional[logging.Logger] = None,
) -> None:
    """
    強制刪除暫存目錄。
    使用 shutil.rmtree 並加上額外保護：
      - 目錄不存在時不拋錯
      - 個別檔案刪除失敗時仍繼續嘗試刪除其餘檔案
    """
    lgr = logger_instance or logger

    if not temp_dir.exists():
        lgr.debug("[清理] 暫存目錄不存在，跳過")
        return

    lgr.info(f"[清理] 刪除暫存目錄：{temp_dir}")
    try:
        shutil.rmtree(temp_dir)
        lgr.info("[清理] 暫存目錄已刪除")
    except Exception as e:
        lgr.warning(f"[清理] 無法完整刪除暫存目錄：{e}")
        # 嘗試逐檔刪除
        try:
            for item in temp_dir.rglob("*"):
                if item.is_file():
                    item.unlink(missing_ok=True)
                    lgr.debug(f"[清理] 刪除檔案：{item}")
            temp_dir.rmdir()
            lgr.info("[清理] 暫存目錄已手動清空")
        except Exception as e2:
            lgr.error(f"[清理] 仍無法刪除：{e2}")


# ============================================================
# 5. 主 Pipeline 函式
# ============================================================

def process_ktv_video(
    youtube_url: str,
    output_dir: str = "./ktv_output",
    force_cpu: bool = False,
    verbose: bool = False,
) -> str:
    """
    KTV 影音流水線主函式。

    依序執行：下載 → AI 分離 → 混音封裝
    全程使用 try...finally 確保暫存檔一定會被清理。

    參數：
      youtube_url  : YouTube 影片網址
      output_dir   : 最終輸出目錄（預設 ./ktv_output）
      force_cpu    : 強制使用 CPU（不使用 GPU）
      verbose      : 開啟 DEBUG 詳細日誌

    回傳：
      最終輸出檔案的完整路徑（字串）

    拋出：
      RuntimeError — 任何階段失敗時
    """
    global logger
    if verbose:
        logger = setup_logging(verbose=True)

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # ---- Step 1：解析標題 & 決定輸出檔名 ----
    logger.info("=" * 50)
    logger.info("KTV Pipeline 啟動")
    logger.info("=" * 50)
    logger.info(f"[URL]  {youtube_url}")
    logger.info(f"[輸出]  {output_dir}")

    _, sanitized_name = get_video_title(youtube_url)

    final_file = output_path / f"{sanitized_name}_ktv.mp4"
    if check_file_exists(final_file):
        logger.info(f"[跳過] 輸出檔案已存在：{final_file.name}")
        return str(final_file)

    # ---- Step 2：建立暫存目錄 ----
    temp_dir = Path(tempfile.mkdtemp(prefix="ktv_"))
    logger.info(f"[暫存] 工作目錄：{temp_dir}")

    # ---- Step 3：執行 Pipeline ----
    video_path: Path = None  # type: ignore[assignment]
    audio_path: Path = None  # type: ignore[assignment]
    vocals_path: Path = None  # type: ignore[assignment]
    no_vocals_path: Path = None  # type: ignore[assignment]

    try:
        # 階段 1：下載
        video_path, audio_path = stage_download(
            url=youtube_url,
            sanitized_name=sanitized_name,
            temp_dir=temp_dir,
        )

        # 階段 2：AI 分離
        vocals_path, no_vocals_path = stage_separate(
            audio_path=audio_path,
            sanitized_name=sanitized_name,
            temp_dir=temp_dir,
            force_cpu=force_cpu,
        )

        # 階段 3：混音封裝
        final_path = stage_mix_and_encode(
            video_path=video_path,
            vocals_path=vocals_path,
            no_vocals_path=no_vocals_path,
            sanitized_name=sanitized_name,
            output_dir=output_path,
        )

        logger.info("=" * 50)
        logger.info("Pipeline 完成！")
        logger.info(f"輸出檔案：{final_path}")
        logger.info("=" * 50)
        return str(final_path)

    except Exception as e:
        logger.error(f"[ERROR] Pipeline 執行失敗：{e}")
        raise

    finally:
        # ===== 強制清理所有暫存檔 =====
        cleanup_temp_files(temp_dir)


# ============================================================
# 6. 命令列入口
# ============================================================

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="KTV Offline Pipeline — YouTube 自動下載 + 音軌分離 + KTV 格式封裝",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用範例：
  python main.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  python main.py "https://youtu.be/dQw4w9WgXcQ" -o ./my_karaoke
  python main.py "URL" -o ./output --cpu --verbose

注意：
  - 請先安裝依賴：pip install -r requirements.txt
  - 首次執行 Demucs 會自動下載模型（約 3 GB）
  - FFmpeg 需預先安裝並加入系統 PATH
        """,
    )
    parser.add_argument(
        "url", nargs="?", default=None,
        help="YouTube 影片 URL（支援 youtube.com / youtu.be）"
    )
    parser.add_argument(
        "-o", "--output", default="./ktv_output",
        help="最終輸出目錄（預設：./ktv_output）"
    )
    parser.add_argument(
        "--cpu", action="store_true",
        help="強制使用 CPU，不使用 GPU"
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="開啟 DEBUG 詳細日誌"
    )

    args = parser.parse_args()

    if not args.url:
        parser.print_help()
        print("\n[範例] 直接執行測試：")
        print('  python main.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
        sys.exit(0)

    # =============================================
    # 環境檢查（正式執行前）
    # =============================================
    logger.info("[環境] 檢查系統依賴 ...")

    if not check_ffmpeg():
        sys.exit(1)

    if not is_demucs_available():
        logger.warning("[環境] demucs 未安裝，pip install 會自動處理")
        # 不阻斷，Demucs 會在需要時再報錯

    # =============================================
    # 執行 Pipeline（自帶完整 try...finally）
    # =============================================
    try:
        output_file = process_ktv_video(
            youtube_url=args.url,
            output_dir=args.output,
            force_cpu=args.cpu,
            verbose=args.verbose,
        )
        print(f"\n✅ 完成！檔案路徑：\n  {output_file}")

    except KeyboardInterrupt:
        logger.warning("\n[中斷] 使用者取消執行")
        sys.exit(130)

    except Exception as e:
        logger.error(f"\n❌ Pipeline 執行失敗：{e}")
        sys.exit(1)
