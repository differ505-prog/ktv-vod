# KTV VOD 環境速查表

> 給未來對話使用:本專案的所有「主機、帳號、容器、路徑、驗證指令」都記錄在這一份文件,避免每次開新對話都重找。

---

## 1. 主機與帳號

| 用途 | 連線資訊 | 帳號 | 密碼 |
|------|----------|------|------|
| NAS (部署 + 媒體) | `vibe@192.168.31.47:22` (SSH) | `vibe` | `05050505` |
| NAS 網頁入口 (Jellyfin / KTV Brain) | `http://192.168.31.47:3001` (Node) | — | — |
| KTV Brain API | `http://192.168.31.47:3001/api/...` | — | — |
| Pipeline API | `http://192.168.31.47:5050` (在容器內) | token 由 `PIPELINE_API_TOKEN` env 設定 | — |
| Mac 本機工作區 | `/Users/liangzhiwei/Documents/VIbe Coding/卡拉ok` | — | — |

> 注:語音裡常說的 `192.168.1.119` 是舊 IP,目前對應的 IP 應為 `192.168.31.47`(以 SSH 為準)。

---

## 2. NAS 上的容器

```bash
ssh vibe@192.168.31.47
docker ps --format '{{.Names}}\t{{.Image}}'
```

與本專案相關的容器:

| 容器名 | 角色 | 對內 Port | 對外 Port |
|--------|------|-----------|-----------|
| `ktv-brain` | Node.js 中控 (Express + Socket.io) | 3000 | **3001** |
| `ktv-pipeline` | Python 處理 (yt-dlp + Demucs) | 5050 | — |

### 容器內路徑 vs 宿主路徑

docker-compose 把 `ktv-data` volume 掛載到 `ktv-pipeline` 與 `ktv-brain` 兩容器內部的 `/ktv-data/`。

| 容器內絕對路徑 | 用途 |
|----------------|------|
| `/ktv-data/processed/` | **已處理完的 KTV mp4** (Node 中控掃這裡) |
| `/ktv-data/work/` | Pipeline 處理中的 temp (處理完會清空) |
| `/ktv-data/videos/` | (空目錄,保留用) |

---

## 3. 處理過的影片實際位置

目前已處理過的 KTV 影片:

- 宿主 docker volume 名稱:**`ktv-data`** (以 `docker volume inspect ktv-data` 查看)
- 容器內看到: `/ktv-data/processed/芒果醬_Mango_Jump〈我喜歡你_I'm_Into_You〉｜Official_Music_Video_ktv.mp4`
- 容器內看到: `/ktv-data/processed/芒果醬_Mango_Jump〈我喜歡你_I'm_Into_You〉｜Official_Music_Video_ktv_vocal_off.mp4`

(檔名有 `〈〉` 與 `'` 與中文,複製命令時注意 quoting。)

---

## 4. 快速驗證指令

### 4.1 列出已處理影片
```bash
ssh vibe@192.168.31.47 'docker exec ktv-brain sh -c "cd /ktv-data/processed && ls -la"'
```

### 4.2 量測單首 mp4 的串流資訊 (音訊 / 視訊時長、PTS、start_time)
```bash
ssh vibe@192.168.31.47 'docker exec ktv-brain sh -c "cd /ktv-data/processed && for f in *.mp4; do echo \"=== \$f ===\"; ffprobe -v error -show_entries stream=index,codec_type,codec_name,duration,start_time,start_pts -show_entries format=duration -of default=nw=1 \"\$f\"; done"'
```

### 4.3 查看音訊 packet 的 PTS 分布 (檢查開頭是否有 demucs padding)
```bash
ssh vibe@192.168.31.47 'docker exec ktv-brain sh -c "cd /ktv-data/processed && ffprobe -v error -show_entries packet=pts_time,flags -select_streams a -of csv=p=0 -read_intervals \"%+#20\" \"\$(ls *ktv.mp4)\""'
```

> `-0.023220,KD,` 的 `D` flag 表示 ffmpeg 預熱 packet (pre-pad),正常應 < 50ms。
> 如果看到連續多個 `D` packet 累積 > 500ms,代表 demucs 在開頭 padding 了 silence。

### 4.4 檢查 / 重啟容器
```bash
ssh vibe@192.168.31.47 'docker ps --format "{{.Names}}\t{{.Status}}" | grep -i ktv'
ssh vibe@192.168.31.47 'cd ktv-vod && docker compose restart ktv-brain'
```

### 4.5 本機可讀取 NAS mp4 (scp)
```bash
scp vibe@192.168.31.47:/var/lib/docker/volumes/ktv-data/_data/processed/芒果醬*.mp4 /tmp/
```

(`docker volume inspect ktv-data | grep Mountpoint` 確認實際 mountpoint。)

---

## 5. 字幕偏移 bug 紀錄 (2026-07-26)

### 症狀
- 在 tv.html 載入 `*_ktv.mp4` 後,**字幕比歌聲早 ~1 秒** 就出現。
- 切到 `*_vocal_off.mp4` 時偏移更明顯。

### 確認已排除的
- ❌ 音訊檔本身時長錯誤:ffprobe 顯示 `ktv.mp4` 與 `vocal_off.mp4` 音訊都 219.66s,視訊 219.59s。
- ❌ Packet PTS 嚴重漂移:第一個 packet `-0.023s` 是 ffmpeg 預熱,正常。
- ❌ Web Audio API 切聲道導致的偏移:切換前就已經偏移。

### 鎖定根因 (邏輯推論)
- 字幕是「**燒在視訊畫面裡的圖片**」(來源是 YouTube 原 MV,中文硬字幕)。
- **視訊 track 是 `-c:v copy` 從 YouTube 原始 mp4 帶過來的**,字幕位置 / 顯示時間由 YouTube 原始 mv 決定。
- **音訊經過 Demucs (`ktv-pipeline/main.py` stage_separate) 重分離 → 寫 wav → ffmpeg 重編碼**,Demucs 模型內部有 inference 預熱,**會在 vocals.wav / no_vocals.wav 開頭 padding 一段 silence** (典型 0.5 ~ 1.5 秒)。
- 最終 ffmpeg 合成 `*_ktv.mp4` 時,**視訊從頭 0 開始播**(字幕第一個關鍵字),但**音訊有效聲音從 0.5~1.5s 才開始**。
- 視覺上 → 「字幕比歌早 1 秒」。

### 修正方向 (待實作)
兩種路徑:

**路徑 A (推薦,治標 + 治本):** 在 `ktv-pipeline/main.py` `stage_mix_and_encode` 的 ffmpeg 命令前面加上:
- `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level` 偵測 silence 開頭
- 或直接 `atrim=start=<leading_silence_seconds>`,依偵測結果裁掉

**路徑 B (治本):** 改用 `apply_model(..., shifts=1)` 或 `overlap=0.0` 讓 demucs 不要 padding。

### 驗證修正成功的指令
```bash
# 1. 重新處理一支歌
# 2. 抽出音訊前 3 秒
ssh vibe@192.168.31.47 'docker exec ktv-brain sh -c "ffmpeg -i /ktv-data/processed/<name>_ktv.mp4 -t 3 -vn -af \"astats=metadata=1:reset=1,ametadata=print\" -f null - 2>&1 | head -50"'
# 期待前 0.1 秒 RMS 不低於 -30dB (代表沒有 leading silence)
```

---

## 6. 專案程式碼對應

| 區塊 | 檔案 |
|------|------|
| Node 中控 (Brain) | `server.js` |
| 電視端 (Puppet) | `public/tv.html`, `public/tv.js` |
| 手機端 (Controller) | `public/mobile.html`, `public/mobile.js` |
| 處理 Pipeline | `ktv-pipeline/main.py` |
| Pipeline HTTP wrapper | `pipeline_server.py` |
| 抽出純伴奏工具 | `scripts/extract_vocal_off.sh` |
| Docker Compose | `docker-compose.yml` |
| NAS 部署指南 | `DEPLOYMENT.md` |
| 專案總覽 | `README.md` |

---

## 7. 常用 ports

| Port | 服務 |
|------|------|
| 3001 | KTV Brain (對外) |
| 5050 | Pipeline API (容器內) |
| 80 | Jellyfin (容器內) |
| 8096 | Immich web |

---

## 8. 環境變數 .env (在 NAS 上的 `ktv-vod/.env`)

- `PIPELINE_API_TOKEN`:Pipeline 與 Brain 之間的 bearer token
- `PUBLIC_HOST`:LAN IP,用於 QR Code 顯示
- `DEMUCS_MODEL`:預設 `htdemucs`
- `DEMUCS_FORCE_CPU`:預設 `false` (Apple Silicon 上是 MPS)

---

最後更新: 2026-07-26 by Cursor
