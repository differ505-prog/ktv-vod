# KTV Telegram Bot — 朋友 YouTube 自動點歌

## 設定流程 (5 分鐘)

### 1. 建立 Telegram Bot
1. 手機打開 Telegram,搜尋 **@BotFather**
2. 輸入 `/newbot`
3. 依指示取名字 + username (例如 `KTVSongBot`)
4. BotFather 會回 **token**,複製起來

### 2. 把 token 填進 NAS
```bash
ssh vibe@192.168.31.47
echo 'TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHI...' >> /home/vibe/ktv-vod/.env
cd /home/vibe/ktv-vod
docker compose up -d telegram-bot
docker logs -f ktv-telegram-bot
```

應該看到:
```
[start] KTV Telegram Bot
  KTV API: http://ktv-brain:3000
  Allowed users: (all)
```

### 3. 朋友手機操作
1. 裝 Telegram (iOS/Android 免費)
2. 搜尋剛剛的 bot username (例如 `@KTVSongBot`)
3. 按 **Start**
4. **把 YouTube 網址貼到對話框送出**

Bot 會立刻回:
```
已送 pipeline 🎤
URL: https://youtu.be/...
Job: abc123def456
完成會自動通知
```

5~15 分鐘後,Bot 會主動通知:
```
✅ 完成: https://youtu.be/...
已加入點歌機, 可以去電視點了
```

## 安全性:白名單 (選用)

預設任何人加 bot 都可以點歌 (派對模式)。
要鎖定只有授權 user 可用:

```bash
# 1. 在 Telegram 找 @userinfobot → 它會回你 user id (純數字)
# 2. 填入 .env:
echo 'TELEGRAM_ALLOWED_USERS=123456789,987654321' >> /home/vibe/ktv-vod/.env
docker compose up -d telegram-bot
```

## iOS 快捷指令 (1-tap 分享)

在 iPhone 上可以設一個「分享到 KTV Bot」快捷指令:

1. iPhone 開「**快捷指令**」App
2. 右上 `+` 新增
3. 加入動作: **接收 → 接受 URL**
4. 加入動作: **傳送訊息** (Telegram) → 選剛剛的 Bot → 訊息內容 `ShortcutInput`
5. 命名 `點到 KTV`

之後 YouTube App → 分享 → 選 `點到 KTV` → 一鍵送出。

(Android 用戶可在 `Tasker` 達類似效果)

## 原理 (TL;DR)

```
YouTube App 分享 URL
    ↓
Telegram (使用者發訊息到 Bot)
    ↓ long polling (Bot 主動拉, 免 HTTPS)
ktv-telegram-bot container
    ↓ POST /api/process-youtube
ktv-brain (server.js) → proxy 到 pipeline_server
    ↓
ktv-pipeline (yt-dlp + Demucs + ffmpeg)
    ↓
/ktv-data/processed/*.mp4 + .m4a
    ↓
手機點歌 App 立即可見
```

全程不需 HTTPS、不花錢、不需朋友家裝新 App (只要 Telegram)。