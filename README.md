# 🎤 KTV VOD System

> 區域網路 KTV 點歌系統 — 大腦在後端，電視當傀儡，手機當遙控器。

[![CI](https://github.com/<your-account>/ktv-vod-system/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-account>/ktv-vod-system/actions)

一秒搞懂這個專案：**打開電視看到的是「Puppet」，你手機操作的是「Controller」，所有狀態由家裡的「Brain」統一控制**。

---

## 🎯 設計理念

```
┌─────────────────────────────────────────────┐
│  同一個 WiFi 區網裡                          │
│                                              │
│  📺 電視 (tv.html)  ←─── 傀儡 ─────────┐    │
│   ↑ 播放影片、消除人聲                    │    │
│   ↑                                         │    │
│  ☁️ 中控 (server.js) ←─── 大腦 (Brain)─┤    │
│   ↑ 狀態、佇列、音軌模式                  │    │
│   ↑                                        │    │
│  📱 手機 (mobile.html) ←─── 控制器 (Controller)│
│   點歌、切歌、選原唱/伴奏                  │    │
└─────────────────────────────────────────────┘
```

為什麼這樣設計？
- **手機壞了換一支**就能點歌，狀態都在後端
- **電視當純播放器**，不需要安裝 Android App
- **任何人手機掃 QR Code** 就能加入點歌

---

## 🧩 模組組成

| 模組 | 角色 | 技術 | 路徑 |
|------|------|------|------|
| **ktv-brain** | 後端中控 | Node.js + Express + Socket.io | `server.js` |
| **ktv-puppet** | 電視端 | 原生 HTML + JS + Web Audio | `public/tv.html` |
| **ktv-controller** | 手機端 | 原生 HTML + JS | `public/mobile.html` |
| **ktv-pipeline** | 影音處理 | Python + yt-dlp + Demucs | `ktv-pipeline/` |
| **pipeline_server** | Pipeline HTTP wrapper | Flask | `pipeline_server.py` |

---

## ⚡ 快速啟動 (本機開發)

```bash
# 1. 安裝依賴
npm install

# 2. 設定環境變數
cp .env.example .env

# 3. 啟動
npm start

# 4. 瀏覽器開啟
# 電視端：http://localhost:3000/tv.html
# 手機端：http://localhost:3000/mobile.html
```

啟動後會印出 LAN IP QR Code，電視掃一下就能開始點歌。

---

## 🏠 部署到 NAS（推薦方案 A）

完整步驟請看 [DEPLOYMENT.md](DEPLOYMENT.md)。最簡版本：

```bash
# 在 NAS 上
git clone https://github.com/<your-account>/ktv-vod-system.git
cd ktv-vod-system
cp .env.example .env
nano .env                # 填入 PIPELINE_API_TOKEN / PUBLIC_HOST
docker compose up -d --build
```

五分鐘後瀏覽器輸入 `http://<NAS-IP>:3000/tv.html` 就開唱。

---

## 🎬 影音處理 Pipeline

> 從 YouTube 連結 → AI 分離人聲 → 產生可切換「原唱/伴奏」的 KTV 音檔。

```
YouTube URL
   ↓ yt-dlp
原始 mp4
   ↓ ffmpeg 抽音軌
wav (16kHz 立體聲)
   ↓ Demucs (Meta AI)
vocals.wav + no_vocals.wav
   ↓ ffmpeg 混音
[原唱版] + [伴奏版] (雙音軌 .mp4)
   ↓
存入 ktv-data/videos/
   ↓
自動出現在歌曲庫
```

Pipeline 由 `ktv-pipeline/main.py` 實作，HTTP 介面在 `pipeline_server.py`。

### 觸發處理

```bash
curl -X POST http://localhost:3000/api/process-youtube \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=..."}'
```

處理時間：3~5 分鐘/首（無 GPU）/ 30 秒/首（NVIDIA GPU）。

---

## 🎛️ 主要功能

### ✅ v1.0 (已完成)
- [x] 全域狀態中控（後端是 Single Source of Truth）
- [x] Web Audio API 伴奏消除（即時切換原唱/伴奏）
- [x] QR Code 自動產生（電視端掃碼加入）
- [x] 多設備同步（手機一點歌，所有螢幕同步）
- [x] 歌曲庫整合（寫死範例 + 本地 mp4 自動掃描）
- [x] 點歌佇列（多人輪流唱）
- [x] 切歌（所有人同步）
- [x] Docker Compose 一鍵部署

### 🚧 Roadmap
- [ ] YouTube 自動處理 Pipeline (整合 UI)
- [ ] 點歌權限（VIP 優先插隊）
- [ ] 投影片模式（背景播放 MV）
- [ ] 評分系統（音準分析）
- [ ] 歌單收藏（我的最愛）
- [ ] 多房間支援（多台電視）
- [ ] Tailscale 回家（出門也能點歌）

---

## 🛠️ 技術棧

### 後端
- **Node.js 20** — Express + Socket.io
- **Flask 3** — Pipeline HTTP wrapper
- **Python 3.11** — yt-dlp + Demucs + PyTorch

### 前端
- 純 HTML + Vanilla JS（無框架）
- Tailwind CDN（無 build step）
- Socket.io client
- Web Audio API（伴奏消除）

### 部署
- Docker + Docker Compose
- GitHub Actions（CI）

---

## 📁 檔案結構

```
ktv-vod-system/
├── server.js                    ← Node 中控
├── package.json
├── public/
│   ├── tv.html / tv.js          ← 電視端
│   └── mobile.html / mobile.js  ← 手機端
├── ktv-pipeline/
│   ├── main.py                  ← Python 處理主程式
│   └── requirements.txt
├── pipeline_server.py           ← Pipeline HTTP wrapper
├── Dockerfile.node              ← Node 容器
├── Dockerfile.pipeline          ← Python 容器
├── docker-compose.yml           ← 雙容器編排
├── .env.example                 ← 環境變數範本
├── .github/workflows/ci.yml     ← CI 自動檢查
├── DEPLOYMENT.md                ← NAS 部署指南
└── README.md                    ← 你在這裡
```

---

## 🤝 貢獻

1. Fork 這個 repo
2. 建立 feature branch (`git checkout -b feature/awesome`)
3. Commit 變更 (`git commit -m 'feat: 加上評分系統'`)
4. Push 到 branch (`git push origin feature/awesome`)
5. 開 Pull Request

---

## 📝 License

MIT © 2026 KTV VOD System

---

## 🙋 FAQ

**Q: 一定要用 NAS 嗎？**
A: 不一定要 NAS，樹莓派、舊筆電、Mac mini 都行，只要有 Docker。

**Q: 一定要裝 Demucs 嗎？**
A: 不一定。如果你只想播現有影片、不從 YouTube 處理新歌，可以純用 Node 端跑，沒裝 Pipeline 也能用。

**Q: 怎麼支援 HDR 影片？**
A: 電視端目前用 HTML5 `<video>`，瀏覽器原生支援普通 HDR。原生杜比視界需要 Smart TV。

**Q: 怎麼多電視同步？**
A: 開多個瀏覽器或裝置到 `/tv.html`，所有畫面都會同步播同一首（同相 ~100ms 以內）。

**Q: 怎麼關掉 AI 分離功能，純靠硬體？**
A: 不用 Demucs，直接把 `src` 指向你的 mp4（影片本身要雙音軌）。本專案的 Web Audio API 仍是純軟體的人聲消除，獨立於 Demucs 運作。

---

🎤 **Happy Karaoke!**
