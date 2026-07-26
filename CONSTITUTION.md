# 📜 卡拉OK 專案憲法

> 這份檔案是 Cursor Agent 與其他自動化工具的「單一事實來源（Single Source of Truth）」。
> 任何不能遺忘的基礎設施資訊、不可違反的部署規則，都記錄在這裡。
> **不要在對話中反覆詢問已記錄的內容。**

最後更新：2026-07-26

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

## 5. 不可違反的規則（TBD）

> 後續歸納：例如「不得在 main 直接 push」「不得繞過 rollback.sh」等。