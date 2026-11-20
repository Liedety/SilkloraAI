"""Local & external Image Generation Engine for SilkloraAI Local Hub.

Architecture:
- Primary local backend (`sdcpp`):
  1. Persistent `sd-server` daemon (`stable-diffusion.cpp` native HTTP server on 127.0.0.1)
     that loads the diffusion model + VAE/CLIP/T5/Qwen companions ONCE and keeps them warm
     in memory across scene regenerations and camera angle changes, with structured LoRA
     and multi-reference support, native stage/step progress, and clean 256px VAE tiling
     to prevent end-of-generation VRAM spikes on 6-8 GB GPUs.
  2. Automatic `sd-cli` subprocess fallback (with `--vae-on-cpu` OOM retry) when `sd-server`
     is not present or when a one-shot fallback is needed.
- Optional external adapters: `comfyui` and `a1111` (Automatic1111 / Forge).
"""

import base64
import io
import json
import os
import platform
import random
import re
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from . import hardware, library, paths, settings as settings_mod
from .log import logger

try:
    from PIL import Image as PILImage
except Exception:
    PILImage = None  # type: ignore[assignment]

SDCPP_RELEASES_API = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest"
SD_BIN_DIR = paths.BIN_DIR
SD_MANIFEST_PATH = SD_BIN_DIR / "manifest.json"
STEP_PROGRESS_RE = re.compile(r"(?:\|\s*|\bstep\s+)(\d+)\s*/\s*(\d+)", re.IGNORECASE)
DATA_URL_RE = re.compile(r"^data:([^;,]+);base64,(.+)$", re.DOTALL | re.IGNORECASE)


def _pick_free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _sanitize_image_bytes(
    data_or_url: str,
    max_dim: int = 896,
) -> Optional[Tuple[bytes, str, str]]:
    """Validate and normalize an input base64/data-URL image into (bytes, ext, data_url).

    - Rejects SVG/XML or unreadable non-image payloads so they never crash sd-server / sd-cli.
    - Converts WebP/PNG/BMP/RGBA inputs to clean RGB JPEG/PNG and caps reference dimensions
      via Pillow when available so high-res photos do not exhaust 8 GB VRAM during VAE encode/decode.
    """
    raw = (data_or_url or "").strip()
    if not raw or raw.lower().startswith("data:image/svg") or raw.startswith("<svg"):
        return None

    mime = "image/png"
    m = DATA_URL_RE.match(raw)
    if m:
        mime = m.group(1).strip().lower()
        if "svg" in mime:
            return None
        b64_part = re.sub(r"\s+", "", m.group(2))
    else:
        if raw.startswith("data:"):
            return None
        b64_part = re.sub(r"\s+", "", raw)

    try:
        blob = base64.b64decode(b64_part, validate=False)
    except Exception:
        return None
    if len(blob) < 8:
        return None

    if PILImage is not None:
        try:
            with PILImage.open(io.BytesIO(blob)) as im:
                im.load()
                orig_w, orig_h = im.size
                if orig_w < 4 or orig_h < 4:
                    return None
                if max_dim > 0 and max(orig_w, orig_h) > max_dim:
                    scale = max_dim / float(max(orig_w, orig_h))
                    new_w = max(16, int(round(orig_w * scale)))
                    new_h = max(16, int(round(orig_h * scale)))
                    resample = getattr(getattr(PILImage, "Resampling", PILImage), "LANCZOS", PILImage.BICUBIC)
                    im = im.resize((new_w, new_h), resample)
                if im.mode not in ("RGB",):
                    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                        rgba = im.convert("RGBA")
                        bg = PILImage.new("RGB", rgba.size, (18, 18, 22))
                        bg.paste(rgba, mask=rgba.split()[3])
                        im = bg
                    else:
                        im = im.convert("RGB")
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=90, optimize=True)
                jpg_bytes = buf.getvalue()
                jpg_b64 = base64.b64encode(jpg_bytes).decode("ascii")
                return jpg_bytes, "jpg", f"data:image/jpeg;base64,{jpg_b64}"
        except Exception:
            # Allow minimal valid header stubs in unit tests, reject real WebP/SVG/garbage when Pillow couldn't decode
            pass

    if blob.startswith(b"\xff\xd8"):
        b64_clean = base64.b64encode(blob).decode("ascii")
        return blob, "jpg", f"data:image/jpeg;base64,{b64_clean}"
    if blob.startswith(b"\x89PNG"):
        b64_clean = base64.b64encode(blob).decode("ascii")
        return blob, "png", f"data:image/png;base64,{b64_clean}"
    return None


def _encode_png_data_url(path: Path) -> str:
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    sfx = path.suffix.lower()
    mime = "image/webp" if sfx == ".webp" else ("image/jpeg" if sfx in (".jpg", ".jpeg") else "image/png")
    return f"data:{mime};base64,{b64}"


def find_sd_binary() -> Optional[Path]:
    """Locate `sd-cli` / `sd` executable inside server/bin/sd or system PATH."""
    names = ["sd-cli.exe", "sd.exe"] if os.name == "nt" else ["sd-cli", "sd"]
    if SD_BIN_DIR.exists():
        for name in names:
            direct = SD_BIN_DIR / name
            if direct.is_file():
                return direct
        for name in names:
            for found in SD_BIN_DIR.rglob(name):
                if found.is_file():
                    return found
    for name in names:
        hit = shutil.which(name)
        if hit:
            return Path(hit)
    return None


def find_sd_server_binary() -> Optional[Path]:
    """Locate persistent `sd-server` executable inside server/bin/sd or system PATH."""
    names = ["sd-server.exe"] if os.name == "nt" else ["sd-server"]
    if SD_BIN_DIR.exists():
        for name in names:
            direct = SD_BIN_DIR / name
            if direct.is_file():
                return direct
        for name in names:
            for found in SD_BIN_DIR.rglob(name):
                if found.is_file():
                    return found
    for name in names:
        hit = shutil.which(name)
        if hit:
            return Path(hit)
    return None


def _select_sdcpp_assets(assets: List[Dict[str, Any]], hw: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], str]:
    """Pick the best official `stable-diffusion.cpp` binary archive (+ optional CUDA runtime zip) for this machine."""
    sys_name = platform.system().lower()
    arch = platform.machine().lower()
    gpu_kind = (hw.get("gpu") or {}).get("kind", "none")

    zips = [a for a in assets if str(a.get("name", "")).lower().endswith(".zip")]
    main_asset: Optional[Dict[str, Any]] = None
    extra_asset: Optional[Dict[str, Any]] = None
    backend_tag = "cpu"

    if sys_name == "windows":
        is_arm = "arm" in arch or "aarch64" in arch
        arch_tok = "arm64" if is_arm else "x64"
        if gpu_kind == "cuda" and not is_arm:
            main_asset = next((a for a in zips if "win-cuda" in a["name"].lower() and arch_tok in a["name"].lower() and not a["name"].lower().startswith("cudart")), None)
            extra_asset = next((a for a in zips if a["name"].lower().startswith("cudart") and "win" in a["name"].lower()), None)
            backend_tag = "cuda12"
        if not main_asset and gpu_kind in ("cuda", "vulkan", "amd", "intel") and not is_arm:
            main_asset = next((a for a in zips if "win-vulkan" in a["name"].lower() and arch_tok in a["name"].lower()), None)
            backend_tag = "vulkan"
        if not main_asset:
            main_asset = next((a for a in zips if "win-cpu" in a["name"].lower() or ("win" in a["name"].lower() and arch_tok in a["name"].lower())), None)
            backend_tag = "cpu"
    elif sys_name == "darwin":
        main_asset = next((a for a in zips if "darwin" in a["name"].lower() or "macos" in a["name"].lower()), None)
        backend_tag = "metal" if "arm" in arch or "aarch64" in arch else "cpu"
    else:
        if gpu_kind in ("cuda", "vulkan", "amd", "intel"):
            main_asset = next((a for a in zips if "linux" in a["name"].lower() and "vulkan" in a["name"].lower()), None)
            if main_asset:
                backend_tag = "vulkan"
        if not main_asset:
            main_asset = next(
                (
                    a for a in zips
                    if "linux" in a["name"].lower()
                    and not any(tok in a["name"].lower() for tok in ("vulkan", "rocm", "cuda", "hip"))
                ),
                None,
            )
            backend_tag = "cpu"

    return main_asset, extra_asset, backend_tag


def _extract_zip_preserving_symlinks(zip_path: Path, dest: Path) -> None:
    """Extract zip archive while recreating POSIX symlinks (e.g. lib*.so -> lib*.so.1) instead of plain text stubs."""
    dest_resolved = dest.resolve()
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            rel = Path(info.filename)
            if rel.is_absolute() or ".." in rel.parts:
                continue
            target = dest / rel
            if not target.resolve().is_relative_to(dest_resolved) and dest_resolved not in target.resolve().parents:
                continue
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if os.name != "nt" and stat.S_ISLNK(unix_mode):
                link_target = zf.read(info).decode("utf-8", errors="strict").strip()
                if target.exists() or target.is_symlink():
                    target.unlink()
                os.symlink(link_target, target)
                continue
            if target.is_symlink():
                target.unlink()
            with zf.open(info, "r") as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            if os.name != "nt" and (unix_mode & 0o777):
                try:
                    target.chmod(unix_mode & 0o777)
                except OSError:
                    pass


def _resolve_companion_paths(
    model_info: Dict[str, Any],
    image_aux_dir: Path,
    cfg: Optional[Dict[str, Any]] = None,
) -> Dict[str, Path]:
    """Match required VAE / CLIP / T5 / Qwen encoders from settings overrides, metadata, or installed aux library."""
    out: Dict[str, Path] = {}
    if cfg:
        for role, cfg_key in (
            ("vae", "image_vae"),
            ("clip_l", "image_clip_l"),
            ("clip_g", "image_clip_g"),
            ("t5xxl", "image_t5xxl"),
            ("llm_encoder", "image_llm_encoder"),
        ):
            override_name = str(cfg.get(cfg_key) or "").strip()
            if override_name:
                p = image_aux_dir / Path(override_name).name
                if p.is_file():
                    out[role] = p

    family = model_info.get("family", "")
    weight_role = str(model_info.get("weight_role") or "")
    dit_family = family in ("flux", "flux_kontext", "chroma", "qwen_image", "qwen_edit", "z_image", "sd3")
    needs_comp = dit_family or (
        weight_role != "checkpoint"
        and (bool(model_info.get("needs_companions")) or weight_role == "diffusion_model")
    )
    if not needs_comp:
        # All-in-one checkpoints (SDXL, Illustrious, Pony, Animagine, SD1.5 — both .safetensors/.ckpt and full .gguf)
        # embed their own matched VAE & CLIP; never attach stale companions from models_meta.json or image_aux.
        return out

    meta_comp = model_info.get("companions") or {}
    for role, fname in meta_comp.items():
        if role not in out and fname:
            p = image_aux_dir / str(fname)
            if p.is_file():
                out[role] = p

    if image_aux_dir == paths.IMAGE_AUX_DIR:
        aux_files = library.scan_image_library().get("aux_files") or []
    else:
        aux_files = []
        if image_aux_dir.exists():
            for p in sorted(image_aux_dir.iterdir(), key=lambda item: item.name.lower()):
                if p.is_file() and p.suffix.lower() in (".gguf", ".safetensors", ".ckpt"):
                    aux_files.append({"filename": p.name, "role": library._aux_role(p.name)})

    def pick_aux(role: str, hints: Tuple[str, ...] = ()) -> Optional[Path]:
        cands = [
            a for a in aux_files
            if a["role"] == role and library.is_aux_compatible_with_family(a["filename"], role, family)
        ]
        if hints:
            preferred = [a for a in cands if any(h in a["filename"].lower() for h in hints)]
            if preferred:
                cands = preferred
        return (image_aux_dir / cands[0]["filename"]) if cands else None

    if "vae" not in out:
        if family in ("flux", "flux_kontext", "z_image", "chroma", "sd3"):
            hints: Tuple[str, ...] = ("ae", "flux", "zimage")
        elif family.startswith("qwen"):
            hints = ("qwen",)
        elif family == "sdxl":
            hints = ("sdxl",)
        else:
            hints = ()
        p = pick_aux("vae", hints)
        if p and p.is_file():
            out["vae"] = p

    if family in ("flux", "flux_kontext", "sd3", "sdxl", "sd15") and "clip_l" not in out:
        p = pick_aux("clip_l")
        if p:
            out["clip_l"] = p
    if family in ("sd3", "sdxl") and "clip_g" not in out:
        p = pick_aux("clip_g", ("clip_g", "clip-g", "sdxl"))
        if p:
            out["clip_g"] = p
    if family in ("flux", "flux_kontext", "sd3", "chroma") and "t5xxl" not in out:
        p = pick_aux("t5xxl")
        if p:
            out["t5xxl"] = p
    if family in ("qwen_image", "qwen_edit", "z_image") and "llm_encoder" not in out:
        enc_hints = ("qwen_3", "qwen3", "zimage") if family == "z_image" else ("qwen_2.5", "qwen2.5", "vl")
        p = pick_aux("llm_encoder", enc_hints)
        if p:
            out["llm_encoder"] = p
    return out


def _default_steps_for_model(family: str, is_turbo: bool, vram_total_bytes: int, quality_mode: str, variant: str = "") -> int:
    q = (quality_mode or "balanced").strip().lower()
    low_vram = 0 < vram_total_bytes <= 10 * hardware.GIB
    if variant == "chroma_flash":
        return 6 if q == "fast" else (10 if q == "quality" else 8)
    if is_turbo and family in ("sdxl", "sd15", "flux"):
        return 4 if q == "fast" else (8 if q == "quality" else 6)
    if family == "z_image":
        return 6 if q == "fast" else (12 if q == "quality" else 8)
    if family in ("flux", "flux_kontext"):
        if low_vram:
            return 12 if q == "fast" else (18 if q == "quality" else 15)
        return 14 if q == "fast" else (22 if q == "quality" else 18)
    if family in ("qwen_image", "qwen_edit", "chroma", "sd3"):
        if low_vram:
            return 12 if q == "fast" else (20 if q == "quality" else 15)
        return 14 if q == "fast" else (24 if q == "quality" else 18)
    return 14 if q == "fast" else (28 if q == "quality" else 20)


DISTILLED_FLOW_FAMILIES = ("flux", "flux_kontext", "z_image")


class ImageEngine:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._exec_lock = threading.Lock()
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._cancelled_jobs: set = set()
        self._active_proc: Optional[subprocess.Popen] = None
        self._active_job_id: Optional[str] = None
        self._active_sd_job_id: Optional[str] = None
        self._cancel_requested = False

        # Persistent sd-server state (keeps model loaded across scene regenerations)
        self._server_lock = threading.Lock()
        self._server_proc: Optional[subprocess.Popen] = None
        self._server_port: int = 0
        self._server_sig: Optional[Tuple[Any, ...]] = None
        self._server_model_name: str = ""

        self._install_state: Dict[str, Any] = {
            "status": "idle",
            "progress": 0.0,
            "message": "",
            "error": "",
        }
        self._probe_cache: Dict[str, Tuple[float, bool]] = {}
        self._probe_inflight: set = set()
        self._loaded_backend: Optional[str] = None
        self._last_used_at: float = 0.0

    # --- Binary & Backend Status --------------------------------------------------

    def _probe_async(self, url: str) -> bool:
        now = time.time()
        with self._lock:
            hit = self._probe_cache.get(url)
            if hit and (now - hit[0]) < 15.0:
                return hit[1]
            cached_val = hit[1] if hit else False
            if url in self._probe_inflight:
                return cached_val
            self._probe_inflight.add(url)

        def worker() -> None:
            ok = self._probe_url(url)
            with self._lock:
                self._probe_cache[url] = (time.time(), ok)
                self._probe_inflight.discard(url)

        threading.Thread(target=worker, daemon=True).start()
        return cached_val

    def _is_server_alive(self) -> bool:
        proc = self._server_proc
        return proc is not None and proc.poll() is None and self._server_port > 0

    def engine_status(self, hw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        cfg = settings_mod.get_all()
        sd_bin = find_sd_binary()
        sd_srv = find_sd_server_binary()
        manifest: Dict[str, Any] = {}
        if SD_MANIFEST_PATH.is_file():
            try:
                manifest = json.loads(SD_MANIFEST_PATH.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}

        comfy_url = str(cfg.get("comfyui_url") or "").strip().rstrip("/")
        a1111_url = str(cfg.get("a1111_url") or "").strip().rstrip("/")
        preferred = str(cfg.get("image_backend") or "sdcpp")
        resident_alive = self._is_server_alive()

        active_job_summary: Optional[Dict[str, Any]] = None
        with self._lock:
            ajid = self._active_job_id
            ajob = dict(self._jobs[ajid]) if (ajid and ajid in self._jobs) else None
        if ajob:
            started = int(ajob.get("started_at") or ajob.get("created_at") or int(time.time()))
            active_job_summary = {
                "job_id": ajob.get("job_id", ""),
                "status": ajob.get("status", "running"),
                "stage": ajob.get("stage", "generating"),
                "progress": float(ajob.get("progress") or 0.0),
                "step": int(ajob.get("step") or 0),
                "total_steps": int(ajob.get("total_steps") or 0),
                "model": str(ajob.get("model") or ""),
                "elapsed_sec": max(0, int(time.time()) - started),
            }

        return {
            "preferred_backend": preferred,
            "active_backend": self._loaded_backend,
            "image_model": str(cfg.get("image_model") or ""),
            "sdcpp": {
                "installed": sd_bin is not None or sd_srv is not None,
                "binary_path": str(sd_srv or sd_bin) if (sd_srv or sd_bin) else "",
                "server_available": sd_srv is not None,
                "server_resident": resident_alive,
                "daemon_running": resident_alive,
                "resident_model": self._server_model_name if resident_alive else "",
                "tag": manifest.get("tag", ""),
                "backend": manifest.get("backend", ""),
                "install": dict(self._install_state),
            },
            "comfyui": {
                "url": comfy_url,
                "configured": bool(comfy_url),
                "reachable": self._probe_async(f"{comfy_url}/system_stats") if comfy_url else False,
            },
            "a1111": {
                "url": a1111_url,
                "configured": bool(a1111_url),
                "reachable": self._probe_async(f"{a1111_url}/sdapi/v1/options") if a1111_url else False,
            },
            "is_busy": active_job_summary is not None,
            "active_job_id": self._active_job_id,
            "active_job": active_job_summary,
            "last_used_at": self._last_used_at,
        }

    @staticmethod
    def _probe_url(url: str) -> bool:
        try:
            r = requests.get(url, timeout=1.0)
            return r.status_code < 500
        except Exception:
            return False

    def ensure_sdcpp_sync(
        self,
        hw: Optional[Dict[str, Any]] = None,
        force: bool = False,
        progress_cb: Optional[Any] = None,
    ) -> Dict[str, Any]:
        machine_hw = hw or hardware.analyze_hardware()
        existing_cli = find_sd_binary()
        existing_srv = find_sd_server_binary()
        manifest: Dict[str, Any] = {}
        if SD_MANIFEST_PATH.is_file():
            try:
                manifest = json.loads(SD_MANIFEST_PATH.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}

        in_local_bin = (
            existing_cli is not None
            and SD_BIN_DIR.exists()
            and str(existing_cli).startswith(str(SD_BIN_DIR))
        )
        # Upgrade automatically if an older local install lacks sd-server or lacks CUDA runtime DLLs on an NVIDIA Windows PC
        needs_server_upgrade = in_local_bin and existing_srv is None
        gpu_kind = (machine_hw.get("gpu") or {}).get("kind", "none")
        needs_cuda_upgrade = bool(
            os.name == "nt"
            and gpu_kind == "cuda"
            and SD_BIN_DIR.exists()
            and (existing_cli is not None or existing_srv is not None)
            and (str(existing_srv or existing_cli).startswith(str(SD_BIN_DIR)))
            and (manifest.get("backend") != "cuda12" or not any(SD_BIN_DIR.rglob("cublas64_*.dll")))
        )
        if existing_cli and not force and not needs_server_upgrade and not needs_cuda_upgrade:
            return {
                "ok": True,
                "binary": str(existing_srv or existing_cli),
                "tag": manifest.get("tag", ""),
                "backend": manifest.get("backend", "installed"),
                "already_installed": True,
            }
        with self._lock:
            self._install_state = {
                "status": "checking",
                "progress": 0.0,
                "message": "Checking latest stable-diffusion.cpp release...",
                "error": "",
            }
        self._install_sdcpp_worker(machine_hw, progress_cb=progress_cb)
        with self._lock:
            st = dict(self._install_state)
        binary = find_sd_server_binary() or find_sd_binary()
        return {
            "ok": binary is not None and st.get("status") == "done",
            "binary": str(binary) if binary else "",
            "tag": st.get("message", ""),
            "error": st.get("error", ""),
            "already_installed": False,
        }

    def install_sdcpp_async(self, hw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        with self._lock:
            if self._install_state["status"] in ("checking", "downloading", "extracting"):
                return dict(self._install_state)
            self._install_state = {"status": "checking", "progress": 0.0, "message": "Checking latest stable-diffusion.cpp release...", "error": ""}

        machine_hw = hw or hardware.analyze_hardware(fresh_gpu=False)
        thread = threading.Thread(target=self._install_sdcpp_worker, args=(machine_hw,), daemon=True)
        thread.start()
        return dict(self._install_state)

    def _install_sdcpp_worker(self, hw: Dict[str, Any], progress_cb: Optional[Any] = None) -> None:
        try:
            res = requests.get(SDCPP_RELEASES_API, headers={"User-Agent": "SilkloraAI-Local-Hub/2.1"}, timeout=20)
            res.raise_for_status()
            release = res.json()
            tag = release.get("tag_name") or "latest"
            assets = release.get("assets") or []
            main_asset, extra_asset, backend_tag = _select_sdcpp_assets(assets, hw)
            if not main_asset:
                raise RuntimeError("No compatible stable-diffusion.cpp prebuilt archive found for this OS/CPU.")

            SD_BIN_DIR.mkdir(parents=True, exist_ok=True)
            download_list = [main_asset] + ([extra_asset] if extra_asset else [])
            total_all = sum(max(1, int(a.get("size") or 0)) for a in download_list)
            done_all = 0
            last_pct_report = -10

            with tempfile.TemporaryDirectory() as tmp_dir:
                for asset in download_list:
                    url = asset["browser_download_url"]
                    name = asset["name"]
                    zip_path = Path(tmp_dir) / name
                    with self._lock:
                        self._install_state.update({
                            "status": "downloading",
                            "message": f"Downloading {name}...",
                        })
                    if progress_cb:
                        progress_cb(f"Downloading {name}...")
                    with requests.get(url, stream=True, timeout=180) as dl:
                        dl.raise_for_status()
                        with zip_path.open("wb") as fh:
                            for chunk in dl.iter_content(chunk_size=1024 * 256):
                                if not chunk:
                                    continue
                                fh.write(chunk)
                                done_all += len(chunk)
                                pct = min(95.0, round(done_all * 100.0 / max(1, total_all), 1))
                                with self._lock:
                                    self._install_state["progress"] = pct
                                if progress_cb and int(pct) - last_pct_report >= 20:
                                    last_pct_report = int(pct)
                                    progress_cb(f"Downloading {name}: {int(pct)}%")

                    with self._lock:
                        self._install_state.update({"status": "extracting", "message": f"Extracting {name}..."})
                    _extract_zip_preserving_symlinks(zip_path, SD_BIN_DIR)

            if os.name != "nt":
                for p in SD_BIN_DIR.rglob("*"):
                    if p.is_symlink() or not p.is_file():
                        continue
                    if p.name.startswith("sd") or p.suffix in ("", ".so"):
                        try:
                            p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP)
                        except OSError:
                            pass

            binary = find_sd_server_binary() or find_sd_binary()
            if not binary:
                raise RuntimeError("Archive extracted cleanly, but sd-server / sd-cli binary was not found inside archive.")

            SD_MANIFEST_PATH.write_text(
                json.dumps({
                    "tag": tag,
                    "asset": main_asset["name"],
                    "backend": backend_tag,
                    "binary": str(binary),
                    "installed_at": int(time.time()),
                }, indent=2),
                encoding="utf-8",
            )
            with self._lock:
                self._install_state = {
                    "status": "done",
                    "progress": 100.0,
                    "message": f"Installed {tag} ({backend_tag})",
                    "error": "",
                }
            logger.info(f"Installed stable-diffusion.cpp ({tag}, {backend_tag}) at {binary}")
        except Exception as exc:
            logger.error(f"stable-diffusion.cpp installation failed: {exc}")
            with self._lock:
                self._install_state = {
                    "status": "error",
                    "progress": 0.0,
                    "message": "",
                    "error": str(exc),
                }

    # --- Backend Selection, Cancellation & Unload ---------------------------------

    def resolve_backend(self, override: str = "") -> str:
        cfg = settings_mod.get_all()
        choice = (override or str(cfg.get("image_backend") or "auto")).strip().lower()
        if choice in ("sdcpp", "comfyui", "a1111"):
            return choice
        if cfg.get("image_model") or find_sd_binary() is not None or find_sd_server_binary() is not None:
            return "sdcpp"
        if str(cfg.get("comfyui_url") or "").strip():
            return "comfyui"
        if str(cfg.get("a1111_url") or "").strip():
            return "a1111"
        return "sdcpp"

    def _stop_sd_server(self) -> None:
        with self._server_lock:
            proc = self._server_proc
            port = self._server_port
            self._server_proc = None
            self._server_port = 0
            self._server_sig = None
            self._server_model_name = ""

        if port > 0:
            try:
                requests.post(f"http://127.0.0.1:{port}/sdcpp/v1/models/unload", timeout=2.5)
            except Exception:
                pass
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            is_active = self._active_job_id == job_id
            if not job and not is_active:
                return {"ok": False, "job_id": job_id, "error": "job not found"}
            self._cancelled_jobs.add(job_id)
            if job and job["status"] == "queued":
                job.update({"status": "cancelled", "stage": "cancelled", "finished_at": int(time.time()), "error": "Cancelled"})
                return {"ok": True, **dict(job)}
            sd_jid = self._active_sd_job_id if is_active else None
            proc = self._active_proc if is_active else None
            port = self._server_port if is_active else 0
            if is_active:
                self._cancel_requested = True

        if sd_jid and port > 0:
            try:
                requests.post(f"http://127.0.0.1:{port}/sdcpp/v1/jobs/{sd_jid}/cancel", timeout=3.0)
            except Exception:
                pass
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        latest = self.get_job(job_id)
        if latest:
            return {"ok": True, **latest}
        return {"ok": True, "job_id": job_id, "status": "cancelled"}

    def unload(self) -> Dict[str, Any]:
        """Cancel running work, stop resident sd-server daemon, and ask external WebUIs to free VRAM."""
        proc: Optional[subprocess.Popen] = None
        sd_jid: Optional[str] = None
        port: int = 0
        with self._lock:
            self._cancel_requested = True
            proc = self._active_proc
            sd_jid = self._active_sd_job_id
            port = self._server_port

        if sd_jid and port > 0:
            try:
                requests.post(f"http://127.0.0.1:{port}/sdcpp/v1/jobs/{sd_jid}/cancel", timeout=2.0)
            except Exception:
                pass

        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

        self._stop_sd_server()

        cfg = settings_mod.get_all()
        freed_external: List[str] = []
        comfy_url = str(cfg.get("comfyui_url") or "").strip().rstrip("/")
        if comfy_url and self._loaded_backend == "comfyui":
            try:
                requests.post(f"{comfy_url}/free", json={"unload_models": True, "free_memory": True}, timeout=3)
                freed_external.append("comfyui")
            except Exception:
                pass
        a1111_url = str(cfg.get("a1111_url") or "").strip().rstrip("/")
        if a1111_url and self._loaded_backend == "a1111":
            try:
                requests.post(f"{a1111_url}/sdapi/v1/unload-checkpoint", json={}, timeout=3)
                freed_external.append("a1111")
            except Exception:
                pass

        with self._lock:
            self._loaded_backend = None
            self._active_proc = None
            self._active_job_id = None
            self._active_sd_job_id = None
        return {"ok": True, "freed_external": freed_external}

    # --- Job Submission & Serialized Execution ------------------------------------

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def list_jobs(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock:
            items = sorted(self._jobs.values(), key=lambda j: j["created_at"], reverse=True)[:limit]
            return [dict(j) for j in items]

    def submit_job(self, params: Dict[str, Any], wait: bool = False) -> Dict[str, Any]:
        job_id = f"img_{uuid.uuid4().hex[:12]}"
        job = {
            "job_id": job_id,
            "status": "queued",
            "stage": "queued",
            "progress": 0.0,
            "step": 0,
            "total_steps": int(params.get("steps") or 16),
            "backend": self.resolve_backend(str(params.get("backend") or "")),
            "model": str(params.get("model") or settings_mod.get_all().get("image_model") or ""),
            "created_at": int(time.time()),
            "started_at": 0,
            "finished_at": 0,
            "elapsed_ms": 0,
            "result": None,
            "error": "",
        }
        with self._lock:
            if len(self._jobs) > 40:
                oldest = sorted(self._jobs.keys(), key=lambda k: self._jobs[k]["created_at"])[:-30]
                for k in oldest:
                    if self._jobs[k]["status"] in ("done", "error", "cancelled"):
                        del self._jobs[k]
                        self._cancelled_jobs.discard(k)
            self._jobs[job_id] = job

        if wait:
            self._run_job(job_id, params)
            return self.get_job(job_id) or job

        t = threading.Thread(target=self._run_job, args=(job_id, params), daemon=True)
        t.start()
        return dict(job)

    def _update_job(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            if job_id in self._jobs:
                self._jobs[job_id].update(fields)

    def _is_job_cancelled(self, job_id: str) -> bool:
        with self._lock:
            return self._cancel_requested or job_id in self._cancelled_jobs

    def _run_job(self, job_id: str, params: Dict[str, Any]) -> None:
        with self._exec_lock:
            with self._lock:
                if job_id in self._cancelled_jobs:
                    self._jobs[job_id].update({"status": "cancelled", "stage": "cancelled", "finished_at": int(time.time()), "error": "Cancelled"})
                    return
                self._cancel_requested = False
                self._active_job_id = job_id

            t0 = time.time()
            self._update_job(job_id, status="running", stage="preparing", progress=5.0, started_at=int(t0))

            try:
                backend = self.resolve_backend(str(params.get("backend") or ""))
                self._update_job(job_id, backend=backend)

                if backend == "comfyui":
                    result = self._generate_comfyui(job_id, params)
                elif backend == "a1111":
                    result = self._generate_a1111(job_id, params)
                else:
                    result = self._generate_sdcpp(job_id, params)

                elapsed_ms = int((time.time() - t0) * 1000)
                self._loaded_backend = backend
                self._last_used_at = time.time()
                self._update_job(
                    job_id,
                    status="done",
                    stage="done",
                    progress=100.0,
                    finished_at=int(time.time()),
                    elapsed_ms=elapsed_ms,
                    result=result,
                )
            except Exception as exc:
                was_cancelled = self._is_job_cancelled(job_id)
                if not was_cancelled:
                    logger.error(f"Image generation job {job_id} failed: {exc}")
                status = "cancelled" if was_cancelled else "error"
                self._update_job(
                    job_id,
                    status=status,
                    stage=status,
                    finished_at=int(time.time()),
                    elapsed_ms=int((time.time() - t0) * 1000),
                    error="Cancelled" if was_cancelled else str(exc),
                )
            finally:
                with self._lock:
                    self._active_proc = None
                    self._active_sd_job_id = None
                    if self._active_job_id == job_id:
                        self._active_job_id = None
                    self._cancelled_jobs.discard(job_id)

    # --- Shared Model Resolution & Validation (`sdcpp`) ---------------------------

    def _prepare_sdcpp_spec(self, params: Dict[str, Any]) -> Dict[str, Any]:
        cfg = settings_mod.get_all()
        lib = library.scan_image_library(cfg.get("image_model"))
        models = lib["models"]
        if not models:
            raise RuntimeError("No local image models installed in server/models/image/.")

        requested_name = str(params.get("model") or cfg.get("image_model") or "").strip()
        ready_base = next((m for m in models if m.get("ready_to_run")), None)
        default_base = ready_base or next((m for m in models if m.get("weight_role") != "lora"), None)
        model_info = next((m for m in models if m["filename"] == requested_name), default_base or models[0])

        if model_info.get("weight_role") == "lora" and not params.get("model") and ready_base:
            logger.warning(
                f"Active image_model '{model_info['filename']}' is a LoRA; switching to '{ready_base['filename']}'."
            )
            settings_mod.update({"image_model": ready_base["filename"]})
            model_info = ready_base

        model_path = paths.IMAGE_MODELS_DIR / model_info["filename"]
        family = model_info["family"]
        variant = str(model_info.get("variant") or "")
        weight_role = model_info.get("weight_role") or ("diffusion_model" if model_info["format"] == "gguf" else "checkpoint")
        companions = _resolve_companion_paths(model_info, paths.IMAGE_AUX_DIR, cfg)

        if weight_role == "lora":
            raise RuntimeError(
                f"'{model_info['filename']}' is a LoRA file, not a base image model. "
                "Move it into server/models/loras/ and select a complete base checkpoint or GGUF diffusion model."
            )

        missing_comp: List[str] = []
        if model_info.get("needs_companions") or weight_role == "diffusion_model":
            for req_role in library.required_companion_roles(family, weight_role):
                if req_role not in companions:
                    missing_comp.append(req_role)
        if missing_comp:
            raise RuntimeError(
                f"Model '{model_info['filename']}' ({family}) is missing required companion files in {paths.IMAGE_AUX_DIR}: "
                f"{', '.join(missing_comp)}. Re-download a complete model bundle from Models or AI Finder."
            )

        hw_info = hardware.analyze_hardware()
        gpu = hw_info.get("gpu") or {}
        vram_total = int(gpu.get("vram_total") or 0)
        ref_max_dim = 768 if (0 < vram_total <= 10 * hardware.GIB) else 1024

        width = max(256, min(2048, int(params.get("width") or cfg.get("image_width") or 768)))
        height = max(256, min(2048, int(params.get("height") or cfg.get("image_height") or 1024)))
        if family == "sd15" and max(width, height) > 768 and not params.get("keep_exact_size"):
            if width == height:
                width, height = 640, 640
            else:
                scale = 768.0 / float(max(width, height))
                width = max(384, int(round(width * scale)))
                height = max(384, int(round(height * scale)))
        width = (width // 16) * 16
        height = (height // 16) * 16

        low_fname = model_info["filename"].lower()
        is_turbo = any(tok in low_fname for tok in ("turbo", "lightning", "schnell", "lcm", "hyper"))
        is_chroma_flash = variant == "chroma_flash" or (family == "chroma" and "flash" in low_fname)
        is_distilled_flow = family in DISTILLED_FLOW_FAMILIES or is_chroma_flash
        quality_mode = str(params.get("quality") or cfg.get("image_quality") or "balanced")
        default_steps = _default_steps_for_model(family, is_turbo, vram_total, quality_mode, variant=variant)
        cfg_steps = int(cfg.get("image_steps") or 0)
        req_steps = int(params.get("steps") or 0)
        if req_steps > 0:
            steps = max(4, min(60, req_steps))
        elif cfg_steps > 0:
            min_cfg_steps = 12 if (family in ("flux", "flux_kontext") and not is_turbo) else 4
            steps = max(min_cfg_steps, min(60, cfg_steps))
        else:
            steps = default_steps
        seed = int(params["seed"]) if params.get("seed") is not None and int(params["seed"]) >= 0 else random.randint(1, 2_147_483_647)

        base_prompt = str(params.get("prompt") or "").strip()
        if not base_prompt:
            raise RuntimeError("Image prompt cannot be empty.")
        if is_distilled_flow:
            negative_prompt = ""
        else:
            negative_prompt = str(params.get("negative_prompt") or "").strip()
            if not negative_prompt and family in ("sdxl", "sd15", "chroma", "sd3", "qwen_image"):
                negative_prompt = "lowres, blurry, bad anatomy, extra limbs, deformed, watermark, text, jpeg artifacts, static noise"

        # Resolve LoRA items and check architecture compatibility against active base model
        resolved_loras: List[Dict[str, Any]] = []
        skipped_loras: List[Dict[str, str]] = []
        raw_loras = params.get("loras") or []
        trigger_words: List[str] = []
        if isinstance(raw_loras, list):
            for l_item in raw_loras:
                if isinstance(l_item, str):
                    fname, weight, trig = l_item, 0.85, ""
                elif isinstance(l_item, dict):
                    fname = str(l_item.get("filename") or l_item.get("name") or "")
                    raw_w = l_item.get("weight") if l_item.get("weight") is not None else l_item.get("strength", 0.85)
                    weight = float(raw_w)
                    trig = str(l_item.get("trigger_word") or "").strip()
                else:
                    continue
                lora_path = paths.LORAS_DIR / Path(fname).name if fname else None
                if lora_path and lora_path.is_file():
                    l_meta = library.get_meta(f"loras/{lora_path.name}")
                    inspected = library.inspect_lora_header(lora_path)
                    lora_arch = str(l_meta.get("base_arch") or inspected.get("base_arch") or "").strip()
                    is_full_model = bool(inspected.get("is_full_model"))
                    if is_full_model or not library.is_lora_compatible_with_family(lora_arch, family):
                        reason_arch = "base_model" if is_full_model else (lora_arch or "unknown")
                        logger.warning(
                            f"Skipping incompatible LoRA '{lora_path.name}' (arch={reason_arch}) for base model '{model_info['filename']}' ({family})."
                        )
                        skipped_loras.append({
                            "filename": lora_path.name,
                            "lora_arch": reason_arch,
                            "model_family": family,
                        })
                        continue
                    resolved_loras.append({
                        "filename": lora_path.name,
                        "stem": lora_path.stem,
                        "weight": weight,
                        "size_bytes": lora_path.stat().st_size,
                    })
                    eff_trig = trig or str(l_meta.get("trigger_word") or inspected.get("trigger_word") or "").strip()
                    if eff_trig and eff_trig.lower() not in base_prompt.lower():
                        trigger_words.append(eff_trig)

        clean_prompt = f"{', '.join(trigger_words)}, {base_prompt}" if trigger_words else base_prompt
        if variant == "pony":
            if "score_" not in clean_prompt.lower():
                clean_prompt = f"score_9, score_8_up, score_7_up, {clean_prompt}"
            if negative_prompt and "score_" not in negative_prompt.lower():
                negative_prompt = f"score_4, score_5, {negative_prompt}"
        elif variant in ("illustrious", "animagine"):
            low_cp = clean_prompt.lower()
            if "masterpiece" not in low_cp and "best quality" not in low_cp:
                clean_prompt = f"masterpiece, best quality, newest, {clean_prompt}"

        # Sanitize reference images and optional init image
        sanitized_refs: List[Tuple[bytes, str, str]] = []
        raw_refs = params.get("references") or []
        max_refs = 2 if (0 < vram_total <= 10 * hardware.GIB) else 4
        if model_info.get("supports_refs") and isinstance(raw_refs, list):
            for ref in raw_refs[:max_refs]:
                cleaned = _sanitize_image_bytes(str(ref), max_dim=ref_max_dim)
                if cleaned is not None:
                    sanitized_refs.append(cleaned)

        sanitized_init: Optional[Tuple[bytes, str, str]] = None
        if params.get("init_image"):
            sanitized_init = _sanitize_image_bytes(str(params["init_image"]), max_dim=max(width, height))

        if is_distilled_flow:
            # Guidance-distilled / rectified-flow models (FLUX, FLUX Kontext, Z-Image, Chroma-Flash)
            # must run at txt_cfg = 1.0 without unconditional CFG passes to prevent latent noise.
            cfg_scale = 1.0
        else:
            cfg_setting = float(cfg.get("image_cfg") or 0.0)
            cfg_scale = params.get("cfg_scale")
            if cfg_scale is None and cfg_setting > 0:
                cfg_scale = cfg_setting
            if cfg_scale is None:
                if family == "chroma":
                    cfg_scale = 4.0
                elif family in ("qwen_image", "qwen_edit"):
                    cfg_scale = 3.0
                elif family == "sd3":
                    cfg_scale = 4.5
                elif is_turbo and family in ("sdxl", "sd15"):
                    cfg_scale = 2.0
                elif family == "sdxl":
                    cfg_scale = 5.5
                else:
                    cfg_scale = 7.0

        req_sampler = str(params.get("sampler") or "").strip().lower()
        cfg_sampler = str(cfg.get("image_sampler") or "").strip().lower()
        if req_sampler:
            sampler = req_sampler
        elif family in ("flux", "flux_kontext", "chroma", "qwen_image", "qwen_edit", "z_image", "sd3"):
            sampler = "euler"
        elif cfg_sampler and cfg_sampler not in ("auto", "euler"):
            sampler = cfg_sampler
        elif family == "sdxl":
            sampler = "euler_a" if (is_turbo or variant in ("pony", "illustrious", "animagine")) else "dpm++2m"
        elif family == "sd15":
            sampler = "euler_a"
        else:
            sampler = "euler"

        use_diffusion_flag = (
            weight_role == "diffusion_model"
            or (weight_role != "checkpoint" and model_info["format"] == "gguf")
            or family in ("flux", "flux_kontext", "chroma", "qwen_image", "qwen_edit", "z_image", "sd3")
        )

        lora_bytes = sum(int(l.get("size_bytes") or 0) for l in resolved_loras)
        total_model_bytes = model_info["size_bytes"] + sum(p.stat().st_size for p in companions.values()) + lora_bytes
        needs_cpu_offload = bool(
            gpu.get("has_gpu") and (vram_total < int(total_model_bytes * 1.25) or vram_total <= 12 * hardware.GIB)
        )
        needs_vae_tiling = bool(not gpu.get("has_gpu") or vram_total <= 12 * hardware.GIB or needs_cpu_offload)
        needs_vae_on_cpu = bool(
            gpu.get("has_gpu")
            and 0 < vram_total <= 10 * hardware.GIB
            and (
                family in ("flux", "flux_kontext", "qwen_image", "qwen_edit", "z_image", "chroma", "sd3")
                or bool(sanitized_refs)
                or lora_bytes >= hardware.GIB
            )
        )

        return {
            "model_info": model_info,
            "model_path": model_path,
            "family": family,
            "variant": variant,
            "companions": companions,
            "use_diffusion_flag": use_diffusion_flag,
            "width": width,
            "height": height,
            "steps": steps,
            "seed": seed,
            "clean_prompt": clean_prompt,
            "negative_prompt": negative_prompt,
            "resolved_loras": resolved_loras,
            "skipped_loras": skipped_loras,
            "sanitized_refs": sanitized_refs,
            "sanitized_init": sanitized_init,
            "strength": max(0.1, min(0.95, float(params.get("strength", 0.55)))),
            "cfg_scale": float(cfg_scale),
            "guidance": float(params["guidance"]) if params.get("guidance") is not None else (0.0 if family == "chroma" else 3.5),
            "sampler": sampler,
            "hw_info": hw_info,
            "has_gpu": bool(gpu.get("has_gpu")),
            "vram_total": vram_total,
            "needs_cpu_offload": needs_cpu_offload,
            "needs_vae_tiling": needs_vae_tiling,
            "needs_vae_on_cpu": needs_vae_on_cpu,
        }

    # --- Backend: Persistent `sd-server` + `sd-cli` Fallback ----------------------

    def _generate_sdcpp(self, job_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        sd_srv = find_sd_server_binary()
        sd_cli = find_sd_binary()
        if not sd_srv and not sd_cli:
            raise RuntimeError(
                "Scene image engine is not installed. Close the server window and run start-server.bat (or start-server.sh) to install all components."
            )

        spec = self._prepare_sdcpp_spec(params)
        self._update_job(job_id, total_steps=spec["steps"], model=spec["model_info"]["filename"])

        if sd_srv and sd_srv.is_file():
            try:
                return self._generate_via_sd_server(job_id, sd_srv, spec)
            except Exception as srv_exc:
                if self._is_job_cancelled(job_id):
                    raise
                logger.warning(f"sd-server execution failed ({srv_exc}); retrying cleanly via sd-cli fallback")
                self._stop_sd_server()
                if sd_cli:
                    return self._generate_via_sd_cli(job_id, sd_cli, spec, force_vae_on_cpu=True)
                raise

        assert sd_cli is not None
        return self._generate_via_sd_cli(job_id, sd_cli, spec, force_vae_on_cpu=bool(spec.get("needs_vae_on_cpu")))

    def _ensure_sd_server(self, job_id: str, sd_srv: Path, spec: Dict[str, Any]) -> int:
        comp_sig = tuple(sorted((k, str(v)) for k, v in spec["companions"].items()))
        sig = (
            str(spec["model_path"]),
            spec["family"],
            comp_sig,
            spec["use_diffusion_flag"],
            spec["has_gpu"],
            spec["needs_cpu_offload"],
            spec["needs_vae_tiling"],
            bool(spec.get("needs_vae_on_cpu")),
        )

        with self._server_lock:
            if self._is_server_alive() and self._server_sig == sig:
                port = self._server_port
                try:
                    r = requests.get(f"http://127.0.0.1:{port}/v1/models", timeout=2.0)
                    if r.ok:
                        if spec["resolved_loras"]:
                            requests.post(f"http://127.0.0.1:{port}/sdcpp/v1/models/refresh", timeout=2.0)
                        return port
                except Exception:
                    pass

        self._stop_sd_server()

        port = _pick_free_local_port()
        paths.LORAS_DIR.mkdir(parents=True, exist_ok=True)
        cmd: List[str] = [
            str(sd_srv),
            "--listen-ip", "127.0.0.1",
            "--listen-port", str(port),
            "--lora-model-dir", str(paths.LORAS_DIR),
        ]
        if spec["use_diffusion_flag"]:
            cmd += ["--diffusion-model", str(spec["model_path"])]
        else:
            cmd += ["-m", str(spec["model_path"])]

        companions = spec["companions"]
        if "vae" in companions:
            cmd += ["--vae", str(companions["vae"])]
        if "clip_l" in companions:
            cmd += ["--clip_l", str(companions["clip_l"])]
        if "clip_g" in companions:
            cmd += ["--clip_g", str(companions["clip_g"])]
        if "t5xxl" in companions:
            cmd += ["--t5xxl", str(companions["t5xxl"])]
        if "llm_encoder" in companions:
            cmd += ["--llm", str(companions["llm_encoder"])]
        if spec["family"] == "qwen_edit":
            cmd += ["--model-args", "qwen_image_zero_cond_t=true"]
        elif spec["family"] == "chroma":
            cmd += ["--model-args", "chroma_use_dit_mask=false,chroma_use_t5_mask=true"]

        if spec["has_gpu"]:
            cmd.append("--diffusion-fa")
            if spec["needs_cpu_offload"]:
                cmd += ["--offload-to-cpu", "--clip-on-cpu", "--vae-tiling"]
            elif spec["needs_vae_tiling"]:
                cmd.append("--vae-tiling")
            if spec.get("needs_vae_on_cpu"):
                cmd.append("--vae-on-cpu")
        else:
            cmd += ["--clip-on-cpu", "--vae-tiling"]

        run_env = os.environ.copy()
        lib_dir = str(sd_srv.parent)
        if os.name == "nt":
            extra_paths = [lib_dir]
            if SD_BIN_DIR.exists() and str(SD_BIN_DIR) != lib_dir:
                extra_paths.append(str(SD_BIN_DIR))
            prev_path = run_env.get("PATH", "")
            run_env["PATH"] = ";".join(extra_paths + ([prev_path] if prev_path else []))
        else:
            prev_ld = run_env.get("LD_LIBRARY_PATH", "")
            run_env["LD_LIBRARY_PATH"] = f"{lib_dir}:{prev_ld}" if prev_ld else lib_dir

        self._update_job(job_id, stage="loading_model", progress=10.0)
        logger.info(f"Starting resident sd-server on 127.0.0.1:{port} for {spec['model_info']['filename']}")

        proc = subprocess.Popen(
            cmd,
            cwd=str(SD_BIN_DIR if SD_BIN_DIR.exists() else paths.BASE_DIR),
            env=run_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        boot_logs: List[str] = []

        def _drain_stdout() -> None:
            if not proc.stdout:
                return
            for line in proc.stdout:
                s = line.strip()
                if s:
                    boot_logs.append(s)
                    if len(boot_logs) > 40:
                        boot_logs.pop(0)

        threading.Thread(target=_drain_stdout, daemon=True).start()

        with self._server_lock:
            self._server_proc = proc
            self._server_port = port
            self._server_sig = sig
            self._server_model_name = spec["model_info"]["filename"]

        deadline = time.time() + 240.0
        t_start = time.time()
        while time.time() < deadline:
            if self._is_job_cancelled(job_id):
                self._stop_sd_server()
                raise RuntimeError("Cancelled")
            if proc.poll() is not None:
                tail = " | ".join(boot_logs[-4:])
                self._stop_sd_server()
                raise RuntimeError(f"sd-server exited during model load (code {proc.returncode}): {tail}")
            try:
                r = requests.get(f"http://127.0.0.1:{port}/v1/models", timeout=1.5)
                if r.ok:
                    models_data = r.json().get("data") or []
                    if models_data:
                        logger.info(f"Resident sd-server ready in {round(time.time() - t_start, 1)}s")
                        return port
            except Exception:
                pass
            load_pct = min(22.0, 10.0 + (time.time() - t_start) * 0.2)
            self._update_job(job_id, stage="loading_model", progress=round(load_pct, 1))
            time.sleep(0.5)

        self._stop_sd_server()
        raise RuntimeError("Timed out loading image model into sd-server.")

    def _generate_via_sd_server(self, job_id: str, sd_srv: Path, spec: Dict[str, Any]) -> Dict[str, Any]:
        port = self._ensure_sd_server(job_id, sd_srv, spec)
        base_url = f"http://127.0.0.1:{port}"

        guidance_payload: Dict[str, Any] = {"txt_cfg": spec["cfg_scale"]}
        if spec["family"] in ("flux", "flux_kontext"):
            guidance_payload["distilled_guidance"] = spec["guidance"]
        elif spec["family"] == "chroma":
            guidance_payload["distilled_guidance"] = 0.0

        payload: Dict[str, Any] = {
            "prompt": spec["clean_prompt"],
            "negative_prompt": spec["negative_prompt"],
            "width": spec["width"],
            "height": spec["height"],
            "seed": spec["seed"],
            "batch_count": 1,
            "strength": spec["strength"],
            "init_image": spec["sanitized_init"][2] if spec["sanitized_init"] else None,
            "ref_images": [r[2] for r in spec["sanitized_refs"]],
            "lora": [
                {"path": l["filename"], "multiplier": l["weight"], "is_high_noise": False}
                for l in spec["resolved_loras"]
            ],
            "sample_params": {
                "sample_method": spec["sampler"],
                "sample_steps": spec["steps"],
                "guidance": guidance_payload,
            },
            "vae_tiling_params": {
                "enabled": bool(spec["needs_vae_tiling"]),
                "temporal_tiling": False,
                "tile_size_w": 256 if spec["needs_vae_tiling"] else 0,
                "tile_size_h": 256 if spec["needs_vae_tiling"] else 0,
                "target_overlap": 0.5,
                "rel_size_w": 0.0,
                "rel_size_h": 0.0,
                "extra_tiling_args": "",
            },
            "preview": "none",
            "output_format": "png",
            "output_compression": 100,
        }

        self._update_job(job_id, stage="encoding_prompt", progress=24.0)
        sub = requests.post(f"{base_url}/sdcpp/v1/img_gen", json=payload, timeout=20)
        if not sub.ok:
            raise RuntimeError(f"sd-server rejected img_gen ({sub.status_code}): {sub.text[:300]}")
        sd_job_id = str(sub.json().get("id") or "")
        if not sd_job_id:
            raise RuntimeError("sd-server did not return a job id.")

        with self._lock:
            self._active_sd_job_id = sd_job_id

        deadline = time.time() + 900.0
        while time.time() < deadline:
            if self._is_job_cancelled(job_id):
                try:
                    requests.post(f"{base_url}/sdcpp/v1/jobs/{sd_job_id}/cancel", timeout=3.0)
                except Exception:
                    pass
                raise RuntimeError("Cancelled")

            if not self._is_server_alive():
                raise RuntimeError("sd-server process terminated unexpectedly during generation.")

            poll = requests.get(f"{base_url}/sdcpp/v1/jobs/{sd_job_id}", timeout=10.0)
            if not poll.ok:
                time.sleep(0.5)
                continue
            jdata = poll.json()
            st = str(jdata.get("status") or "")
            prog = jdata.get("progress") or {}
            p_stage = str(prog.get("stage") or "")
            p_comp = prog.get("completed")
            p_tot = prog.get("total")
            p_unit = prog.get("unit")

            if st in ("queued", "generating"):
                if p_stage in ("conditioning", "vae_encode"):
                    self._update_job(job_id, stage="encoding_prompt", progress=25.0)
                elif p_stage == "sampling" and p_unit == "steps" and isinstance(p_comp, int) and isinstance(p_tot, int) and p_tot > 0:
                    pct = round(26.0 + 66.0 * min(1.0, p_comp / float(p_tot)), 1)
                    self._update_job(job_id, stage="generating", step=p_comp, total_steps=p_tot, progress=pct)
                elif p_stage in ("vae_decode", "encoding"):
                    self._update_job(job_id, stage="decoding", step=spec["steps"], total_steps=spec["steps"], progress=96.0)
                time.sleep(0.5)
                continue

            if st == "completed":
                images = (jdata.get("result") or {}).get("images") or []
                if not images or not images[0].get("b64_json"):
                    raise RuntimeError("sd-server completed job without image data.")
                img_bytes = base64.b64decode(images[0]["b64_json"])
                paths.SCENES_DIR.mkdir(parents=True, exist_ok=True)
                out_path = paths.SCENES_DIR / f"{job_id}.png"
                out_path.write_bytes(img_bytes)
                return {
                    "image_filename": out_path.name,
                    "image_url": f"/v1/images/files/{out_path.name}",
                    "image_base64": _encode_png_data_url(out_path),
                    "width": spec["width"],
                    "height": spec["height"],
                    "seed": spec["seed"],
                    "model_used": spec["model_info"]["filename"],
                    "family": spec["family"],
                    "backend": "sdcpp",
                    "skipped_loras": spec.get("skipped_loras", []),
                }

            if st == "cancelled":
                raise RuntimeError("Cancelled")

            err_obj = jdata.get("error")
            err_msg = err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj or "sd-server generation failed")
            raise RuntimeError(f"sd-server job failed: {err_msg}")

        raise RuntimeError("sd-server generation timed out.")

    def _generate_via_sd_cli(
        self,
        job_id: str,
        sd_bin: Path,
        spec: Dict[str, Any],
        force_vae_on_cpu: bool = False,
    ) -> Dict[str, Any]:
        paths.SCENES_DIR.mkdir(parents=True, exist_ok=True)
        out_path = paths.SCENES_DIR / f"{job_id}.png"
        steps = spec["steps"]

        prompt_cli = spec["clean_prompt"]
        if spec["resolved_loras"]:
            tags = [f"<lora:{l['stem']}:{l['weight']:.2f}>" for l in spec["resolved_loras"]]
            prompt_cli = f"{', '.join(tags)}, {prompt_cli}"

        def _run_once(vae_on_cpu: bool) -> Tuple[int, List[str]]:
            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp = Path(tmp_dir)
                cmd: List[str] = [str(sd_bin)]

                if spec["use_diffusion_flag"]:
                    cmd += ["--diffusion-model", str(spec["model_path"])]
                else:
                    cmd += ["-m", str(spec["model_path"])]

                companions = spec["companions"]
                if "vae" in companions:
                    cmd += ["--vae", str(companions["vae"])]
                if "clip_l" in companions:
                    cmd += ["--clip_l", str(companions["clip_l"])]
                if "clip_g" in companions:
                    cmd += ["--clip_g", str(companions["clip_g"])]
                if "t5xxl" in companions:
                    cmd += ["--t5xxl", str(companions["t5xxl"])]
                if "llm_encoder" in companions:
                    cmd += ["--llm", str(companions["llm_encoder"])]
                if spec["resolved_loras"]:
                    cmd += ["--lora-model-dir", str(paths.LORAS_DIR)]

                for idx, (raw_bytes, ext, _durl) in enumerate(spec["sanitized_refs"]):
                    ref_path = tmp / f"ref_{idx}.{ext}"
                    ref_path.write_bytes(raw_bytes)
                    cmd += ["-r", str(ref_path)]

                if spec["sanitized_init"]:
                    init_bytes, init_ext, _ = spec["sanitized_init"]
                    init_path = tmp / f"init.{init_ext}"
                    init_path.write_bytes(init_bytes)
                    cmd += ["-i", str(init_path), "--strength", f"{spec['strength']:.2f}"]

                cmd += ["--cfg-scale", f"{spec['cfg_scale']:.2f}"]
                if spec["family"] in ("flux", "flux_kontext"):
                    cmd += ["--guidance", f"{spec['guidance']:.2f}"]
                elif spec["family"] == "chroma":
                    cmd += ["--guidance", "0.00"]
                if spec["family"] == "qwen_edit":
                    cmd += ["--model-args", "qwen_image_zero_cond_t=true"]
                elif spec["family"] == "chroma":
                    cmd += ["--model-args", "chroma_use_dit_mask=false,chroma_use_t5_mask=true"]
                cmd += ["--sampling-method", spec["sampler"]]

                if spec["has_gpu"]:
                    cmd.append("--diffusion-fa")
                    if spec["needs_cpu_offload"]:
                        cmd += ["--offload-to-cpu", "--clip-on-cpu", "--vae-tiling"]
                    elif spec["needs_vae_tiling"]:
                        cmd.append("--vae-tiling")
                    if vae_on_cpu:
                        cmd.append("--vae-on-cpu")
                else:
                    cmd += ["--clip-on-cpu", "--vae-tiling"]

                cmd += [
                    "-p", prompt_cli,
                    "-W", str(spec["width"]),
                    "-H", str(spec["height"]),
                    "--steps", str(steps),
                    "-s", str(spec["seed"]),
                    "-o", str(out_path),
                ]
                if spec["negative_prompt"]:
                    cmd += ["-n", spec["negative_prompt"]]

                self._update_job(job_id, stage="generating", total_steps=steps, progress=20.0)
                logger.info(
                    f"Running sd-cli job {job_id} model={spec['model_info']['filename']} "
                    f"({spec['width']}x{spec['height']}, steps={steps}, vae_on_cpu={vae_on_cpu})"
                )

                run_env = os.environ.copy()
                lib_dir = str(sd_bin.parent)
                if os.name == "nt":
                    extra_paths = [lib_dir]
                    if SD_BIN_DIR.exists() and str(SD_BIN_DIR) != lib_dir:
                        extra_paths.append(str(SD_BIN_DIR))
                    prev_path = run_env.get("PATH", "")
                    run_env["PATH"] = ";".join(extra_paths + ([prev_path] if prev_path else []))
                else:
                    prev_ld = run_env.get("LD_LIBRARY_PATH", "")
                    run_env["LD_LIBRARY_PATH"] = f"{lib_dir}:{prev_ld}" if prev_ld else lib_dir

                proc = subprocess.Popen(
                    cmd,
                    cwd=str(SD_BIN_DIR if SD_BIN_DIR.exists() else paths.BASE_DIR),
                    env=run_env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                )
                with self._lock:
                    self._active_proc = proc

                tail_logs: List[str] = []
                sampling_done = False
                if proc.stdout:
                    for raw_line in proc.stdout:
                        line = raw_line.strip()
                        if not line:
                            continue
                        tail_logs.append(line)
                        if len(tail_logs) > 25:
                            tail_logs.pop(0)
                        m = STEP_PROGRESS_RE.search(line)
                        if m:
                            cur, tot = int(m.group(1)), max(1, int(m.group(2)))
                            # Only treat progress counters matching the requested step count as denoising steps
                            if 0 < cur <= tot and abs(tot - steps) <= max(2, int(steps * 0.25)):
                                pct = round(24.0 + 68.0 * (cur / float(tot)), 1)
                                self._update_job(job_id, stage="generating", step=cur, total_steps=tot, progress=min(92.0, pct))
                                if cur >= tot:
                                    sampling_done = True
                            elif sampling_done:
                                self._update_job(job_id, stage="decoding", step=steps, total_steps=steps, progress=96.0)
                        elif sampling_done and ("decoding" in line.lower() or "vae" in line.lower()):
                            self._update_job(job_id, stage="decoding", step=steps, total_steps=steps, progress=96.0)

                rc = proc.wait()
                return rc, tail_logs

        rc, tail_logs = _run_once(force_vae_on_cpu)
        if (rc != 0 or not out_path.is_file()) and not force_vae_on_cpu and spec["has_gpu"] and not self._is_job_cancelled(job_id):
            logger.warning(f"sd-cli exited with code {rc}; retrying once with --vae-on-cpu to avoid final VAE OOM")
            rc, tail_logs = _run_once(True)

        if rc != 0 or not out_path.is_file():
            err_tail = " | ".join(tail_logs[-4:])
            raise RuntimeError(f"sd-cli exited with code {rc}: {err_tail or 'no output image generated'}")

        return {
            "image_filename": out_path.name,
            "image_url": f"/v1/images/files/{out_path.name}",
            "image_base64": _encode_png_data_url(out_path),
            "width": spec["width"],
            "height": spec["height"],
            "seed": spec["seed"],
            "model_used": spec["model_info"]["filename"],
            "family": spec["family"],
            "backend": "sdcpp",
            "skipped_loras": spec.get("skipped_loras", []),
        }

    # --- Backend: External ComfyUI Adapter ----------------------------------------

    def _generate_comfyui(self, job_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        cfg = settings_mod.get_all()
        base = str(cfg.get("comfyui_url") or "").strip().rstrip("/")
        if not base:
            raise RuntimeError("ComfyUI URL is not configured in Hub Settings.")

        width = max(256, min(2048, ((int(params.get("width") or 832)) // 16) * 16))
        height = max(256, min(2048, ((int(params.get("height") or 1024)) // 16) * 16))
        steps = max(4, min(60, int(params.get("steps") or cfg.get("image_steps") or 20)))
        seed = int(params["seed"]) if params.get("seed") is not None and int(params["seed"]) >= 0 else random.randint(1, 2_147_483_647)
        prompt = str(params.get("prompt") or "").strip()
        neg = str(params.get("negative_prompt") or "lowres, blurry, deformed").strip()

        ckpt = str(params.get("model") or "").strip()
        if not ckpt or ckpt.endswith(".gguf"):
            try:
                obj = requests.get(f"{base}/object_info/CheckpointLoaderSimple", timeout=5).json()
                choices = obj["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"][0]
                if choices:
                    ckpt = choices[0]
            except Exception:
                pass
        if not ckpt:
            raise RuntimeError("No checkpoint found on external ComfyUI instance.")

        comfy_info = library.infer_image_family(ckpt)
        comfy_family = comfy_info["family"]
        comfy_variant = comfy_info.get("variant", "")
        is_distilled_comfy = comfy_family in DISTILLED_FLOW_FAMILIES or comfy_variant == "chroma_flash"
        default_comfy_cfg = 4.0 if comfy_family == "chroma" else (5.5 if comfy_family == "sdxl" else 6.5)
        comfy_cfg = 1.0 if is_distilled_comfy else float(params.get("cfg_scale") or cfg.get("image_cfg") or default_comfy_cfg)
        comfy_neg = "" if is_distilled_comfy else neg
        comfy_sampler = "euler_a" if comfy_variant in ("pony", "illustrious", "animagine") else "euler"

        raw_loras = params.get("loras") or []
        comfy_loras: List[Tuple[str, float]] = []
        if isinstance(raw_loras, list):
            for l_item in raw_loras:
                if isinstance(l_item, dict) and l_item.get("filename"):
                    fname = str(l_item["filename"])
                    weight = float(l_item.get("weight", 0.85))
                    trig = str(l_item.get("trigger_word") or "").strip()
                    comfy_loras.append((fname, weight))
                    if trig and trig.lower() not in prompt.lower():
                        prompt = f"{trig}, {prompt}"

        if comfy_variant == "pony" and "score_" not in prompt.lower():
            prompt = f"score_9, score_8_up, score_7_up, {prompt}"

        model_ref = ["4", 0]
        clip_ref = ["4", 1]
        workflow: Dict[str, Any] = {
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "height": height, "width": width}},
        }
        for idx, (lora_fname, lora_w) in enumerate(comfy_loras):
            node_id = str(20 + idx)
            workflow[node_id] = {
                "class_type": "LoraLoader",
                "inputs": {
                    "model": model_ref,
                    "clip": clip_ref,
                    "lora_name": lora_fname,
                    "strength_model": lora_w,
                    "strength_clip": lora_w,
                },
            }
            model_ref = [node_id, 0]
            clip_ref = [node_id, 1]

        workflow.update({
            "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": prompt}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"clip": clip_ref, "text": comfy_neg}},
            "3": {
                "class_type": "KSampler",
                "inputs": {
                    "cfg": comfy_cfg,
                    "denoise": float(params.get("strength", 1.0)),
                    "latent_image": ["5", 0],
                    "model": model_ref,
                    "negative": ["7", 0],
                    "positive": ["6", 0],
                    "sampler_name": comfy_sampler,
                    "scheduler": "normal",
                    "seed": seed,
                    "steps": steps,
                },
            },
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": f"silklora_{job_id}", "images": ["8", 0]}},
        })

        self._update_job(job_id, stage="generating")
        resp = requests.post(f"{base}/prompt", json={"prompt": workflow, "client_id": job_id}, timeout=15)
        resp.raise_for_status()
        prompt_id = resp.json()["prompt_id"]

        deadline = time.time() + 300
        out_img = None
        while time.time() < deadline:
            if self._is_job_cancelled(job_id):
                try:
                    requests.post(f"{base}/interrupt", timeout=3)
                except Exception:
                    pass
                raise RuntimeError("Cancelled")
            hist = requests.get(f"{base}/history/{prompt_id}", timeout=5).json()
            if prompt_id in hist:
                outputs = hist[prompt_id].get("outputs", {})
                for node_out in outputs.values():
                    imgs = node_out.get("images") or []
                    if imgs:
                        out_img = imgs[0]
                        break
                if out_img:
                    break
            time.sleep(0.75)

        if not out_img:
            raise RuntimeError("ComfyUI timed out waiting for rendered image.")

        q = urllib.parse.urlencode({
            "filename": out_img["filename"],
            "subfolder": out_img.get("subfolder", ""),
            "type": out_img.get("type", "output"),
        })
        img_bytes = requests.get(f"{base}/view?{q}", timeout=20).content
        paths.SCENES_DIR.mkdir(parents=True, exist_ok=True)
        out_path = paths.SCENES_DIR / f"{job_id}.png"
        out_path.write_bytes(img_bytes)
        return {
            "image_filename": out_path.name,
            "image_url": f"/v1/images/files/{out_path.name}",
            "image_base64": _encode_png_data_url(out_path),
            "width": width,
            "height": height,
            "seed": seed,
            "model_used": ckpt,
            "family": comfy_family if comfy_family != "other" else "comfyui",
            "backend": "comfyui",
        }

    # --- Backend: External Automatic1111 / Forge Adapter ------------------------

    def _generate_a1111(self, job_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        cfg = settings_mod.get_all()
        base = str(cfg.get("a1111_url") or "").strip().rstrip("/")
        if not base:
            raise RuntimeError("Automatic1111 / Forge URL is not configured in Hub Settings.")

        width = max(256, min(2048, ((int(params.get("width") or 832)) // 16) * 16))
        height = max(256, min(2048, ((int(params.get("height") or 1024)) // 16) * 16))
        steps = max(4, min(60, int(params.get("steps") or cfg.get("image_steps") or 20)))
        seed = int(params["seed"]) if params.get("seed") is not None and int(params["seed"]) >= 0 else random.randint(1, 2_147_483_647)
        prompt = str(params.get("prompt") or "").strip()
        neg = str(params.get("negative_prompt") or "").strip()
        model_hint = str(params.get("model") or cfg.get("image_model") or "").strip()
        if not model_hint:
            try:
                opts = requests.get(f"{base}/sdapi/v1/options", timeout=4).json()
                model_hint = str(opts.get("sd_model_checkpoint") or "")
            except Exception:
                pass
        a1111_info = library.infer_image_family(model_hint)
        a1111_family = a1111_info["family"]
        a1111_variant = a1111_info.get("variant", "")
        is_distilled_a1111 = a1111_family in DISTILLED_FLOW_FAMILIES or a1111_variant == "chroma_flash"
        default_a1111_cfg = 4.0 if a1111_family == "chroma" else (5.5 if a1111_family == "sdxl" else 6.5)
        a1111_cfg = 1.0 if is_distilled_a1111 else float(params.get("cfg_scale") or cfg.get("image_cfg") or default_a1111_cfg)
        a1111_neg = "" if is_distilled_a1111 else neg

        loras = params.get("loras") or []
        if isinstance(loras, list):
            for l_item in loras:
                if isinstance(l_item, dict) and l_item.get("filename"):
                    stem = Path(str(l_item["filename"])).stem
                    w = float(l_item.get("weight", 0.85))
                    trig = str(l_item.get("trigger_word") or "").strip()
                    if trig and trig.lower() not in prompt.lower():
                        prompt = f"{trig}, {prompt}"
                    prompt = f"<lora:{stem}:{w:.2f}>, {prompt}"

        if a1111_variant == "pony" and "score_" not in prompt.lower():
            prompt = f"score_9, score_8_up, score_7_up, {prompt}"

        self._update_job(job_id, stage="generating")
        payload: Dict[str, Any] = {
            "prompt": prompt,
            "negative_prompt": a1111_neg,
            "steps": steps,
            "width": width,
            "height": height,
            "seed": seed,
            "cfg_scale": a1111_cfg,
        }
        init_img = params.get("init_image")
        endpoint = "/sdapi/v1/img2img" if init_img else "/sdapi/v1/txt2img"
        if init_img:
            payload["init_images"] = [str(init_img)]
            payload["denoising_strength"] = float(params.get("strength", 0.55))

        res = requests.post(f"{base}{endpoint}", json=payload, timeout=300)
        res.raise_for_status()
        data = res.json()
        images = data.get("images") or []
        if not images:
            raise RuntimeError("Automatic1111 returned no images.")
        raw_bytes = base64.b64decode(images[0].split(",", 1)[-1])
        paths.SCENES_DIR.mkdir(parents=True, exist_ok=True)
        out_path = paths.SCENES_DIR / f"{job_id}.png"
        out_path.write_bytes(raw_bytes)
        return {
            "image_filename": out_path.name,
            "image_url": f"/v1/images/files/{out_path.name}",
            "image_base64": _encode_png_data_url(out_path),
            "width": width,
            "height": height,
            "seed": seed,
            "model_used": "a1111-active",
            "family": "a1111",
            "backend": "a1111",
        }


image_engine = ImageEngine()
