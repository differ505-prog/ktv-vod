# CouchMic — Android TV Kiosk APK

CouchMic 的電視端 APK。**無腦的傀儡播放器**：全螢幕 WebView 載入 `tv.html`，鎖住不讓客人跳出。

## 設計亮點

| 設計 | 對比原 spec | 理由 |
|---|---|---|
| 精準放行 cleartext（區網 + Tailscale） | 不用 `usesCleartextTraffic="true"` 全域開關 | Tailscale 是 HTTPS；只開區網範圍 |
| 單 URL + mDNS 預設值 | 砍掉 primary/secondary fallback | Tailscale 連不到時區網也連不到，假象 fallback |
| WebView 內建錯誤處理 | 不寫 Coroutines probe | 網路暫斷自癒，無需 App 端介入 |
| 短按返回無作用，**長按返回 + PIN 才退出** | 砍掉彈 dialog 詢問 | 遙控器按錯就誤觸 modal 太痛苦 |
| Lock Task Mode (device-owner) | 加進去 | Kiosk 真正的價值，原 spec 漏 |

## 專案結構

```
couchmic-android/
├── build.gradle.kts          # 根 Gradle 設定
├── settings.gradle.kts       # 模組設定
├── gradle.properties         # JVM / AndroidX flags
├── app/
│   ├── build.gradle.kts      # App module (compileSdk 34, minSdk 21)
│   ├── proguard-rules.pro    # WebView keep rules
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/couchmic/tv/
│       │   ├── SetupActivity.kt    # 首次 URL 輸入
│       │   ├── MainActivity.kt     # WebView + Kiosk
│       │   ├── AdminReceiver.kt    # device-owner receiver
│       │   ├── UrlValidator.kt     # URL 驗證 + 補完
│       │   └── Prefs.kt            # SharedPreferences 包裝
│       └── res/
│           ├── layout/             # activity_setup / activity_main / dialog
│           ├── values/             # strings / colors / themes
│           ├── drawable/           # banner + launcher icon
│           └── xml/                # network_security_config + device_admin
```

## Build 步驟

### 1. 安裝 Android Studio
下載 [Android Studio Hedgehog+](https://developer.android.com/studio)，內建 JDK 17。

### 2. 開啟專案
```bash
File → Open → 選 couchmic-android/ 目錄
```
第一次開啟會自動下載 Gradle 8.7 + 依賴，**需要 5-10 分鐘**。

### 3. Build APK
```bash
Build → Build Bundle(s) / APK(s) → Build APK(s)
```
產出：`app/build/outputs/apk/debug/app-debug.apk`

### 4. Release APK（含簽章）
```bash
# 生成 keystore（第一次）
keytool -genkey -v -keystore release.keystore -alias couchmic \
  -keyalg RSA -keysize 2048 -validity 10000

# 設定簽章（在 app/build.gradle.kts 加 signingConfigs）

# Build
Build → Generate Signed Bundle / APK → APK → release
```

## 安裝到電視盒

### 方法 A：ADB sideload
```bash
# 1. 電視盒開啟「開發者模式」+「USB 偵錯」
# 2. 接 USB，驗證連線
adb devices

# 3. 安裝
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 方法 B：adb wifi（推薦，免接線）
```bash
# 1. 電視盒網路 → 開發者選項 → ADB over network → 記下 IP
# 2. 連線
adb connect 192.168.x.x:5555

# 3. 安裝
adb install -r app-debug.apk
```

### 方法 C：隨身碟 / 文件管理員
把 APK 丟進 USB 隨身碟，插上電視盒，用內建文件管理員點安裝。
（要先在「設定 → 應用程式」允許安裝未知來源）

## 設定 Lock Task Mode（Kiosk 鎖定）

**這是真正的 kiosk**。沒做這步，客人還是可以按 Home 鍵跳出。

```bash
# 1. 確認裝置已連線
adb devices

# 2. 一次性設定 device-owner
adb shell dpm set-device-owner com.couchmic.tv/.AdminReceiver
```

**成功的話**會輸出：
```
Success: Device owner set to package com.couchmic.tv
Active admin set to package com.couchmic.tv/.AdminReceiver
```

**移除 device-owner**（想還原時）：
```bash
adb shell dpm remove-active-admin com.couchmic.tv/.AdminReceiver
adb uninstall com.couchmic.tv
```

## 退出 CouchMic

| 動作 | 結果 |
|---|---|
| 短按返回鍵 | 沒作用（避免誤觸），底部浮現「長按返回鍵退出」提示 |
| 長按返回鍵 (≥1s) | 跳出 PIN dialog（預設 `1234`） |
| 輸入正確 PIN | 退出 kiosk 模式，回 launcher |

## 預設 URL

| 情境 | URL |
|---|---|
| 預設（mDNS） | `http://couchmic.local:3001/tv.html` |
| 自家區網 | `http://192.168.31.47:3001/tv.html` |
| Tailscale | `http://<node-name>.ts.net:3001/tv.html` |

第一次開啟會停在 Setup 畫面，輸入任一 URL 即可。

## 與 tv.html 的整合

APK 只是殼，UI 邏輯全在 `public/tv.html` + `public/tv.js`。改網頁後：

```bash
# 部署到 NAS（rsync volume mount 自動生效）
SSHPASS='05050505' rsync -avz \
  -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
  --checksum --exclude='.DS_Store' \
  public/ vibe@192.168.31.47:/home/vibe/ktv-vod/public/
```

APK 不需要重 build。

## 故障排除

| 問題 | 解法 |
|---|---|
| 連得到 WiFi 但載入白屏 | 檢查 server.js 是否還活著：`curl http://192.168.31.47:3001/api/health` |
| `ERR_CLEARTEXT_NOT_PERMITTED` | 確認 `network_security_config.xml` 包含你的 IP 段 |
| Lock Task Mode 設定失敗 | 確認裝置**沒有任何帳號**（登出 Google 帳號或重置） |
| WebView 顯示「不安全」黃色警告 | 同上：cleartext 設定問題 |
| 應用程式閃退 | `adb logcat \| grep couchmic` 看錯誤 |

## 與原 spec 的差異

| 原 spec | 實作 | 原因 |
|---|---|---|
| `usesCleartextTraffic="true"` | `network_security_config.xml` 精準放行 | Tailscale 是 HTTPS；不應全域開 |
| Primary/Secondary URL + Coroutines fallback | 單 URL + mDNS + WebView 內建 retry | 假象 fallback；Tailscale 處理網路層 |
| 返回鍵彈 dialog | 短按無作用 + 長按 PIN | 遙控器按 modal 太痛苦 |
| 無 Lock Task Mode | 加入 device-owner + AdminReceiver | 真正的 kiosk 價值 |

## License

Private — CouchMic internal use.
