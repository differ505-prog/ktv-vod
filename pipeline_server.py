"""
KTV Pipeline HTTP Server
把 ktv-pipeline/main.py 的 CLI 函式包成 HTTP API,
讓 Node 中控 (/api/process-youtube) 可以呼叫。

啟動:  python pipeline_server.py
預設 port: 5050
"""

import logging
import os
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

# 簡易任務狀態 (記憶體, 重啟就清空)
jobs = {}
jobs_lock = threading.Lock()


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
    """背景任務: 呼叫 ktv-pipeline 處理 YouTube URL"""
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
    return jsonify({
        "status": "ok",
        "demucs_available": True,
        "active_jobs": sum(1 for j in jobs.values() if j.get("status") == "running"),
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
        jobs[job_id] = {
            "job_id": job_id,
            "url": url,
            "title": body.get("title"),
            "artist": body.get("artist"),
            "model": body.get("model", "htdemucs"),
            "force_cpu": bool(body.get("force_cpu", False)),
            "created_at": time.time(),
            "status": "queued",
        }

    thread = threading.Thread(
        target=run_job,
        args=(
            job_id,
            url,
            body.get("title"),
            body.get("artist"),
            body.get("model", "htdemucs"),
            bool(body.get("force_cpu", False)),
        ),
        daemon=True,
    )
    thread.start()

    return jsonify({"success": True, "job_id": job_id, "status": "queued"}), 202


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
