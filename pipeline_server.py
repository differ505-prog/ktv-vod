"""
KTV Pipeline HTTP Server
把 ktv-pipeline/main.py 的 CLI 函式包成 HTTP API,
讓 Node 中控 (/api/process-youtube) 可以呼叫。

啟動:  python pipeline_server.py
預設 port: 5050
"""

import logging
import os
import queue
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

from flask import Flask, jsonify, request

# 匯入既有 pipeline 模組
from ktv_pipeline.main import process_ktv_video

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("pipeline_server")

app = Flask(__name__)
AUTH_TOKEN = os.environ.get("PIPELINE_API_TOKEN", "")
DATA_DIR = Path(os.environ.get("KTV_DATA_DIR", "/ktv-data"))
OUTPUT_DIR = DATA_DIR / "processed"
WORK_DIR = DATA_DIR / "work"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
WORK_DIR.mkdir(parents=True, exist_ok=True)

# ===== Pipeline Serializer =====
# 為什麼不用 ThreadPoolExecutor 直接平行跑:
#   - Stage 2 (Demucs) GPU/MPS 資源吃重,兩個 job 同時會搶資源拖慢總時間
#   - Stage 1 (yt-dlp) 同一 IP 短時間多次請求會被 YouTube 限流 (429)
# 解法: 單 worker thread + FIFO queue,跑完一首後再 stagger 數秒才跑下一首
# 配置: PIPELINE_STAGGER_SECONDS (預設 5 秒;設 0 表示立即接續)
STAGGER_SECONDS = float(os.environ.get("PIPELINE_STAGGER_SECONDS", "5"))

# 簡易任務狀態 (記憶體, 重啟就清空)
jobs = {}
jobs_lock = threading.Lock()

# Serializer queue: 進來依序排隊,worker thread 一次只跑一個
job_queue: "queue.Queue[str]" = queue.Queue()
_queue_worker_started = False
_queue_worker_lock = threading.Lock()


def _queue_worker():
    """
    單一 worker,從 queue 拉 job_id 依序處理。
    每個 job 跑完後 sleep STAGGER_SECONDS,讓 YouTube / GPU 喘口氣。
    """
    log.info("[queue] worker 啟動 (stagger=%.1fs)", STAGGER_SECONDS)
    first = True
    while True:
        try:
            job_id = job_queue.get()
        except Exception:  # pragma: no cover
            log.exception("[queue] worker 異常,2s 後重試")
            time.sleep(2)
            continue

        if not first:
            # 第一首不用等,後續每首中間留 stagger 秒給資源喘息
            log.info("[queue] stagger 等 %.1fs 再跑下一首", STAGGER_SECONDS)
            time.sleep(STAGGER_SECONDS)
        first = False

        try:
            run_job_for(job_id)
        except Exception:  # pragma: no cover
            log.exception("[queue] job %s 未預期錯誤", job_id)
        finally:
            job_queue.task_done()


def _ensure_worker():
    global _queue_worker_started
    with _queue_worker_lock:
        if not _queue_worker_started:
            t = threading.Thread(target=_queue_worker, name="pipeline-worker", daemon=True)
            t.start()
            _queue_worker_started = True


def run_job_for(job_id: str) -> None:
    """Worker 內部呼叫: 真正執行 pipeline,更新 job 狀態。"""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            log.warning("[queue] job %s 不存在,跳過", job_id)
            return
        job["status"] = "running"
        job["started_at"] = time.time()
        params = {
            "url": job["url"],
            "title": job.get("title"),
            "artist": job.get("artist"),
            "model": job.get("model", "htdemucs"),
            "force_cpu": job.get("force_cpu", False),
        }

    log.info("[queue] job %s 開始: url=%s title=%s", job_id, params["url"], params["title"])

    try:
        output_path = process_ktv_video(
            youtube_url=params["url"],
            output_dir=str(OUTPUT_DIR),
            force_cpu=params["force_cpu"],
            verbose=False,
        )
        with jobs_lock:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["finished_at"] = time.time()
            jobs[job_id]["output_path"] = output_path
            jobs[job_id]["filename"] = Path(output_path).name
        log.info("[queue] job %s 完成: %s", job_id, output_path)
    except Exception as exc:  # noqa: BLE001
        log.exception("[queue] job %s 失敗", job_id)
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["finished_at"] = time.time()
            jobs[job_id]["error"] = str(exc)


def require_auth():
    if not AUTH_TOKEN:
        return  # 沒設 token 就當開放 (本機部署場景)
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return jsonify({"error": "missing bearer token"}), 401
    token = header.split(" ", 1)[1].strip()
    if not secrets.compare_digest(token, AUTH_TOKEN):
        return jsonify({"error": "invalid token"}), 401
    return None


def run_job(job_id: str, url: str, title: Optional[str], artist: Optional[str],
            model: str, force_cpu: bool) -> None:
    """背景任務: 呼叫 ktv-pipeline 處理 YouTube URL (向後相容舊版,直接跑,不排隊)"""
    with jobs_lock:
        jobs[job_id]["status"] = "running"
        jobs[job_id]["started_at"] = time.time()

    try:
        # process_ktv_video(youtube_url, output_dir, force_cpu, verbose)
        # 標題/模型在現有 CLI 主函式裡由 yt-dlp 自動抓取, 這裡先 logs 留底
        log.info("job %s 開始: url=%s title=%s artist=%s", job_id, url, title, artist)

        output_path = process_ktv_video(
            youtube_url=url,
            output_dir=str(OUTPUT_DIR),
            force_cpu=force_cpu,
            verbose=False,
        )

        with jobs_lock:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["finished_at"] = time.time()
            jobs[job_id]["output_path"] = output_path
            jobs[job_id]["filename"] = Path(output_path).name
    except Exception as exc:  # noqa: BLE001
        log.exception("job %s 失敗", job_id)
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["finished_at"] = time.time()
            jobs[job_id]["error"] = str(exc)


@app.route("/health", methods=["GET"])
def health():
    with jobs_lock:
        running = sum(1 for j in jobs.values() if j.get("status") == "running")
        queued = sum(1 for j in jobs.values() if j.get("status") == "queued")
    return jsonify({
        "status": "ok",
        "demucs_available": True,
        "active_jobs": running,
        "queued_jobs": queued,
        "queue_depth": job_queue.qsize(),
        "stagger_seconds": STAGGER_SECONDS,
    })


@app.route("/process", methods=["POST"])
def process():
    auth_err = require_auth()
    if auth_err:
        return auth_err

    body = request.get_json(silent=True) or {}
    url = body.get("url")
    if not url:
        return jsonify({"error": "missing url"}), 400

    job_id = secrets.token_hex(8)
    with jobs_lock:
        # 同 URL 已在 queue 內的去重 (避免重複點歌塞爆 worker)
        for existing in jobs.values():
            if existing.get("url") == url and existing.get("status") in ("queued", "running"):
                return jsonify({
                    "success": False,
                    "error": "duplicate",
                    "existing_job_id": existing["job_id"],
                    "message": f"此 URL 已在 queue 中 (job {existing['job_id']})",
                }), 409

        # 估算 queue 內還在等的位置 (已 queued 但還沒 running)
        pending_ahead = sum(
            1 for j in jobs.values()
            if j.get("status") == "queued"
        )

        jobs[job_id] = {
            "job_id": job_id,
            "url": url,
            "title": body.get("title"),
            "artist": body.get("artist"),
            "model": body.get("model", "htdemucs"),
            "force_cpu": bool(body.get("force_cpu", False)),
            "created_at": time.time(),
            "status": "queued",
            "queue_position": pending_ahead + 1,
        }

    # 進 serializer queue (單 worker thread 依序跑,stagger 喘息)
    _ensure_worker()
    job_queue.put(job_id)

    log.info("[queue] job %s 進 queue (位置 #%d): %s", job_id, pending_ahead + 1, url)

    return jsonify({
        "success": True,
        "job_id": job_id,
        "status": "queued",
        "queue_position": pending_ahead + 1,
    }), 202


@app.route("/jobs/<job_id>", methods=["GET"])
def job_status(job_id: str):
    auth_err = require_auth()
    if auth_err:
        return auth_err

    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


@app.route("/songs", methods=["GET"])
def list_songs():
    """列出已處理完成的影片 (給 Node 中控同步用)"""
    auth_err = require_auth()
    if auth_err:
        return auth_err

    files = []
    for p in sorted(OUTPUT_DIR.glob("*_ktv.mp4")):
        stat = p.stat()
        files.append({
            "filename": p.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
        })
    return jsonify({"success": True, "videos": files})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    log.info("Pipeline server 啟動於 0.0.0.0:%d", port)
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
