import os
import uuid
import json
import threading
import shutil
from flask import (
    Flask, request, jsonify, send_file,
    render_template, Response, stream_with_context
)
from depixelate import depixelate_video

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".mp4", ".webm", ".avi", ".mov", ".mkv", ".flv", ".wmv"}

# job state: job_id -> {"status": str, "progress": int, "stage": str, "result": str|None, "error": str|None}
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def allowed_file(filename: str) -> bool:
    return os.path.splitext(filename.lower())[1] in ALLOWED_EXTENSIONS


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "영상 파일이 없습니다."}), 400

    f = request.files["video"]
    if not f.filename or not allowed_file(f.filename):
        return jsonify({"error": "지원하지 않는 파일 형식입니다. (mp4, webm, avi, mov, mkv)"}), 400

    job_id = str(uuid.uuid4())
    job_dir = os.path.join(UPLOAD_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)

    ext = os.path.splitext(f.filename)[1].lower()
    video_path = os.path.join(job_dir, f"input{ext}")
    f.save(video_path)

    # parse optional parameters
    try:
        window_pos = json.loads(request.form.get("window_pos", "null"))
        window_size = json.loads(request.form.get("window_size", "null"))
        cell_size = json.loads(request.form.get("cell_size", "null"))
    except (json.JSONDecodeError, TypeError):
        window_pos = window_size = cell_size = None

    if window_pos:
        window_pos = tuple(window_pos)
    if window_size:
        window_size = tuple(window_size)
    if cell_size:
        cell_size = tuple(cell_size)

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "stage": "대기 중...",
            "result": None,
            "error": None,
        }

    thread = threading.Thread(
        target=_run_job,
        args=(job_id, video_path, job_dir, window_pos, window_size, cell_size),
        daemon=True,
    )
    thread.start()

    return jsonify({"job_id": job_id})


def _run_job(job_id, video_path, job_dir, window_pos, window_size, cell_size):
    def progress(stage, pct):
        with _jobs_lock:
            _jobs[job_id]["stage"] = stage
            _jobs[job_id]["progress"] = pct
            _jobs[job_id]["status"] = "processing"

    with _jobs_lock:
        _jobs[job_id]["status"] = "processing"

    try:
        result_path = depixelate_video(
            video_path=video_path,
            work_dir=job_dir,
            window_pos=window_pos,
            window_size=window_size,
            cell_size=cell_size,
            progress_callback=progress,
        )
        with _jobs_lock:
            _jobs[job_id]["status"] = "done"
            _jobs[job_id]["progress"] = 100
            _jobs[job_id]["stage"] = "완료!"
            _jobs[job_id]["result"] = result_path
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id]["status"] = "error"
            _jobs[job_id]["error"] = str(e)


@app.route("/status/<job_id>")
def status(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "작업을 찾을 수 없습니다."}), 404
    return jsonify(job)


@app.route("/progress/<job_id>")
def progress_stream(job_id):
    """Server-Sent Events endpoint for real-time progress."""
    def generate():
        import time
        last_pct = -1
        while True:
            with _jobs_lock:
                job = _jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'error': '작업 없음'})}\n\n"
                break
            if job["progress"] != last_pct or job["status"] in ("done", "error"):
                last_pct = job["progress"]
                yield f"data: {json.dumps(job)}\n\n"
            if job["status"] in ("done", "error"):
                break
            time.sleep(0.5)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/download/<job_id>")
def download(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify({"error": "결과가 없습니다."}), 404
    result_path = job["result"]
    if not result_path or not os.path.exists(result_path):
        return jsonify({"error": "파일을 찾을 수 없습니다."}), 404
    return send_file(result_path, as_attachment=True, download_name="depixelated_result.png")


@app.route("/preview/<job_id>")
def preview(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify({"error": "결과가 없습니다."}), 404
    result_path = job["result"]
    if not result_path or not os.path.exists(result_path):
        return jsonify({"error": "파일을 찾을 수 없습니다."}), 404
    return send_file(result_path, mimetype="image/png")


@app.route("/cleanup/<job_id>", methods=["DELETE"])
def cleanup(job_id):
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
    if job:
        job_dir = os.path.join(UPLOAD_DIR, job_id)
        if os.path.exists(job_dir):
            shutil.rmtree(job_dir, ignore_errors=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
