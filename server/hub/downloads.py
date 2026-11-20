"""Sequential, resumable downloads from Hugging Face with aggregated progress."""

import shutil
import threading
import time
from typing import Any, Callable, Dict, List, Optional

import requests

from . import library
from .log import logger
from .paths import IMAGE_AUX_DIR, IMAGE_MODELS_DIR, LORAS_DIR, MODELS_DIR
from .store import HF_URL, _headers


def _dir_for_role(role: str):
    if role == "image":
        return IMAGE_MODELS_DIR, "image/"
    if role in ("image_aux", "vae", "clip_l", "clip_g", "t5xxl", "llm_encoder"):
        return IMAGE_AUX_DIR, "image_aux/"
    if role == "lora":
        return LORAS_DIR, "loras/"
    return MODELS_DIR, ""

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
                role = spec.get("role", "model")
                spec_repo = spec.get("repo_id") or repo_id
                base_dir, meta_prefix = _dir_for_role(role)
                base_dir.mkdir(parents=True, exist_ok=True)
                target = base_dir / spec["local_name"]
                self._update(current=spec["local_name"], index=index)
                meta_key = f"{meta_prefix}{spec['local_name']}" if meta_prefix else spec["local_name"]
                meta_payload: Dict[str, Any] = {
                    "repo": spec_repo,
                    "source_file": spec["filename"],
                    "role": role,
                }
                if role in ("vae", "clip_l", "clip_g", "t5xxl", "llm_encoder"):
                    meta_payload["aux_role"] = role
                if role == "lora" and spec.get("trigger_word"):
                    meta_payload["trigger_word"] = str(spec["trigger_word"]).strip()
                if "supports_refs" in spec:
                    meta_payload["supports_refs"] = bool(spec["supports_refs"])
                if target.exists():
                    done_bytes += target.stat().st_size
                    if role == "lora":
                        inspected = library.inspect_lora_header(target)
                        if inspected.get("base_arch"):
                            meta_payload.setdefault("base_arch", inspected["base_arch"])
                        if inspected.get("trigger_word") and not meta_payload.get("trigger_word"):
                            meta_payload["trigger_word"] = inspected["trigger_word"]
                    library.set_meta(meta_key, meta_payload)
                    continue
                done_bytes = self._fetch(spec_repo, spec, target, done_bytes, window)
                if done_bytes < 0:
                    return
                if role == "lora":
                    inspected = library.inspect_lora_header(target)
                    if inspected.get("base_arch"):
                        meta_payload.setdefault("base_arch", inspected["base_arch"])
                    if inspected.get("trigger_word") and not meta_payload.get("trigger_word"):
                        meta_payload["trigger_word"] = inspected["trigger_word"]
                library.set_meta(meta_key, meta_payload)
            names = [f["local_name"] for f in files]
            projector = next((f["local_name"] for f in files if f.get("role") == "projector"), None)
            model = next((f["local_name"] for f in files if f.get("role") == "model"), None)
            if model and projector:
                library.set_meta(model, {"projector": projector})
            image_spec = next((f for f in files if f.get("role") == "image"), None)
            if image_spec:
                image_main = image_spec["local_name"]
                companions: Dict[str, str] = {}
                for f in files:
                    r = f.get("role")
                    if r in ("vae", "clip_l", "clip_g", "t5xxl", "llm_encoder"):
                        companions[r] = f["local_name"]
                patch: Dict[str, Any] = {}
                if companions:
                    patch["companions"] = companions
                if "supports_refs" in image_spec:
                    patch["supports_refs"] = bool(image_spec["supports_refs"])
                if image_spec.get("family"):
                    patch["family"] = image_spec["family"]
                if patch:
                    library.set_meta(f"image/{image_main}", patch)
            self._update(percent=100.0)
            self._finish("completed")
            logger.info(f"Download complete: {', '.join(names)}")
            if on_complete:
                on_complete(names)
        except Exception as e:
            logger.error(f"Download failed: {e}")
            self._finish("failed", str(e))

    def _fetch(self, repo_id, spec, target, base_bytes, window, retry=True) -> int:
        url = spec.get("url") or f"{HF_URL}/{repo_id}/resolve/main/{spec['filename']}"
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
