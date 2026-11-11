"""Sequential, resumable downloads from Hugging Face with aggregated progress."""

import shutil
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import requests

from . import library
from .log import logger
from .paths import MODELS_DIR
from .store import HF_URL, _headers

TERMINAL_VISIBLE_SEC = 10
CHUNK = 1024 * 1024


class DownloadManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._task: Optional[Dict[str, Any]] = None
        self._cancel = threading.Event()

    def busy(self) -> bool:
        with self._lock:
            return bool(self._task and self._task["status"] == "downloading")

    def start(
        self,
        repo_id: str,
        files: List[Dict[str, Any]],
        on_complete: Optional[Callable[[List[str]], None]] = None,
    ):
        """files: [{filename, local_name, size_bytes, role}] downloaded in order."""
        total = sum(int(f.get("size_bytes") or 0) for f in files)
        free = shutil.disk_usage(MODELS_DIR).free
        if total and free < total * 1.02:
            raise OSError("disk_space")
        with self._lock:
            if self._task and self._task["status"] == "downloading":
                raise RuntimeError("busy")
            self._cancel.clear()
            self._task = {
                "repo_id": repo_id,
                "status": "downloading",
                "files": [f["local_name"] for f in files],
                "current": files[0]["local_name"],
                "index": 1,
                "count": len(files),
                "total_bytes": total,
                "downloaded_bytes": 0,
                "percent": 0.0,
                "speed_bps": 0.0,
                "eta_sec": None,
                "error": None,
                "finished_at": 0.0,
            }
        threading.Thread(target=self._run, args=(repo_id, files, on_complete), daemon=True).start()

    def cancel(self):
        self._cancel.set()

    def status(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            task = self._task
            if not task:
                return None
            if task["status"] != "downloading" and time.time() - task["finished_at"] > TERMINAL_VISIBLE_SEC:
                self._task = None
                return None
            return dict(task)

    def _update(self, **values):
        with self._lock:
            if self._task:
                self._task.update(values)

    def _finish(self, status: str, error: Optional[str] = None):
        self._update(status=status, error=error, finished_at=time.time(), speed_bps=0.0, eta_sec=None)

    def _run(self, repo_id, files, on_complete):
        done_bytes = 0
        window = []
        try:
            for index, spec in enumerate(files, start=1):
                target = MODELS_DIR / spec["local_name"]
                self._update(current=spec["local_name"], index=index)
                if target.exists():
                    done_bytes += target.stat().st_size
                    continue
                done_bytes = self._fetch(repo_id, spec, target, done_bytes, window)
                if done_bytes < 0:
                    return
                library.set_meta(spec["local_name"], {"repo": repo_id, "source_file": spec["filename"], "role": spec.get("role", "model")})
            names = [f["local_name"] for f in files]
            projector = next((f["local_name"] for f in files if f.get("role") == "projector"), None)
            model = next((f["local_name"] for f in files if f.get("role") != "projector"), None)
            if model and projector:
                library.set_meta(model, {"projector": projector})
            self._update(percent=100.0)
            self._finish("completed")
            logger.info(f"Download complete: {', '.join(names)}")
            if on_complete:
                on_complete(names)
        except Exception as e:
            logger.error(f"Download failed: {e}")
            self._finish("failed", str(e))

    def _fetch(self, repo_id, spec, target, base_bytes, window, retry=True) -> int:
        url = f"{HF_URL}/{repo_id}/resolve/main/{spec['filename']}"
        part = target.with_name(target.name + ".part")
        resume_from = part.stat().st_size if part.exists() else 0
        headers = _headers()
        if resume_from:
            headers["Range"] = f"bytes={resume_from}-"
        logger.info(f"Downloading {spec['filename']} from {repo_id}" + (f" (resuming at {resume_from} bytes)" if resume_from else ""))
        with requests.get(url, headers=headers, stream=True, timeout=30, allow_redirects=True) as resp:
            if resp.status_code == 416 and retry:
                part.unlink(missing_ok=True)
                return self._fetch(repo_id, spec, target, base_bytes, window, retry=False)
            resp.raise_for_status()
            if resume_from and resp.status_code != 206:
                resume_from = 0
            expected = int(resp.headers.get("content-length", 0)) + resume_from
            with self._lock:
                if self._task and not self._task["total_bytes"] and expected:
                    self._task["total_bytes"] = base_bytes + expected
            mode = "ab" if resume_from else "wb"
            written = resume_from
            with open(part, mode) as f:
                for chunk in resp.iter_content(chunk_size=CHUNK):
                    if self._cancel.is_set():
                        logger.info("Download cancelled")
                        self._finish("cancelled")
                        return -1
                    if not chunk:
                        continue
                    f.write(chunk)
                    written += len(chunk)
                    now = time.time()
                    window.append((now, len(chunk)))
                    while window and now - window[0][0] > 4:
                        window.pop(0)
                    span = max(0.5, now - window[0][0]) if window else 1
                    speed = sum(n for _, n in window) / span
                    done = base_bytes + written
                    with self._lock:
                        if self._task:
                            total = self._task["total_bytes"] or (base_bytes + expected)
                            self._task.update(
                                downloaded_bytes=done,
                                percent=round(done * 100 / total, 1) if total else 0.0,
                                speed_bps=speed,
                                eta_sec=int((total - done) / speed) if speed > 0 and total else None,
                            )
        if expected and part.stat().st_size != expected:
            raise RuntimeError("incomplete_download")
        part.replace(target)
        return base_bytes + written


downloads = DownloadManager()
