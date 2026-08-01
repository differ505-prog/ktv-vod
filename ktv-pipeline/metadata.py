"""
歌曲 metadata 模組 (方案 B — 整理歌名 9.0/10)

做三件事:
  1) parse_yt_title() — 把 YouTube 影片標題切成「歌手 - 歌名」或「歌名（歌手）」
  2) fetch_youtube_metadata() — 用 YouTube oEmbed 抓官方封面圖 (免費, 無 API key)
  3) to_pinyin() — 中文轉拼音, 給「用拼音搜尋」用
  4) sanitize_filename() — 給檔名清理用 (從 main.py 移過來, 避免重複)

設計原則:
  - 全部純 stdlib + 可選的 pypinyin
  - 任何 helper 失敗都 graceful degrade, 不會炸 pipeline
  - 寫到 <name>.json 給 Node 中控讀, 不依賴 yt-dlp metadata dict
"""
from __future__ import annotations

import json
import logging
import re
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger("ktv.metadata")

# ============================================================
# 1. 標題解析
# ============================================================
# 常見 YouTube 影片標題格式:
#   "周杰倫 - 夜曲"
#   "周杰倫 Jay Chou - 夜曲 Nocturne"
#   "周杰倫 - 夜曲 (Official Music Video)"
#   "夜曲 - 周杰倫"
#   "[KTV] 周杰倫 夜曲"
#   "周杰倫_夜曲_2005_Official"
#   "Eason Chan 陳奕迅 - 浮誇 (粵語)"
#
# 解析策略:
#   A. 先去掉常見冗詞: (Official MV) / (Official Music Video) / [KTV] / HD / 4K / MV / 高清 ...
#   B. 用多種分隔符優先切 (「-」 / 「_」 / 「 – 」 — em dash).
#      空白分隔當最後手段 (Ex: "周杰倫 夜曲") — 此時第一個 token 是歌手.
#   C. 沒切開就整個當 title, artist=None.
#   D. "feat." / "ft." 視為標題的一部分, 不切.

_NOISE_PATTERNS = [
    r"\(?official\s+music\s+video\)?",
    r"\(?official\s+mv\)?",
    r"\(?official\s+audio\)?",
    r"\(?official\s+lyric\s+video\)?",
    r"\(?lyric\s+video\)?",
    r"\(?lyrics?\)?",
    r"\(?music\s+video\)?",
    r"\(?hd\)?",
    r"\(?4k\)?",
    r"\(?official\)?",
    r"\(?mv\)?",
    r"\(?高清\)?",
    r"\(?完整版\)?",
    r"\(?現場版\)?",
    r"\(?live\)?",
    r"\(?cover\)?",
    r"\(?翻唱\)?",
    r"\[KTV\]",
    r"\[KTV]",
    r"\[官方\]",
    r"\[HD\]",
    r"\[4K\]",
]

_NOISE_RE = re.compile("|".join(_NOISE_PATTERNS), re.IGNORECASE)


def _strip_noise(s: str) -> str:
    """移除冗詞標記."""
    return _NOISE_RE.sub("", s).strip()


def _has_cjk(s: str) -> bool:
    """判斷字串是否含有中日韓 (CJK) 字元."""
    return any("\u4e00" <= c <= "\u9fff" for c in s)


def parse_yt_title(raw_title: str) -> tuple[str, Optional[str]]:
    """
    把 YouTube 影片標題解析成 (title, artist)。

    回傳:
      - title:  整理後的歌名
      - artist: 整理後的歌手, 抓不到就 None

    規則（套用順序, 命中就回傳不繼續試）:
      1. "歌手 - 歌名" 或 "歌手 – 歌名" (ASCII dash + en/em dash)
      2. "歌手 _ 歌名 _ 來源" (常見 yt-dlp 慣例)
      3. "歌名 ｜ 歌手" (full-width 直立線)
      4. 兩個 token 都是中文, 第一個 token 視為歌手
      5. 都失敗 → title = 清理後原字串, artist = None
    """
    if not raw_title:
        return ("未知歌曲", None)

    # 先剝皮: 去冗詞, 把多個空白壓成單一
    title = _strip_noise(raw_title)
    title = re.sub(r"\s+", " ", title).strip()

    if not title:
        return ("未知歌曲", None)

    # 規則 1: "歌手 - 歌名" 或 "歌手 – 歌名" (en-dash / em-dash / 中橫線)
    # 但要避免把 "Part - 1" 這種切壞 — 只切第一個出現
    for sep in [" - ", " – ", " — ", " － "]:
        if sep in title:
            parts = title.split(sep, 1)
            artist = parts[0].strip()
            song = parts[1].strip()
            if artist and song:
                return (song, artist)

    # 規則 2: "歌手_歌名_來源" (中文底線)
    if "_" in title and " " not in title:
        parts = title.split("_")
        if len(parts) >= 2:
            artist = parts[0].strip()
            song = "_".join(parts[1:]).strip() if len(parts) > 2 else parts[1].strip()
            if artist and song:
                return (song, artist)

    # 規則 3: "歌名 ｜ 歌手" (全形直立線, 兩側有空白)
    for sep in [" ｜ ", " | ", "｜"]:
        if sep in title:
            parts = title.split(sep, 1)
            # 較長那邊當 title
            if len(parts[0]) >= len(parts[1]):
                return (parts[0].strip(), parts[1].strip() or None)
            else:
                return (parts[1].strip(), parts[0].strip() or None)

    # 規則 4: 兩個 CJK token, 第一個視為歌手
    tokens = title.split(" ")
    if len(tokens) >= 2 and _has_cjk(tokens[0]) and _has_cjk(tokens[1]):
        artist = tokens[0]
        song = " ".join(tokens[1:])
        return (song.strip(), artist)

    # 規則 5: 全部失敗 — 整字串當 title
    return (title, None)


# ============================================================
# 2. YouTube oEmbed (免費, 無 API key)
# ============================================================
# 文件: https://noembed.com/ (也支援 YouTube),
#       或 https://www.youtube.com/oembed?url=...&format=json
#
# YouTube oEmbed 直接抓官方 metadata:
#   - title (官方顯示的標題)
#   - author_name (頻道名, 通常是官方帳號, 但華語 MV 多是唱片公司)
#   - thumbnail_url (官方封面)
# 注意：author_name 不一定是真正的「歌手」, 但作為搜尋的 fallback 還是有用。

OEMBED_URL = "https://www.youtube.com/oembed"


def sanitize_filename(title: str) -> str:
    """
    移除所有會干擾 OS 與 FFmpeg 的字元:
      - 作業系統危險字元: | / \\ ? " : < > *
      - FFmpeg 不友好的控制字元
      - Emoji 與其他非 ASCII 可視字元 (保留中文、英文、數字、括號、dash、底線)
      - 末尾與開頭的空白、dash
    回傳一個乾淨、安全、可用於檔名的字串。
    """
    title = title.replace("\u3000", " ").replace("\u00A0", " ")

    unsafe_chars = r'[|\\/:*?"<>*\x00-\x1f]'
    clean = re.sub(unsafe_chars, "", title)

    emoji_classes = (
        "[" + "".join(
            map(chr, range(0x1F000, 0x1FAFF + 1))
        ) + "".join(map(chr, range(0x2702, 0x27B0 + 1)))
        + "".join(map(chr, range(0x2000, 0x202F + 1)))
        + "".join(map(chr, range(0x2190, 0x21FF + 1)))
        + "".join(map(chr, range(0x2300, 0x23FF + 1)))
        + "".join(map(chr, range(0x2460, 0x24FF + 1)))
        + "".join(map(chr, range(0x2600, 0x26FF + 1)))
        + "]"
    )
    clean = re.sub(emoji_classes, "", clean)

    clean = re.sub(r"[\s_—–-]+", "_", clean).strip("_").strip()

    if len(clean) > 200:
        clean = clean[:200].strip("_")

    return clean if clean else "untitled"


@dataclass
class SongMetadata:
    """歌曲 metadata 統一結構, 寫進 <name>.json."""

    title: str                        # 整理後歌名
    artist: Optional[str] = None      # 整理後歌手
    raw_title: str = ""               # YouTube 原始標題 (備用)
    channel: Optional[str] = None     # YouTube 頻道名 (oEmbed)
    album: Optional[str] = None       # 專輯名 (目前無來源, 保留欄位)
    cover: Optional[str] = None       # 封面 URL (oEmbed thumbnail)
    duration: Optional[int] = None    # 秒 (從 yt-dlp duration)
    pinyin_title: str = ""           # 拼音版 title
    pinyin_artist: str = ""          # 拼音版 artist
    youtube_id: Optional[str] = None  # 影片 ID
    source: str = "local"

    def to_dict(self) -> dict:
        return asdict(self)


def _extract_yt_id(url_or_id: str) -> Optional[str]:
    """從 YouTube URL 或 bare ID 抽出 11 字元 video id."""
    if not url_or_id:
        return None
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url_or_id):
        return url_or_id
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{11})", url_or_id)
    return m.group(1) if m else None


def fetch_youtube_metadata(url_or_id: str, timeout: float = 3.0) -> dict:
    """
    呼叫 YouTube oEmbed 抓官方 metadata。
    失敗回空 dict, 不 raise。

    回傳 dict 包含: title, author_name, thumbnail_url (官方)
    """
    yt_id = _extract_yt_id(url_or_id)
    if not yt_id:
        return {}

    target = f"{OEMBED_URL}?url=https://www.youtube.com/watch?v={yt_id}&format=json"
    try:
        req = urllib.request.Request(
            target,
            headers={"User-Agent": "Mozilla/5.0 (ktv-pipeline)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {
            "title": data.get("title"),
            "author_name": data.get("author_name"),
            "thumbnail_url": data.get("thumbnail_url"),
        }
    except Exception as e:
        logger.debug(f"[metadata] oEmbed 失敗 ({yt_id}): {e}")
        return {}


# ============================================================
# 3. 中文轉拼音
# ============================================================
# 用 pypinyin, 失敗時 graceful degrade 為空字串.
# pypinyin 約 1.5MB, 已加進 requirements.txt.

def to_pinyin(text: str) -> str:
    """
    把中文轉成拼音 (無聲調, 空格分隔).
    沒裝 pypinyin 或字串沒中文 → 回 "".
    """
    if not text or not _has_cjk(text):
        return ""
    try:
        from pypinyin import lazy_pinyin, Style
        items = lazy_pinyin(text, style=Style.NORMAL)
        return " ".join(items).strip()
    except Exception as e:
        logger.debug(f"[metadata] to_pinyin 失敗: {e}")
        return ""


# ============================================================
# 4. 整合: 從 yt-dlp info dict 建出 SongMetadata
# ============================================================

def build_metadata(
    yt_info: dict,
    youtube_url: Optional[str] = None,
    file_path: Optional[Path] = None,
) -> SongMetadata:
    """
    主入口: 把 yt-dlp info dict (內含 title/uploader/duration/thumbnail ...)
    加上 oEmbed 補強, 最後整理成 SongMetadata。

    Args:
      yt_info:      yt-dlp 回傳的 dict (含 title, uploader, duration, thumbnail 等)
      youtube_url:  原始 URL, 用來叫 oEmbed
      file_path:    對應 mp4 檔路徑 (用於 fallback 解析檔名)
    """
    raw_title = (yt_info.get("title") or "").strip()
    parsed_title, parsed_artist = parse_yt_title(raw_title)

    # 從 yt-dlp uploader 補 artist (YouTube 頻道名, 多半是唱片公司,
    # 比 oEmbed 的 author_name 準, 因為 oEmbed author 會是上傳者帳號)
    yt_artist = (yt_info.get("artist") or yt_info.get("uploader") or yt_info.get("creator") or "").strip() or None
    yt_cover = (yt_info.get("thumbnail") or "").strip() or None
    yt_duration = yt_info.get("duration")
    try:
        yt_duration = int(yt_duration) if yt_duration is not None else None
    except (TypeError, ValueError):
        yt_duration = None

    # oEmbed 補強 (找更好的封面或官方 title)
    if youtube_url:
        oe = fetch_youtube_metadata(youtube_url)
        # oEmbed title 沒比較好 → 不覆蓋
        # oEmbed cover 比 yt-dlp thumbnail 解析度高 → 用它
        if oe.get("thumbnail_url"):
            yt_cover = oe["thumbnail_url"]
        if not yt_artist and oe.get("author_name"):
            yt_artist = oe["author_name"]

    # 如果解析失敗, 用 yt-dlp uploader 當 fallback artist
    if not parsed_artist and yt_artist:
        # 取最後一段 " / " 通常是頻道名後綴
        parsed_artist = yt_artist.split(" - ")[0].strip()

    # 如果 title 還是空的, 用檔名
    if (not parsed_title or parsed_title == "未知歌曲") and file_path:
        parsed_title = file_path.stem.split("_")[0] if "_" in file_path.stem else file_path.stem

    return SongMetadata(
        title=parsed_title,
        artist=parsed_artist,
        raw_title=raw_title,
        channel=yt_artist,
        album=None,
        cover=yt_cover,
        duration=yt_duration,
        pinyin_title=to_pinyin(parsed_title),
        pinyin_artist=to_pinyin(parsed_artist) if parsed_artist else "",
        youtube_id=_extract_yt_id(youtube_url) if youtube_url else None,
        source="local",
    )


def write_metadata_file(metadata: SongMetadata, output_dir: Path, sanitized_name: str) -> Path:
    """
    把 SongMetadata 寫到 output_dir/<sanitized_name>.json。
    Pipeline 處理完時順便寫, 給 Node 中控用。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"{sanitized_name}.json"
    try:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(metadata.to_dict(), f, ensure_ascii=False, indent=2)
        logger.info(f"[metadata] 寫入 metadata: {out_path.name}")
        return out_path
    except Exception as e:
        logger.warning(f"[metadata] 寫 metadata 失敗 ({sanitized_name}): {e}")
        return out_path


def load_metadata_file(metadata_path: Path) -> Optional[SongMetadata]:
    """
    從 .json 讀回 SongMetadata (Node 端若有對應邏輯也能用)。
    讀不到或壞掉 → 回 None, 不 raise。
    """
    try:
        if not metadata_path.exists():
            return None
        with open(metadata_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return SongMetadata(**{k: v for k, v in data.items() if k in SongMetadata.__dataclass_fields__})
    except Exception as e:
        logger.debug(f"[metadata] 讀 metadata 失敗 ({metadata_path.name}): {e}")
        return None


# ============================================================
# 5. CLI / 批次重建 (給 batch_backfill.py 用)
# ============================================================

def main():
    """簡單 CLI, 給批次處理用:
        python metadata.py <processed_dir>
    掃描 processed_dir 內 *.json (現有的 metadata) 或 *_ktv.mp4 (沒 metadata 的, 用檔名解析) 印出統計。
    """
    import sys

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    if len(sys.argv) < 2:
        print("用法: python metadata.py <processed_dir>")
        sys.exit(1)

    target = Path(sys.argv[1])
    if not target.exists():
        print(f"目錄不存在: {target}")
        sys.exit(1)

    mp4s = sorted(target.glob("*_ktv.mp4"))
    print(f"找到 {len(mp4s)} 個 mp4")

    has_meta = 0
    no_meta = []
    for mp4 in mp4s:
        json_path = mp4.parent / f"{mp4.stem.replace('_ktv', '')}.json"
        # 也試 _ktv.json 形式
        json_path_alt = mp4.with_suffix(".json")
        if json_path.exists() or json_path_alt.exists():
            has_meta += 1
        else:
            no_meta.append(mp4.name)

    print(f"  有 metadata: {has_meta}")
    print(f"  缺 metadata: {len(no_meta)}")
    for n in no_meta[:20]:
        print(f"    - {n}")
    if len(no_meta) > 20:
        print(f"    ... 還有 {len(no_meta) - 20} 首")


if __name__ == "__main__":
    main()
