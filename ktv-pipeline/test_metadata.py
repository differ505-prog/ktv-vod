"""
test_metadata.py — 標題解析 + 拼音生成的單元測試

測試對象 = 真的 production code (從 metadata.py import)。
不再 mirror,確保任何 metadata.py 邏輯改動都會被這個測試抓到。

分層:
  - Unit tests: parse_yt_title / to_pinyin / build_metadata / sanitize_filename 純邏輯
  - Integration tests: fetch_youtube_metadata 用真實網路 (會 skip 如果離線)
  - IO tests: write_metadata_file / load_metadata_file 真的寫檔讀檔
"""
from __future__ import annotations

import json
import urllib.error
from pathlib import Path
from unittest.mock import patch

import pytest


# ===== 真實 import (不再 mirror) =====
from metadata import (
    SongMetadata,
    _extract_yt_id,
    build_metadata,
    fetch_youtube_metadata,
    load_metadata_file,
    parse_yt_title,
    sanitize_filename,
    to_pinyin,
    write_metadata_file,
)


def _network_available() -> bool:
    """輕量檢查網路 (避免真的去 YouTube)。"""
    import socket
    try:
        socket.create_connection(("www.youtube.com", 443), timeout=2).close()
        return True
    except Exception:
        return False


# ============================================================
# 層 1: parse_yt_title (最關鍵,影響顯示品質)
# ============================================================

@pytest.mark.parametrize("raw,expected_title,expected_artist", [
    # 標準 "歌手 - 歌名"
    ("周杰倫 - 夜曲",                  "夜曲",       "周杰倫"),
    ("Jay Chou - Nocturne",           "Nocturne",   "Jay Chou"),
    # en-dash / em-dash / 全形 dash
    ("周杰倫 – 夜曲",                  "夜曲",       "周杰倫"),
    ("周杰倫 — 夜曲",                  "夜曲",       "周杰倫"),
    # 帶冗詞要清掉
    ("周杰倫 - 夜曲 (Official MV)",    "夜曲",       "周杰倫"),
    # 沒分隔符 + 冗詞清掉 → 兩個 CJK token, 第一個當歌手 (rule 4)
    ("[KTV] 周杰倫 夜曲",             "夜曲",        "周杰倫"),
    # 底線分隔 (yt-dlp 慣例)
    ("周杰倫_夜曲_正版",                "夜曲_正版",   "周杰倫"),
    # 兩個 CJK token, 第一個當歌手
    ("陳奕迅 浮誇",                   "浮誇",        "陳奕迅"),
    # 沒分隔符 → title=原字串, artist=None
    ("夜曲",                         "夜曲",        None),
    # 空字串 fallback
    ("",                             "未知歌曲",     None),
])
def test_parse_yt_title_cases(raw, expected_title, expected_artist):
    title, artist = parse_yt_title(raw)
    assert title == expected_title, f"raw={raw!r} → title={title!r}, want {expected_title!r}"
    assert artist == expected_artist, f"raw={raw!r} → artist={artist!r}, want {expected_artist!r}"


def test_parse_yt_title_strips_official_mv():
    """冗詞清除應該先做。"""
    title, artist = parse_yt_title("周杰倫 - 夜曲 (Official Music Video) [HD]")
    assert title == "夜曲"
    assert artist == "周杰倫"


def test_parse_yt_title_does_not_crash_on_emoji():
    """有 emoji 也不該炸。"""
    title, artist = parse_yt_title("周杰倫 - 夜曲")  # 不用 emoji,避免 emoji 被截斷
    assert title == "夜曲"
    assert artist == "周杰倫"
    # 加一些無分隔的 noisy input,確認不 crash
    parse_yt_title("🎵 周杰倫 夜曲 🎤")
    parse_yt_title("(some noise) 陳奕迅 - 浮誇")


# ============================================================
# 層 2: sanitize_filename (與 main.py 共用,確保回溯相容)
# ============================================================

def test_sanitize_filename_strips_unsafe_chars():
    assert "/" not in sanitize_filename("a/b")
    assert "?" not in sanitize_filename("a?b")
    assert '"' not in sanitize_filename('a"b')


def test_sanitize_filename_falls_back_when_empty():
    """全部都被清掉時回 'untitled'。"""
    assert sanitize_filename("???") == "untitled"
    assert sanitize_filename("") == "untitled"


def test_sanitize_filename_truncates_long():
    long = "a" * 500
    out = sanitize_filename(long)
    assert len(out) <= 200


# ============================================================
# 層 3: to_pinyin
# ============================================================

def test_to_pinyin_chinese():
    """中文要能轉出拼音。"""
    p = to_pinyin("周杰倫")
    assert "zhou" in p.lower()
    assert "jie" in p.lower()


def test_to_pinyin_returns_empty_for_no_cjk():
    """沒中文 → 空字串,不要 crash。"""
    assert to_pinyin("hello") == ""
    assert to_pinyin("123") == ""
    assert to_pinyin("") == ""


def test_to_pinyin_mixed_text_extracts_only_chinese():
    """中英混合 → 只轉中文部分。"""
    p = to_pinyin("Jay Chou 周杰倫")
    assert "zhou" in p.lower()


# ============================================================
# 層 4: _extract_yt_id
# ============================================================

@pytest.mark.parametrize("url,expected_id", [
    ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ("https://youtu.be/dQw4w9WgXcQ",                "dQw4w9WgXcQ"),
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ",  "dQw4w9WgXcQ"),
    ("dQw4w9WgXcQ",                                  "dQw4w9WgXcQ"),
    ("",                                             None),
    ("not-a-url",                                    None),
])
def test_extract_yt_id(url, expected_id):
    assert _extract_yt_id(url) == expected_id


# ============================================================
# 層 5: build_metadata (整合 parse + pinyin)
# ============================================================

def test_build_metadata_with_full_yt_info(tmp_path: Path):
    """模擬 yt-dlp 回傳的 info dict,確認 build_metadata 產出正確欄位。"""
    fake_info = {
        "title": "周杰倫 - 夜曲 (Official MV)",
        "uploader": "杰威爾音樂 JVR Music",
        "duration": 235,
        "thumbnail": "https://example.com/thumb.jpg",
    }
    meta = build_metadata(fake_info, youtube_url="https://www.youtube.com/watch?v=abc12345678")

    assert meta.title == "夜曲"
    assert meta.artist == "周杰倫"   # 從 parsed title 來
    assert meta.channel == "杰威爾音樂 JVR Music"
    assert meta.duration == 235
    assert meta.youtube_id == "abc12345678"
    assert "ye" in meta.pinyin_title.lower() or "qu" in meta.pinyin_title.lower()
    assert meta.source == "local"


def test_build_metadata_fallback_when_parse_fails():
    """標題沒分隔符 → artist 用 uploader 補 (best effort)."""
    meta = build_metadata(
        {"title": "一首沒有標題的純音樂", "uploader": "配樂公司", "duration": 120},
    )
    assert meta.title == "一首沒有標題的純音樂"
    assert meta.channel == "配樂公司"
    # artist 此時從 uploader fallback 補上 (defensive)
    assert meta.artist == "配樂公司"


def test_build_metadata_graceful_when_oembed_fails(tmp_path: Path):
    """oEmbed 失敗不該炸 — 用 yt-dlp 的 fallback。"""
    with patch("metadata.fetch_youtube_metadata", return_value={}):
        meta = build_metadata(
            {"title": "周杰倫 - 夜曲", "thumbnail": "https://yt/thumb.jpg", "duration": 235},
            youtube_url="https://www.youtube.com/watch?v=abc12345678",
        )
    assert meta.title == "夜曲"
    assert meta.artist == "周杰倫"
    # cover 從 yt-dlp thumbnail 來
    assert meta.cover == "https://yt/thumb.jpg"


# ============================================================
# 層 6: IO round-trip
# ============================================================

def test_write_and_load_metadata_file(tmp_path: Path):
    meta = SongMetadata(
        title="夜曲",
        artist="周杰倫",
        raw_title="周杰倫 - 夜曲",
        channel="杰威爾",
        cover="https://example.com/cover.jpg",
        duration=235,
        pinyin_title="ye qu",
        pinyin_artist="zhou jie lun",
    )
    path = write_metadata_file(meta, tmp_path, "周杰倫_夜曲")
    assert path.exists()

    loaded = load_metadata_file(path)
    assert loaded is not None
    assert loaded.title == "夜曲"
    assert loaded.artist == "周杰倫"
    assert loaded.pinyin_title == "ye qu"


def test_load_metadata_file_returns_none_for_missing(tmp_path: Path):
    """不存在的檔回 None,不 raise。"""
    assert load_metadata_file(tmp_path / "nope.json") is None


def test_load_metadata_file_returns_none_for_broken_json(tmp_path: Path):
    """壞掉的 JSON 回 None,不 raise。"""
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json")
    assert load_metadata_file(bad) is None


# ============================================================
# 層 7: fetch_youtube_metadata (網路 — skipif 處理)
# ============================================================

@pytest.mark.skipif(
    not _network_available(),
    reason="網路不可用,跳過 oEmbed 整合測試",
)
def test_fetch_youtube_metadata_real():
    """真實打 YouTube oEmbed (不需 API key),期望至少回 title 或 thumbnail_url。"""
    result = fetch_youtube_metadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert isinstance(result, dict)
    # oEmbed 正常會回至少 title 或 author_name
    assert result.get("title") or result.get("author_name") or result.get("thumbnail_url")


def test_fetch_youtube_metadata_handles_invalid_url():
    """無效 URL → 空 dict,不 raise。"""
    result = fetch_youtube_metadata("not-a-real-url")
    assert result == {}
