# 📜 卡拉OK 專案憲法

> 這份檔案是 Cursor Agent 與其他自動化工具的「單一事實來源（Single Source of Truth）」。
> 任何不能遺忘的基礎設施資訊、不可違反的部署規則，都記錄在這裡。
> **不要在對話中反覆詢問已記錄的內容。**

最後更新：2026-07-26（新增 §5.1 push + 部署規則, §5.4 對話效率規則）

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

### 5.1 每次「優化 / debug 完成」必做兩件事（不可省略）

> 這條規則**已寫入 `git push` hook 與 Cursor rule**，自動觸發、不需要使用者提醒。

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

### 5.2 其他不可違反規則（TBD）

> 後續歸納：例如「不得在 main 直接 push」「不得繞過 rollback.sh」等。