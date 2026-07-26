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
except ImportError:
    DEMUCS_AVAILABLE = False
    # 如果未安裝 demucs，在 try_import 階段才告知，不在此阻斷

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
        logger.warning(
            "[!] demucs 未安裝。執行：pip install demucs torch torchaudio"
        )
        return False
    return True


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
    階段 1：下載影片與音訊

    - 影片：bestvideo[ext=mp4] → video.mp4（無音軌，純視訊）
    - 音訊：bestaudio → audio.wav（44.1kHz 立體聲，給 Demucs 用）

    回傳：(video_path, audio_path)
    """
    video_path = temp_dir / "video.mp4"
    audio_path = temp_dir / "audio.wav"

    logger.info("[下載] 階段 1/3：下載最高畫質無音軌影片 ...")
    try:
        ydl_video_opts = {
            "format": "bestvideo[ext=mp4]",
            "outtmpl": str(temp_dir / "video"),
            "quiet": True,
            "no_warnings": True,
            "merge_output_format": "mp4",
        }
        with yt_dlp.YoutubeDL(ydl_video_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        raise RuntimeError(f"[ERROR] 影片下載失敗：{e}") from e

    # yt-dlp 下載後副檔名由 output format 決定，找實際產出的 .mp4
    downloaded_video = next(temp_dir.glob("video.mp4"), None)
    if not downloaded_video or not downloaded_video.exists():
        # 可能副檔名不同，列一下目錄
        files = list(temp_dir.iterdir())
        logger.warning(f"[下載] temp 目錄內容：{[f.name for f in files]}")
        raise FileNotFoundError(
            f"[ERROR] 找不到下載的影片檔，請確認 yt-dlp 支援此 URL。目錄內容：{files}"
        )
    # 確保副檔名正確（若 yt-dlp 產生其他格式）
    if downloaded_video.suffix != ".mp4":
        renamed = temp_dir / "video.mp4"
        downloaded_video.rename(renamed)
        downloaded_video = renamed

    logger.info(f"[下載] 影片下載完成：{downloaded_video.stat().st_size / 1024 / 1024:.1f} MB")

    # ---- 下載音訊為 WAV ----
    logger.info("[下載] 階段 1/3：下載最佳音訊並轉為 WAV ...")
    try:
        ydl_audio_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(temp_dir / "audio"),
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "wav",
                    "preferredquality": "0",  # 無損
                }
            ],
        }
        with yt_dlp.YoutubeDL(ydl_audio_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        raise RuntimeError(f"[ERROR] 音訊下載/轉檔失敗：{e}") from e

    downloaded_audio = next(temp_dir.glob("audio.wav"), None)
    if not downloaded_audio or not downloaded_audio.exists():
        files = list(temp_dir.iterdir())
        raise FileNotFoundError(
            f"[ERROR] 找不到下載的音訊檔。目錄內容：{files}"
        )

    logger.info(
        f"[下載] 音訊下載完成：{downloaded_audio.stat().st_size / 1024 / 1024:.1f} MB"
    )

    return downloaded_video, downloaded_audio


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
    wav = AudioFile(str(audio_path)).read(streams=0)
    # 標準化為 float32，shape: (channels, samples)
    import numpy as np
    wav = wav.astype(np.float32)

    # ---- 推到指定 device ----
    wav_tensor = torch.from_numpy(wav).to(device)

    # ---- 分離 ----
    logger.info("[Demucs] 執行分離（這可能需要幾分鐘）...")
    with torch.no_grad():
        sources = model(wav_tensor.unsqueeze(0))  # (1, 4, T)
    sources = sources.squeeze(0).cpu().numpy()    # (4, T)

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
      -shortest    ：音訊比視訊短時自動截斷
      -y            ：覆寫不提示

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

    # 若視訊有內嵌音軌，先去除
    cmd = [
        "ffmpeg", "-y",
        # 輸入 0：視訊（去除音軌）
        "-f", "lavfi", "-i", f"movie={video_path},remove_logo=0[v]", "-map", "0:v",
        # 輸入 1：伴奏
        "-i", str(no_vocals_path),
        # 輸入 2：人聲
        "-i", str(vocals_path),
        # 濾鏡：混成左伴奏右人聲
        "-filter_complex",
        (
            "[1:a]aformat=sample_fmts=flt:channel_layouts=stereo[a_cc];"
            "[2:a]aformat=sample_fmts=flt:channel_layouts=stereo[v_cc];"
            "[a_cc][v_cc]amix=inputs=2:duration=first:dropout_transition=0[m];"
            "[m]pan=stereo|c0=c0|c1=c1[out]"
        ),
        "-map", "[out]",
        # 視訊不重新編碼，音訊 AAC 192kbps
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(output_path),
    ]

    logger.debug(f"[FFmpeg] 執行：{' '.join(cmd[:12])} ... (省略)")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600,  # 1 小時上限
        )
        if result.returncode != 0:
            stderr = result.stderr[-1500:]
            logger.error(f"[FFmpeg] 執行失敗：\n{stderr}")
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
