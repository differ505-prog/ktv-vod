# 🚀 NAS 部署指南 (方案 A: 區網本機部署)

> **目標**：在家庭 NAS 上 24 小時運行 KTV VOD 系統,
> 電視、手機、筆電都連同一個 WiFi 即可點歌。
> 整套系統完全在你家裡跑, 不依賴任何公網雲端。

---

## 📋 部署前準備

### 硬體需求

| 元件 | 最低 | 建議 |
|------|------|------|
| 記憶體 | 4 GB | **16 GB** (若要跑 Demucs AI 分離) |
| CPU | 2 核心 | 4 核心以上 |
| 儲存 | 10 GB | **100 GB+** (1000 首 ~50GB) |
| GPU | 不需要 | NVIDIA 顯卡 (Demucs 提速 10 倍) |
| 網路 | 100Mbps | 1Gbps |

### 軟體需求

| 工具 | 用途 | 安裝方式 |
|------|------|---------|
| **Docker** | 容器化部署 | `https://docs.docker.com/engine/install/` |
| **Docker Compose** | 多容器管理 | Docker Desktop 內建 |
| **Git** | 拉取程式碼 | `brew install git` (macOS) / `apt install git` (Linux) |

### NAS 系統支援

| NAS 廠牌 | 可用性 | 備註 |
|---------|--------|------|
| **Synology DSM 7+** | ✅ 完全支援 | 套件中心裝 Container Manager |
| **QNAP QTS 5+** | ✅ 完全支援 | App Center 裝 Container Station |
| **Unraid** | ✅ 推薦 | 社群範本最完整 |
| **TrueNAS Scale** | ✅ 完全支援 | Compose 內建 |
| **自組 Linux (Ubuntu/Debian)** | ✅ 完全支援 | Docker CE 直接裝 |

> **本專案目前實際 NAS**：自組 Linux（不是 Synology / QNAP），部署路徑見後面「目前這台 NAS 的實際部署」一節。

---

## ⚡ 五分鐘快速部署 (Docker Compose)

### 步驟 1: 拉取程式碼

```bash
# SSH 進 NAS (或接 HDMI 鍵盤螢幕)
ssh admin@your-nas-ip

# 用 docker user 操作
sudo -i

# 選一個資料夾存放程式碼
mkdir -p /volume1/docker/ktv
cd /volume1/docker/ktv

# 拉取 (替換成你的 GitHub repo URL)
git clone https://github.com/<your-account>/ktv-vod-system.git .
```

### 步驟 2: 設定環境變數

```bash
cp .env.example .env
nano .env
```

**必填項目**：
```bash
# 強烈建議改一組亂數 token, Node 與 Pipeline 之間會用到
PIPELINE_API_TOKEN=$(openssl rand -hex 32)

# 如果你的 NAS 固定 IP 是 192.168.1.100, 設這個讓 QR code 正確顯示
PUBLIC_HOST=192.168.1.100

# 若 NAS 沒獨顯 (GeForce/Quadro), 設 true
DEMUCS_FORCE_CPU=true
```

### 步驟 3: 啟動

```bash
docker compose up -d --build
```

第一次 build 會下載：
- Node.js 20 + 依賴 (~150 MB)
- Python 3.11 + PyTorch + Demucs (**~2 GB**)

5~30 分鐘不等，看網速。

### 步驟 4: 檢查狀態

```bash
# 看容器是否健康
docker compose ps

# 看 Node 中控日誌
docker compose logs -f ktv-brain

# 看 Pipeline 日誌
docker compose logs -f ktv-pipeline
```

正常會看到：
```
═══════════════════════════════════════════
  🎤 KTV VOD System 已啟動 (Brain Online)
═══════════════════════════════════════════
  📺 電視端：  http://192.168.1.100:3000/tv.html
  📱 手機端：  http://192.168.1.100:3000/mobile.html
═══════════════════════════════════════════
```

### 步驟 5: 開瀏覽器測試

```
http://192.168.1.100:3000/tv.html       ← 電視端
http://192.168.1.100:3000/mobile.html   ← 手機端
```

---

## 🎬 加上你的第一首歌

### 方法 A: 直接丟 mp4 到 `/videos/`

```bash
# 把檔案塞到 NAS 的 processed 目錄
cp /your/path/林俊傑-江南.mp4 \
   /var/lib/docker/volumes/ktv-data/_data/videos/

# Docker 內部會自動看到, 重啟服務即可重新掃描
docker compose restart ktv-brain
```

Docker compose volume 預設路徑在：
```
/var/lib/docker/volumes/ktv-data/_data/
```

也可以直接把整個 volume 掛到 NAS 目錄，編輯 `docker-compose.yml`：
```yaml
volumes:
  - /volume1/docker/ktv-storage:/ktv-data
```

### 方法 B: 從 YouTube 自動處理

```bash
# 打 API 觸發 pipeline
curl -X POST http://192.168.1.100:3000/api/process-youtube \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title": "Never Gonna Give You Up",
    "artist": "Rick Astley"
  }'

# 查 job 狀態
curl http://192.168.1.100:3000/api/health
```

Pipeline 會：
1. 下載 YouTube 影片
2. Demucs 跑 AI 分離 (原唱 / 伴奏)
3. 混音成 `_ktv.mp4` 輸出到 `ktv-data/videos/`
4. 自動加入 Node 中控的歌曲庫

> ⚠️ API 路徑的 `/process-youtube` 與 `192.168.1.100` 為通用範例；本專案實際 NAS 請改用 [§目前這台 NAS 的實際部署](#目前這台-nas-的實際部署) 裡的 host / port。

---

## 目前這台 NAS 的實際部署

> 這一節是**本專案這台 NAS** 的實際現況，跟前面「通用 Synology 範例」不同。

### 連線資訊

| 項目 | 值 |
| --- | --- |
| SSH（家裡區網） | `ssh vibe@192.168.31.47` |
| SSH（出門 / Tailscale） | `ssh vibe@vibe-nas` 或 `ssh vibe@100.72.78.110` |
| 密碼 | `05050505` |
| 專案根目錄 | `/home/vibe/ktv-vod/` |
| `public/` 前端 | `/home/vibe/ktv-vod/public/` |
| `ktv-data/` volume | `/home/vibe/ktv-vod/ktv-data/` |

> **區網 vs Tailscale**：出門時 `192.168.31.47` 連不到（你不在家用 WiFi），改用 Tailscale magic DNS `vibe-nas` 或 IP `100.72.78.110`。兩者都行；magic DNS 比較好讀，IP 是 fallback。

### 對外服務 port

| 服務 | 容器 | Host port | 備註 |
| --- | --- | --- | --- |
| KTV Brain (Node 中控 + 前端) | `ktv-brain` | **3001** | Host port 3000 被 `homepage` 佔用 |
| KTV Pipeline (Python) | `ktv-pipeline` | 5050 | |
| Homepage | `homepage` | 3000 | **不是 KTV**，不要從 port 3000 點歌 |

使用者入口：
- 電視（家裡）：`http://192.168.31.47:3001/tv.html`
- 手機（家裡）：`http://192.168.31.47:3001/mobile.html`
- 電視（出門）：`http://100.72.78.110:3001/tv.html`
- 手機（出門）：`http://100.72.78.110:3001/mobile.html`

### 快速更新前端（`public/`，免重啟）

**方法 A：自動 fallback（推薦）**

```bash
bash scripts/deploy-public.sh               # 全部 public/
bash scripts/deploy-public.sh public/tv.js  # 單檔
```

Script 會先試 `192.168.31.47`（家裡區網），連不上就 fallback 到 Tailscale `vibe-nas`。家裡 / 外面都不用改指令。

**方法 B：手動指定 host**

```bash
# 家裡
SSHPASS='05050505' rsync -avz \
  -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
  --checksum \
  --exclude='.DS_Store' \
  public/ \
  vibe@192.168.31.47:/home/vibe/ktv-vod/public/

# 出門走 Tailscale
SSHPASS='05050505' rsync -avz \
  -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
  --checksum \
  --exclude='.DS_Store' \
  public/ \
  vibe@vibe-nas:/home/vibe/ktv-vod/public/
```

- `public/` 是用 volume mount 進容器的（`./public:/app/public:ro`），所以**毋需重啟任何服務**。
- 使用者重新整理瀏覽器（Cmd+Shift+R）即可拿到新版。
- `--checksum` 確保只動真正有差異的檔案。

### 快速更新 Pipeline（Python，要重啟）

```bash
bash ktv-pipeline/deploy_via_ssh.sh ktv-pipeline
```

- 這支 script 預設連 `vibe@192.168.31.47` 並把 `main.py / alignment.py / test_alignment.py` 推進 `ktv-pipeline` 容器。
- 部署後會自動跑 pytest 驗證。

### 升級完整服務（Docker image 重建）

```bash
ssh vibe@192.168.31.47
cd /home/vibe/ktv-vod
git pull
docker compose up -d --build
```

---

## 🔄 日常維護

### 升級程式碼

```bash
ssh vibe@192.168.31.47
cd /home/vibe/ktv-vod
git pull
docker compose up -d --build
```

### 備份歌曲庫

```bash
# 整包打包
docker run --rm \
  -v ktv-data:/source:ro \
  -v /home/vibe/ktv-vod/backups:/dest \
  alpine tar czf /dest/ktv-data-$(date +%Y%m%d).tar.gz -C /source .
```

### 監看資源

```bash
docker stats

# 或用 Portainer UI (推薦)
docker run -d -p 9000:9000 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  portainer/portainer-ce
```

### 清除舊日誌

```bash
docker compose logs --tail=0 -f ktv-brain &
# 按 Ctrl+C 退出觀看但保留檔案
truncate -s 0 $(docker inspect --format='{{.LogPath}}' ktv-brain)
```

---

## 🚨 常見問題

### Q1: 電視端開 `tv.html` 顯示「連線中斷」？
**A:** 檢查手機/電視跟 NAS 是否同一個 WiFi。看 `docker compose logs ktv-brain` 有沒有錯誤。

### Q2: Demucs 跑很慢？
**A:**
- 確認 `DEMUCS_FORCE_CPU` 設定（沒顯卡就 true）
- 把 `DEMUCS_MODEL` 從 `htdemucs_ft` 改回 `htdemucs`（速度快 3 倍）
- 一首歌 3~5 分鐘很正常

### Q3: 怎麼找 NAS 的 IP？
**A:**
```bash
# 在 NAS 上
ip addr show | grep "inet "
# 或
hostname -I
```

### Q4: 怎麼換 Port？
**A:** 編輯 `docker-compose.yml`，改 `ports: "8080:3000"`，重啟。

### Q5: 怎麼對外開放（出門也能用）？
**A:** 請參考方案 B（VPS + Tailscale）或方案 E（Cloudflare Tunnel）。

### Q6: 想讓手機不裝 Tailscale 也能用？
**A:** 在 NAS router 開 port forwarding 給 3000 port，但非常不建議（暴露公網風險高）。

---

## 🛡️ 安全性提醒

1. **務必改 `PIPELINE_API_TOKEN`** 為 32 字元以上亂數
2. **不要把 3000 與 5050 port 暴露到公網**
3. **NAS 系統記得定期更新 DSM / QTS**
4. **Docker image 定期 `docker compose pull` 抓安全更新**

---

## 📁 完整檔案結構

部署完之後，你的 NAS 上會有：

```
/home/vibe/ktv-vod/                  ← 程式碼倉庫
├── .env                             ← 你的密碼/token
├── docker-compose.yml
├── server.js
├── public/
│   ├── tv.html / tv.js
│   └── mobile.html / mobile.js
├── ktv-pipeline/
│   ├── main.py                      ← Python 處理腳本
│   └── requirements.txt
├── pipeline_server.py
├── Dockerfile.node
├── Dockerfile.pipeline
└── ktv-data/                        ← Docker volume
    ├── videos/                      ← 已處理的 mp4
    ├── processed/                   ← Pipeline 產出
    └── work/                        ← 暫存 (會自動清理)
```

> 「通用 Synology 範例」對應的路徑是 `/volume1/docker/ktv/`。本專案這台 NAS 實際用 `/home/vibe/ktv-vod/`，兩者差異見「目前這台 NAS 的實際部署」一節。

---

## 🎉 部署完成

打開電視瀏覽器輸入 `tv.html`，電視上會顯示 QR Code，
用手機掃一下就能開始點歌。

🎤 開唱！
