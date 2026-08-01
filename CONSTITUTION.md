# 📜 卡拉OK 專案憲法

> 這份檔案是 Cursor Agent 與其他自動化工具的「單一事實來源（Single Source of Truth）」。
> 任何不能遺忘的基礎設施資訊、不可違反的部署規則，都記錄在這裡。
> **不要在對話中反覆詢問已記錄的內容。**

最後更新：2026-07-27（§5.1 修憲:優化/除錯完成「一律」自動 deploy,不再反問；§6 新增:外網 Funnel + §5.4 評估前考慮更優解）

---

## 1. 基礎設施：NAS (Vibe Server)

| 項目 | 值 |
| --- | --- |
| 主機 | `192.168.31.47` |
| SSH Port | `22` |
| 帳號 | `vibe` |
| 密碼 | `05050505` |
| SSH 連線字串 | `ssh vibe@192.168.31.47` |

### 用途
- 部署 KTV 服務的目標主機（`ktv-pipeline` / `pipeline_server` 跑在 NAS 或其容器內）。
- 存放歌曲檔案、模型、人聲分離輸出。
- `ktv-pipeline/deploy_to_nas.sh` 與 `ktv-pipeline/deploy_via_ssh.sh` 都會用到以上資訊。

### 使用提醒
- 連線後建議先 `cd` 到部署用工作目錄（見 §2）。
- 密碼屬於敏感資訊，禁止 commit 到公開 repo；本地使用沒問題。
- 若日後換 NAS / 換密碼，請直接更新本檔並 git commit，agent 應自動讀取最新版。

---

## 2. 部署目標路徑（NAS 上）

| 項目 | 值 |
| --- | --- |
| 專案根目錄 | `/home/vibe/ktv-vod/` |
| `public/` (前端) | `/home/vibe/ktv-vod/public/` |
| `ktv-data/` volume | `/home/vibe/ktv-vod/ktv-data/` |

> `DEPLOYMENT.md` 寫的 `/volume1/docker/ktv` 是 Synology 範例路徑，**實際 NAS 用 `/home/vibe/ktv-vod/`**。

## 3. 對外服務埠（已驗證）

| 服務 | 容器 | Host port | 備註 |
| --- | --- | --- | --- |
| KTV Brain (Node 中控 + 前端) | `ktv-brain` | **3001** | Host port 3000 被 `homepage` 佔用 |
| KTV Pipeline (Python) | `ktv-pipeline` | 5050 | |
| Homepage | `homepage` | 3000 | **不是 KTV**，不要從 port 3000 點歌 |

使用者入口：`http://192.168.31.47:3001/mobile.html` / `http://192.168.31.47:3001/tv.html`

## 6. 外網 Funnel（2026-07-27 確立）

> 朋友在家用手機瀏覽器開 KTV，不必裝任何 App。

### 6.1 現有 Funnel（Tailscale）

| 用途 | URL | 對應 |
|---|---|---|
| **KTV** | `https://vibe-nas.taila67710.ts.net/tv.html` | host `:3001` |
| Jellyfin | `https://vibe-nas.taila67710.ts.net:8443/` | host `:8096` |

### 6.2 設定指令（sudo）

```bash
# 一次性：讓當前使用者能改 tailscale serve config
echo '05050505' | sudo -S tailscale set --operator=$(whoami)

# 加 KTV Funnel（占 443，與 Jellyfin 8443 不衝突）
echo '05050505' | sudo -S tailscale funnel --bg --https=443 http://localhost:3001

# 檢視
sudo tailscale funnel status
```

### 6.3 重要約束

- Funnel 預設走 **HTTPS port 443**，沒法直接換 port — 想用其他 port 必須在 Tailscale admin 後台 ACL 開「allow funnel on port X」。
- Jellyfin 已用 `:8443` Funnel，KTV 用 `:443`，兩者**不會互相覆蓋**。
- Tailscale Funnel 的 `*.ts.net` 是**公開 HTTPS**，瀏覽器直接打就能連（朋友不必裝 Tailscale），跟 Quick Tunnel 行為類似。
- KTV APK 用 `window.location.host` 組 server URL，所以連外網 Funnel 自動走 https，無需改 APK。

### 6.4 為什麼不只用 Cloudflare Quick Tunnel？

Quick Tunnel 網址每次重啟變動（`xxx.trycloudflare.com` 隨機子網域），不適合寫死或長期記憶。Tailscale Funnel 綁死 `vibe-nas.taila67710.ts.net`，永久不變。

### 6.5 修憲與調整原則（依 §5.4i）

- 改 Funnel 設定前，先比較 Cloudflare Named Tunnel（需註冊 CF 帳號，免費固定子網域）、Tailscale Funnel、DDNS+port forward 等方案評分，再決定。
- 不要單純因為「現在能跑」就不評估替代方案。

## 4. 部署流程（已驗證）

### 4.1 前端 / Node 中控（使用 rsync + sshpass）
```bash
SSHPASS='05050505' rsync -avz \
  -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
  --checksum \
  --exclude='.DS_Store' \
  public/ \
  vibe@192.168.31.47:/home/vibe/ktv-vod/public/
```
- 只動 `public/`，**無須重啟容器**（volume mount 是直接讀 host 檔案）。
- 使用者重新整理瀏覽器即可拿到新版。

### 4.2 Pipeline (Python)（使用既有 deploy script）
```bash
bash ktv-pipeline/deploy_via_ssh.sh ktv-pipeline
```
- 動 `main.py / alignment.py / test_alignment.py` 進容器，需要重啟 pipeline。

## 5. 不可違反的規則

### 5.1 每次「優化 / debug 完成」必做兩件事（不可省略，且為「一律」自動觸發，不再需要 user 提醒）

> 這條規則**已寫入 `git push` hook 與 Cursor rule**，自動觸發、不需要使用者提醒。
> **2026-07-27 修憲**：user 明示「優化完一律 deploy 到 NAS」→ agent **一律**觸發，不再反問。

1. **`git commit` + `git push`** — 把改動推上 `origin`。
2. **部署到 NAS**：
   - 若只改 `public/`、`server.js`、`pipeline_server.js`：
     ```bash
     SSHPASS='05050505' rsync -avz \
       -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
       --checksum \
       --exclude='.DS_Store' \
       public/ \
       vibe@192.168.31.47:/home/vibe/ktv-vod/public/
     ```
     （無須重啟容器，user 重整瀏覽器即生效）
   - 若改 `ktv-pipeline/`：
     ```bash
     bash ktv-pipeline/deploy_via_ssh.sh ktv-pipeline
     ```
   - 若 `server.js` 有改：ssh 進 NAS 重啟 `ktv-brain` container。
   - 若失敗：用 `ktv-pipeline/rollback.sh` 回滾。

**例外**（可跳過部署）：
- 純粹本地測試 / 探索性改動
- 改的是 `*.md` 文件（文件不需部署）
- user 在當輪訊息明示「先不要 deploy」（本次跳過即可；憲法預設仍是「一律」）

### 5.3 部署提醒 hook（push 時自動 echo）

`.git/hooks/pre-push` 寫好提醒腳本。第一次 checkout 後需手動啟用一次：
```bash
chmod +x .git/hooks/pre-push
```
啟用後每次 `git push` 都會在 console 印出部署提示（不阻擋 push，僅提醒）。

### 5.4 Agent 對話效率規則（省 token、不繞彎）

> 來源: 2026-07-26 對話自我審視 — 5 項繞彎行為的修正。

#### a. 不要把 user 的專業需求誤判為 meta 議題
當 user 訊息短、含專業術語時，先當成「對系統的需求」處理；
**不要**預設成「對 agent 行為的建議」，更不要立刻用 10 分制評分框架。

#### b. 不主動為「可能會有的問題」設計保險
只在 user **明確問**「怎麼辦」「如何處理」「怕⋯」時才設計保險邏輯。

#### c. 小於 5 步的工作不開 TodoWrite
直接做就好。TodoWrite 留給多檔案、多步驟、需追蹤狀態的場景。

#### d. AskQuestion 後直接執行
user 已在 AskQuestion 表達意圖並選項 → **不要再列 Todo 重述同樣的事**。
只有當 user 在文字裡沒明確意圖時才問。

#### e. 「自動化」明示後自動執行，不要反問
當 user 說「⋯自動⋯」「⋯不用提醒」「⋯納入系統⋯」，**直接做**。
不要問「要不要我幫你 push？」「要不要我幫你部署？」。

#### f. 寫完規則/設定後停下來等確認
新增憲法、cursor rule、hook 後，**只總結改了什麼檔案**，
**不要立刻示範執行**。

#### g. 完成報告的長度上限
- 改 1~3 個檔案：一行「完成」+ 改動清單即可。
- 改 4+ 個檔案或含架構變更：才用「總結」section，且不超過 5 行。
- **不開**「✅ 完成」「🎉 上線」「下次起自動生效」這種慶祝式標題。

#### h. token 密度
- 表格用於資料對照（NAS 設定、評分結果），不要用於「做了什麼」。
- 一行能說完的事不要用 bullet 列表。
- 程式碼引用優先用 code reference（startLine:endLine:path），不要貼整段。

#### i. 評估方案前，先掃「更優解」再給推薦（2026-07-27 修憲）
當 user 詢問方案選擇時，**先主動列舉至少 2~3 個可行方案（含更優或更新興的技術）並附評分**，再問 user 選哪個。
不要直接從「看起來最簡單」的單一方案下手；除非 user 已明示方向，否則一律給選擇題。
理由：避免將來 user 發現有更好的方案時，回頭質疑為何當初沒考慮。

#### j. 同樣評分時優先推「朋友不必額外裝東西」的方案（2026-07-27 修憲）
當 KTV 服務要對外網（朋友家）開放時，**同等評分下優先選不要求 user 朋友裝 App / VPN / Tailscale** 的方案（例如 Cloudflare Named Tunnel / Quick Tunnel 勝過 Tailscale Funnel）。

### 5.2 其他不可違反規則（TBD）

> 後續歸納：例如「不得在 main 直接 push」「不得繞過 rollback.sh」等。

### 5.5 部署前確認 + 容器更新（2026-07-27）

#### 部署前先截圖確認當前狀態
改任何 UI 相關功能（`public/`）後，**部署前先在瀏覽器截圖確認按鈕/元件確實可見**。看不見就別 deploy——視覺確認比 logic review 更快發現問題。

#### `ktv-brain` 容器現在已支援 rsync 熱更新
`docker-compose.yml` 已啟用 `./public:/app/public:ro`，rsync 到 host 後容器直接讀到，**無需 docker cp**：

```bash
SSHPASS='05050505' rsync -avz \
  -e 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 22' \
  --checksum --exclude='.DS_Store' \
  public/ vibe@192.168.31.47:/home/vibe/ktv-vod/public/
```