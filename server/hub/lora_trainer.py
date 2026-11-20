"""Optional isolated character LoRA dataset builder & diffusers/PEFT trainer for SilkloraAI Local Hub.

- Stores uploaded training datasets under `server/data/lora_datasets/<slug>/`.
- Outputs standard Kohya/diffusers-compatible `.safetensors` LoRA files into `server/models/loras/`
  with trigger word and base architecture metadata stored in `models_meta.json`.
- Keeps heavy training dependencies (`torch`, `diffusers`, `peft`, `accelerate`) out of the core hub
  requirements by isolating them in an optional `server/venv_trainer` created on demand.
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import hardware, library, paths, settings as settings_mod
from .log import logger

TRAINER_VENV = paths.BASE_DIR / "venv_trainer"
SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]+")
DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.+)$", re.DOTALL)
PEFT_LORA_KEY_RE = re.compile(r"^(?:base_model\.model\.)?(?:unet\.)?(.+?)\.(lora_[AB]|lora_down|lora_up)(?:\.[^.]+)?\.weight$")


def _detect_training_arch(base_model: str) -> str:
    """Detect whether a base checkpoint / HF repo is SDXL (including Illustrious, Pony, Animagine, NoobAI) or SD 1.5."""
    p = Path(base_model)
    fam = library.infer_image_family(p.name if p.is_file() else base_model)
    if fam["family"] in ("sdxl", "sd15"):
        return fam["family"]
    if p.is_file():
        suf = p.suffix.lower()
        if suf == ".safetensors":
            hdr = library.inspect_safetensors_header(p)
            if hdr.get("arch_hint") in ("sdxl", "sd15"):
                return hdr["arch_hint"]
        elif suf == ".ckpt":
            hdr = library.inspect_ckpt_header(p)
            if hdr.get("arch_hint") in ("sdxl", "sd15"):
                return hdr["arch_hint"]
        try:
            if p.stat().st_size >= int(4.8 * hardware.GIB):
                return "sdxl"
            return "sd15"
        except OSError:
            pass
    return "sdxl" if "xl" in base_model.lower() else "sd15"


def _convert_peft_unet_to_kohya_keys(lora_state: Dict[str, Any]) -> Dict[str, Any]:
    """Convert PEFT UNet LoRA state_dict keys into canonical Kohya `lora_unet_*.lora_down.weight` / `lora_up.weight` keys."""
    converted: Dict[str, Any] = {}
    for raw_key, tensor in lora_state.items():
        m = PEFT_LORA_KEY_RE.match(raw_key)
        if m:
            mod_name = m.group(1).replace(".", "_")
            kind = m.group(2)
            leaf = "lora_down.weight" if kind in ("lora_A", "lora_down") else "lora_up.weight"
            converted[f"lora_unet_{mod_name}.{leaf}"] = tensor
        else:
            converted[f"lora_unet_{raw_key.replace('.', '_')}"] = tensor
    return converted


def _slugify(name: str, fallback: str = "character_lora") -> str:
    cleaned = SAFE_NAME_RE.sub("_", (name or "").strip().lower()).strip("_")
    return (cleaned or fallback)[:48]


def _trainer_python() -> Optional[Path]:
    if os.name == "nt":
        cand = TRAINER_VENV / "Scripts" / "python.exe"
    else:
        cand = TRAINER_VENV / "bin" / "python"
    if cand.is_file():
        return cand
    return None


def _has_trainer_packages(py_exe: Path) -> bool:
    try:
        res = subprocess.run(
            [str(py_exe), "-c", "import torch, diffusers, peft, safetensors, accelerate, PIL"],
            capture_output=True,
            timeout=15,
        )
        return res.returncode == 0
    except Exception:
        return False


def _trainer_has_cuda(py_exe: Path) -> bool:
    """Return True if the isolated trainer virtualenv has GPU-enabled CUDA PyTorch working."""
    try:
        res = subprocess.run(
            [str(py_exe), "-c", "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)"],
            capture_output=True,
            timeout=20,
        )
        return res.returncode == 0
    except Exception:
        return False


def _install_cuda_torch(py: Path, progress_cb=None) -> bool:
    """Install CUDA-enabled PyTorch wheel into venv_trainer without letting PyPI overwrite it with CPU torch."""
    for cuda_tag in ("cu128", "cu126", "cu124"):
        msg = f"Installing GPU PyTorch ({cuda_tag.upper()}) inside venv_trainer..."
        logger.info(msg)
        if progress_cb:
            progress_cb(msg)
        res = subprocess.run(
            [
                str(py), "-m", "pip", "install",
                "--force-reinstall", "--no-deps", "--prefer-binary",
                "torch", "--index-url", f"https://download.pytorch.org/whl/{cuda_tag}",
            ],
            timeout=1800,
        )
        if res.returncode == 0 and _trainer_has_cuda(py):
            logger.info(f"Verified CUDA PyTorch ({cuda_tag}) inside venv_trainer")
            return True
    return False


def _save_dataset(
    slug: str,
    trigger_word: str,
    images: List[Any],
    base_caption: str = "",
) -> Path:
    ds_dir = paths.LORA_DATASETS_DIR / slug
    ds_dir.mkdir(parents=True, exist_ok=True)
    # Remove old images so stale photos don't mix into re-runs
    for old in ds_dir.glob("*"):
        if old.is_file():
            old.unlink()

    saved = 0
    for idx, item in enumerate(images):
        if isinstance(item, dict):
            raw_img = str(item.get("dataUrl") or item.get("base64") or item.get("data") or "")
            caption = str(item.get("caption") or base_caption or "").strip()
        else:
            raw_img = str(item or "")
            caption = base_caption.strip()

        m = DATA_URL_RE.match(raw_img.strip())
        ext = "jpg"
        b64 = raw_img.strip()
        if m:
            mime = m.group(1).lower()
            b64 = m.group(2)
            ext = "png" if "png" in mime else "jpg"
        try:
            blob = base64.b64decode(b64)
        except Exception:
            continue
        if len(blob) < 128:
            continue
        img_path = ds_dir / f"sample_{idx:02d}.{ext}"
        img_path.write_bytes(blob)
        full_caption = f"{trigger_word}, {caption}".strip(", ") if trigger_word else caption
        (ds_dir / f"sample_{idx:02d}.txt").write_text(full_caption or trigger_word or "character portrait", encoding="utf-8")
        saved += 1

    if saved < 1:
        raise RuntimeError("No valid training images were provided in the dataset.")
    return ds_dir


class LoraTrainer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._install_state: Dict[str, Any] = {"status": "idle", "progress": 0.0, "message": "", "error": ""}
        self._job: Dict[str, Any] = {"status": "idle", "job_id": "", "progress": 0.0, "step": 0, "total_steps": 0, "logs": [], "output_file": "", "error": ""}
        self._proc: Optional[subprocess.Popen] = None
        self._deps_ready_cache: Optional[bool] = None
        self._deps_checked_at: float = 0.0
        self._deps_probing: bool = False

    def _probe_deps_worker(self, py_exe: Path) -> None:
        try:
            ready = _has_trainer_packages(py_exe)
            with self._lock:
                self._deps_ready_cache = ready
                self._deps_checked_at = time.time()
        finally:
            with self._lock:
                self._deps_probing = False

    def _trigger_deps_probe(self, py_exe: Path) -> None:
        with self._lock:
            if self._deps_probing:
                return
            self._deps_probing = True
        threading.Thread(target=self._probe_deps_worker, args=(py_exe,), daemon=True).start()

    def status(self, hw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        machine_hw = hw or hardware.analyze_hardware(fresh_gpu=False)
        gpu = machine_hw.get("gpu") or {}
        vram_gb = round((gpu.get("vram_total") or 0) / hardware.GIB, 1)
        trainer_py = _trainer_python()
        py_exe = trainer_py or Path(sys.executable)
        now = time.time()

        with self._lock:
            cached = self._deps_ready_cache
            checked_at = self._deps_checked_at
            install_done = self._install_state.get("status") == "done"

        if install_done:
            deps_ready = True
        elif trainer_py is None:
            deps_ready = False if cached is None else cached
        else:
            deps_ready = bool(cached)
            if cached is None or (now - checked_at) > 120.0:
                self._trigger_deps_probe(py_exe)

        can_train_vram = bool(gpu.get("has_gpu") and vram_gb >= 6.0)

        with self._lock:
            job_snapshot = dict(self._job)
            if job_snapshot.get("status") in ("preparing", "training") and job_snapshot.get("started_at"):
                job_snapshot["elapsed_sec"] = max(0, int(time.time()) - int(job_snapshot["started_at"]))
            return {
                "installed": deps_ready,
                "trainer_python": str(py_exe),
                "gpu_ok": can_train_vram,
                "vram_gb": vram_gb,
                "gpu_kind": gpu.get("kind", "none"),
                "warning": "" if can_train_vram else "Local LoRA training requires NVIDIA/GPU with >= 6 GB VRAM. Reference Photos mode is recommended on lower VRAM.",
                "install": dict(self._install_state),
                "job": job_snapshot,
            }

    def install_trainer_async(self) -> Dict[str, Any]:
        with self._lock:
            if self._install_state["status"] in ("creating_venv", "installing"):
                return dict(self._install_state)
            self._install_state = {"status": "creating_venv", "progress": 10.0, "message": "Preparing isolated venv_trainer...", "error": ""}

        threading.Thread(target=self._install_worker, daemon=True).start()
        return dict(self._install_state)

    def _install_worker(self, progress_cb=None) -> None:
        try:
            if progress_cb:
                progress_cb("Preparing isolated venv_trainer...")
            if not _trainer_python():
                venv_ok = subprocess.run([sys.executable, "-m", "venv", str(TRAINER_VENV)], capture_output=True, timeout=180).returncode == 0
                if not venv_ok or not _trainer_python():
                    import shutil
                    uv_cand = paths.BASE_DIR / "python_tools" / ("uv.exe" if os.name == "nt" else "uv")
                    uv_bin = str(uv_cand) if uv_cand.is_file() else shutil.which("uv")
                    if uv_bin:
                        subprocess.run([uv_bin, "venv", "--seed", "--python", sys.executable, str(TRAINER_VENV)], check=True, timeout=180)
                    else:
                        subprocess.run([sys.executable, "-m", "venv", str(TRAINER_VENV)], check=True, timeout=180)
            py = _trainer_python()
            if not py:
                raise RuntimeError("Could not locate python inside venv_trainer.")
            if subprocess.run([str(py), "-m", "pip", "--version"], capture_output=True, timeout=30).returncode != 0:
                subprocess.run([str(py), "-m", "ensurepip", "--default-pip"], capture_output=True, timeout=120)

            hw = hardware.analyze_hardware(fresh_gpu=False)
            gpu = hw.get("gpu") or {}
            is_cuda = bool(gpu.get("has_gpu") and gpu.get("kind") == "cuda")

            # Install diffusers/peft/accelerate FIRST so their dependencies (sympy/filelock/jinja2/etc.)
            # are resolved without ever overwriting our CUDA torch wheel afterwards.
            msg_pkgs = "Installing diffusers, peft, accelerate, transformers, safetensors, Pillow, omegaconf..."
            with self._lock:
                self._install_state.update({"status": "installing", "progress": 25.0, "message": msg_pkgs})
            if progress_cb:
                progress_cb(msg_pkgs)

            pkgs = ["diffusers>=0.32.0", "peft>=0.13.0", "accelerate", "transformers", "safetensors", "Pillow", "omegaconf"]
            subprocess.run([str(py), "-m", "pip", "install", "--upgrade", "--prefer-binary", *pkgs], check=True, timeout=1800)

            if is_cuda:
                msg_torch = "Installing GPU PyTorch (CUDA) inside venv_trainer..."
                with self._lock:
                    self._install_state.update({"status": "installing", "progress": 65.0, "message": msg_torch})
                if not _install_cuda_torch(py, progress_cb=progress_cb):
                    raise RuntimeError("Could not install CUDA-enabled PyTorch wheel (cu128/cu126/cu124) inside venv_trainer.")
            else:
                msg_torch = "Installing PyTorch inside venv_trainer..."
                with self._lock:
                    self._install_state.update({"status": "installing", "progress": 65.0, "message": msg_torch})
                if progress_cb:
                    progress_cb(msg_torch)
                subprocess.run([str(py), "-m", "pip", "install", "--prefer-binary", "torch"], check=True, timeout=1800)

            with self._lock:
                self._deps_ready_cache = True
                self._deps_checked_at = time.time()
                self._install_state = {"status": "done", "progress": 100.0, "message": "LoRA trainer packages installed.", "error": ""}
        except Exception as exc:
            logger.error(f"LoRA trainer setup failed: {exc}")
            with self._lock:
                self._install_state = {"status": "error", "progress": 0.0, "message": "", "error": str(exc)}

    def ensure_trainer_sync(self, force: bool = False, progress_cb=None) -> Dict[str, Any]:
        """Synchronously verify or install venv_trainer from start-server.bat / bootstrap.py."""
        py = _trainer_python()
        hw = hardware.analyze_hardware(fresh_gpu=False)
        gpu = hw.get("gpu") or {}
        expects_cuda = bool(gpu.get("has_gpu") and gpu.get("kind") == "cuda")

        if py and not force and _has_trainer_packages(py):
            if expects_cuda and not _trainer_has_cuda(py):
                if progress_cb:
                    progress_cb("Detected CPU-only PyTorch in venv_trainer on NVIDIA GPU — upgrading to CUDA PyTorch...")
                ok_cuda = _install_cuda_torch(py, progress_cb=progress_cb)
                if not ok_cuda:
                    return {"ok": False, "already_installed": False, "error": "Failed to upgrade venv_trainer PyTorch to CUDA."}
            with self._lock:
                self._deps_ready_cache = True
                self._deps_checked_at = time.time()
                self._install_state = {"status": "done", "progress": 100.0, "message": "LoRA trainer ready.", "error": ""}
            return {"ok": True, "already_installed": True, "python": str(py)}

        self._install_worker(progress_cb=progress_cb)
        with self._lock:
            st = dict(self._install_state)
        return {
            "ok": st.get("status") == "done",
            "already_installed": False,
            "error": st.get("error") or "",
        }

    def start_training(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            if self._job["status"] in ("preparing", "training"):
                return dict(self._job)

        character_name = str(payload.get("character_name") or payload.get("name") or "character")
        trigger_word = str(payload.get("trigger_word") or f"slx_{_slugify(character_name, 'char')}").strip()
        base_model = str(payload.get("base_model") or "").strip()
        steps = max(40, min(1500, int(payload.get("steps") or 180)))
        rank = max(4, min(64, int(payload.get("rank") or 16)))
        lr = float(payload.get("learning_rate") or 1e-4)
        images = payload.get("images") or []
        base_caption = str(payload.get("caption") or payload.get("appearance") or "").strip()

        py = _trainer_python() or Path(sys.executable)
        if not _has_trainer_packages(py):
            raise RuntimeError("LoRA trainer environment is not installed yet. Restart start-server.bat (or start-server.sh) so the launcher installs all training components.")

        if not base_model:
            active_cfg_model = settings_mod.get_all().get("image_model")
            lib = library.scan_image_library(active_cfg_model)
            safetensor_ckpts = [
                m for m in lib["models"]
                if m["format"] in ("safetensors", "ckpt")
                and m["family"] in ("sd15", "sdxl")
                and m.get("weight_role") == "checkpoint"
            ]
            if not safetensor_ckpts:
                raise RuntimeError(
                    "Local LoRA training requires a full .safetensors/.ckpt base checkpoint (SDXL, Illustrious, Pony, Animagine, or SD 1.5) "
                    "in server/models/image/. Compressed .gguf files are inference-only: download an SDXL/SD1.5 .safetensors checkpoint to train on, "
                    "place a ready-made .safetensors LoRA into server/models/loras/, or use Reference Photos mode."
                )
            active_info = next((m for m in lib["models"] if m.get("is_active")), None)
            active_fam = str(active_info["family"]) if active_info else ""
            safetensor_ckpts.sort(
                key=lambda m: (
                    0 if m.get("is_active") else 1,
                    0 if (active_fam and library.is_lora_compatible_with_family(m["family"], active_fam)) else 1,
                    0 if m["family"] == "sdxl" else 1,
                    0 if m["format"] == "safetensors" else 1,
                    m["filename"].lower(),
                )
            )
            chosen_ckpt = safetensor_ckpts[0]
            base_model = str(paths.IMAGE_MODELS_DIR / chosen_ckpt["filename"])
        elif ".." not in base_model and "/" not in base_model and "\\" not in base_model and (paths.IMAGE_MODELS_DIR / base_model).is_file():
            base_model = str(paths.IMAGE_MODELS_DIR / base_model)

        base_arch = _detect_training_arch(base_model)
        hw_info = hardware.analyze_hardware(fresh_gpu=False)
        gpu = hw_info.get("gpu") or {}
        vram_bytes = int(gpu.get("vram_total") or 0)
        expects_cuda = bool(gpu.get("has_gpu") and gpu.get("kind") == "cuda")
        low_vram_sdxl = base_arch == "sdxl" and 0 < vram_bytes <= 10 * hardware.GIB
        default_res = (768 if low_vram_sdxl else 1024) if base_arch == "sdxl" else 512
        resolution = int(payload.get("resolution") or default_res)

        slug = _slugify(f"{character_name}_{int(time.time()) % 10000}")
        ds_dir = _save_dataset(slug, trigger_word, images, base_caption)

        paths.LORAS_DIR.mkdir(parents=True, exist_ok=True)
        out_name = f"{_slugify(character_name)}_lora_{int(time.time()) % 10000}.safetensors"
        out_path = paths.LORAS_DIR / out_name
        job_id = f"lora_{uuid.uuid4().hex[:10]}"

        job_cfg = {
            "job_id": job_id,
            "dataset_dir": str(ds_dir),
            "output_path": str(out_path),
            "base_model": base_model,
            "base_model_name": Path(base_model).name if Path(base_model).is_file() else base_model,
            "base_arch": base_arch,
            "trigger_word": trigger_word,
            "steps": steps,
            "rank": rank,
            "learning_rate": lr,
            "resolution": resolution,
            "require_cuda": expects_cuda,
        }
        with self._lock:
            self._job = {
                "status": "preparing",
                "stage": "preparing_dataset",
                "job_id": job_id,
                "progress": 3.0,
                "step": 0,
                "total_steps": steps,
                "started_at": int(time.time()),
                "elapsed_sec": 0,
                "logs": [f"Dataset prepared: {ds_dir} ({len(list(ds_dir.glob('sample_*.*')))} files, base={base_arch}, checkpoint={job_cfg['base_model_name']})"],
                "output_file": out_name,
                "trigger_word": trigger_word,
                "base_arch": base_arch,
                "base_model_name": job_cfg["base_model_name"],
                "error": "",
            }

        threading.Thread(target=self._run_worker, args=(py, job_cfg), daemon=True).start()
        with self._lock:
            return dict(self._job)

    def _run_worker(self, py: Path, cfg: Dict[str, Any]) -> None:
        cfg_file = Path(cfg["dataset_dir"]) / "train_config.json"
        cfg_file.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

        try:
            if cfg.get("require_cuda") and not _trainer_has_cuda(py):
                with self._lock:
                    self._job["status"] = "training"
                    self._job["stage"] = "loading_checkpoint"
                    self._job["progress"] = 5.0
                    self._job["logs"] = (self._job["logs"] + ["Upgrading venv_trainer PyTorch to CUDA GPU acceleration..."])[-40:]
                ok_cuda = _install_cuda_torch(py)
                if not ok_cuda:
                    raise RuntimeError(
                        "NVIDIA GPU detected, but PyTorch CUDA inside venv_trainer could not be activated. "
                        "Close the server and run start-server.bat --repair so LoRA training runs on GPU instead of CPU."
                    )

            with self._lock:
                self._job["status"] = "training"
                self._job["stage"] = "loading_checkpoint"
                self._job["progress"] = 6.0
            cmd = [str(py), "-m", "hub.lora_trainer", "--worker", str(cfg_file)]
            proc = subprocess.Popen(
                cmd,
                cwd=str(paths.BASE_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            with self._lock:
                self._proc = proc

            if proc.stdout:
                for raw_line in proc.stdout:
                    line = raw_line.strip()
                    if not line:
                        continue
                    with self._lock:
                        self._job["logs"] = (self._job["logs"] + [line])[-40:]
                        low_line = line.lower()
                        m = re.search(r"STEP\s+(\d+)\s*/\s*(\d+)", line)
                        if m:
                            cur, tot = int(m.group(1)), max(1, int(m.group(2)))
                            self._job["stage"] = "training_steps"
                            self._job["step"] = cur
                            self._job["total_steps"] = tot
                            self._job["progress"] = min(98.5, round(15.0 + cur * 83.5 / tot, 1))
                        elif "loading base model" in low_line:
                            self._job["stage"] = "loading_checkpoint"
                            self._job["progress"] = max(float(self._job.get("progress") or 0.0), 8.0)
                        elif "encoding training samples" in low_line:
                            self._job["stage"] = "encoding_latents"
                            self._job["progress"] = max(float(self._job.get("progress") or 0.0), 13.0)
                        elif "saved lora weights" in low_line:
                            self._job["stage"] = "saving_weights"
                            self._job["progress"] = 99.0

            rc = proc.wait()
            out_path = Path(cfg["output_path"])
            if rc != 0 or not out_path.is_file():
                raise RuntimeError(f"Training subprocess exited with code {rc}.")

            base_arch = str(cfg.get("base_arch") or _detect_training_arch(cfg["base_model"]))
            base_name = str(cfg.get("base_model_name") or Path(cfg["base_model"]).name)
            library.set_meta(f"loras/{out_path.name}", {
                "trigger_word": cfg["trigger_word"],
                "base_arch": base_arch,
                "base_model": base_name,
                "trained_by": "silklora-trainer",
                "created_at": int(time.time()),
            })

            # If the currently active scene model is incompatible with the newly trained LoRA (or missing companions),
            # automatically switch to a compatible ready model (preferring the checkpoint we just trained on).
            switched_model = ""
            try:
                active_now = settings_mod.get_all().get("image_model") or ""
                lib_now = library.scan_image_library(active_now)
                active_entry = next((m for m in lib_now["models"] if m["filename"] == active_now), None)
                active_ok = bool(
                    active_entry
                    and active_entry.get("ready_to_run")
                    and library.is_lora_compatible_with_family(base_arch, active_entry.get("family", ""))
                )
                if not active_ok:
                    compat_ready = [
                        m for m in lib_now["models"]
                        if m.get("ready_to_run") and library.is_lora_compatible_with_family(base_arch, m.get("family", ""))
                    ]
                    preferred = next((m for m in compat_ready if m["filename"] == base_name), None) or (compat_ready[0] if compat_ready else None)
                    if preferred:
                        settings_mod.update({"image_model": preferred["filename"]})
                        switched_model = preferred["filename"]
                        logger.info(f"Switched active scene model to compatible checkpoint '{switched_model}' for new {base_arch} LoRA")
            except Exception:
                pass

            with self._lock:
                started = int(self._job.get("started_at") or int(time.time()))
                self._job.update({
                    "status": "done",
                    "stage": "done",
                    "progress": 100.0,
                    "step": cfg["steps"],
                    "elapsed_sec": max(0, int(time.time()) - started),
                    "switched_image_model": switched_model,
                })
            logger.info(f"LoRA training finished: {out_path.name}")
        except Exception as exc:
            logger.error(f"LoRA training error: {exc}")
            with self._lock:
                self._job.update({"status": "error", "stage": "error", "error": str(exc)})
        finally:
            with self._lock:
                self._proc = None


lora_trainer = LoraTrainer()


def _run_training_worker_cli(config_path: str) -> int:
    """Actual isolated PyTorch/Diffusers/PEFT LoRA training entrypoint executed in subprocess."""
    from contextlib import nullcontext
    cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
    import torch
    import torch.nn.functional as F
    from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
    from PIL import Image
    from safetensors.torch import save_file

    has_cuda = torch.cuda.is_available()
    if cfg.get("require_cuda") and not has_cuda:
        raise RuntimeError(
            "CUDA GPU is required for fast LoRA training, but venv_trainer has CPU-only PyTorch. "
            "Restart start-server.bat to repair GPU PyTorch."
        )

    device = "cuda" if has_cuda else "cpu"
    if device == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        use_bf16 = bool(getattr(torch.cuda, "is_bf16_supported", lambda: False)())
        compute_dtype = torch.bfloat16 if use_bf16 else torch.float16
    else:
        compute_dtype = torch.float32

    base_model = cfg["base_model"]
    is_single_file = Path(base_model).is_file()
    base_arch = str(cfg.get("base_arch") or _detect_training_arch(base_model))
    is_sdxl = base_arch == "sdxl"
    print(f"Loading base model ({'SDXL' if is_sdxl else 'SD1.5'}) on {device} ({str(compute_dtype).split('.')[-1]})...", flush=True)

    pipe_cls = StableDiffusionXLPipeline if is_sdxl else StableDiffusionPipeline
    if is_single_file:
        try:
            import omegaconf  # noqa: F401
        except ImportError:
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "omegaconf"], check=False, timeout=120)
        pipe = pipe_cls.from_single_file(base_model, torch_dtype=compute_dtype)
    else:
        pipe = pipe_cls.from_pretrained(base_model, torch_dtype=compute_dtype)

    res = int(cfg.get("resolution") or (1024 if is_sdxl else 512))
    ds_dir = Path(cfg["dataset_dir"])
    samples = []
    for p in sorted(ds_dir.glob("sample_*.*")):
        if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            continue
        txt_p = p.with_suffix(".txt")
        caption = txt_p.read_text(encoding="utf-8").strip() if txt_p.is_file() else cfg["trigger_word"]
        img = Image.open(p).convert("RGB").resize((res, res), Image.LANCZOS)
        arr = torch.tensor(list(img.getdata()), dtype=torch.float32).view(res, res, 3).permute(2, 0, 1) / 127.5 - 1.0
        samples.append((arr.unsqueeze(0), caption))

    if not samples:
        raise RuntimeError("Dataset folder had no readable images.")

    # Phase 1: Precompute text embeddings & VAE latents BEFORE moving UNet to GPU (keeps peak VRAM < 6 GB on 8 GB GPUs!)
    print(f"Encoding training samples ({len(samples)} images)...", flush=True)
    vae = pipe.vae.to(device=device, dtype=torch.float32)
    vae.requires_grad_(False)
    with torch.no_grad():
        if is_sdxl:
            pipe.text_encoder.to(device=device, dtype=compute_dtype)
            pipe.text_encoder_2.to(device=device, dtype=compute_dtype)
            encoded = []
            for img_t, cap in samples:
                prompt_embeds, _, pooled_embeds, _ = pipe.encode_prompt(prompt=cap, device=device)
                latents_f32 = vae.encode(img_t.to(device=device, dtype=torch.float32)).latent_dist.sample() * vae.config.scaling_factor
                latents = latents_f32.to(device=device, dtype=compute_dtype)
                add_time_ids = torch.tensor([[res, res, 0, 0, res, res]], device=device, dtype=compute_dtype)
                encoded.append((latents.detach(), prompt_embeds.to(compute_dtype).detach(), {"text_embeds": pooled_embeds.to(compute_dtype).detach(), "time_ids": add_time_ids}))
            pipe.text_encoder.to("cpu")
            pipe.text_encoder_2.to("cpu")
        else:
            pipe.text_encoder.to(device=device, dtype=compute_dtype)
            encoded = []
            for img_t, cap in samples:
                tok = pipe.tokenizer(cap, padding="max_length", max_length=pipe.tokenizer.model_max_length, truncation=True, return_tensors="pt").input_ids.to(device)
                emb = pipe.text_encoder(tok)[0]
                latents_f32 = vae.encode(img_t.to(device=device, dtype=torch.float32)).latent_dist.sample() * vae.config.scaling_factor
                latents = latents_f32.to(device=device, dtype=compute_dtype)
                encoded.append((latents.detach(), emb.to(compute_dtype).detach(), None))
            pipe.text_encoder.to("cpu")
    vae.to("cpu")
    if device == "cuda":
        torch.cuda.empty_cache()

    # Phase 2: Move frozen UNet (bf16/fp16) + trainable FP32 LoRA weights to GPU
    unet = pipe.unet.to(device=device, dtype=compute_dtype)
    rank = int(cfg["rank"])
    lora_cfg = LoraConfig(
        r=rank,
        lora_alpha=rank,
        target_modules=["to_k", "to_q", "to_v", "to_out.0"],
    )
    unet.add_adapter(lora_cfg)
    unet.requires_grad_(False)
    if is_sdxl and hasattr(unet, "enable_gradient_checkpointing"):
        unet.enable_gradient_checkpointing()
    for name, param in unet.named_parameters():
        if "lora_" in name:
            param.data = param.data.to(torch.float32)
            param.requires_grad_(True)

    trainable = [p for p in unet.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=float(cfg["learning_rate"]))
    use_scaler = device == "cuda" and compute_dtype == torch.float16
    scaler = torch.amp.GradScaler("cuda") if use_scaler else None
    scheduler = pipe.scheduler

    total_steps = int(cfg["steps"])
    unet.train()
    for step in range(1, total_steps + 1):
        latents, cond, extra = encoded[(step - 1) % len(encoded)]
        noise = torch.randn_like(latents)
        t = torch.randint(0, scheduler.config.num_train_timesteps, (1,), device=device).long()
        noisy = scheduler.add_noise(latents, noise, t)
        if is_sdxl:
            noisy = noisy.detach().requires_grad_(True)
        kwargs = {"added_cond_kwargs": extra} if extra is not None else {}
        ctx = torch.amp.autocast("cuda", dtype=compute_dtype) if device == "cuda" else nullcontext()
        with ctx:
            pred = unet(noisy, t, encoder_hidden_states=cond, **kwargs).sample
            loss = F.mse_loss(pred.float(), noise.float())
        if scaler is not None:
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
        else:
            loss.backward()
            optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        if step == 1 or step % 10 == 0 or step == total_steps:
            print(f"STEP {step}/{total_steps} loss={loss.item():.4f}", flush=True)

    # Save PEFT LoRA weights cleanly in canonical Kohya safetensors format
    lora_state = get_peft_model_state_dict(unet)
    kohya_raw = _convert_peft_unet_to_kohya_keys(lora_state)
    prefixed: Dict[str, Any] = {}
    for k, v in kohya_raw.items():
        prefixed[k] = v.cpu().to(torch.float16)
        if k.endswith(".lora_down.weight"):
            alpha_key = k[: -len(".lora_down.weight")] + ".alpha"
            prefixed[alpha_key] = torch.tensor(float(rank), dtype=torch.float16)
    save_file(
        prefixed,
        cfg["output_path"],
        metadata={
            "ss_base_model_version": "sdxl_base_v1-0" if is_sdxl else "sd_v1",
            "modelspec.architecture": base_arch,
            "modelspec.trigger_phrase": str(cfg.get("trigger_word") or ""),
        },
    )
    print(f"Saved LoRA weights to {cfg['output_path']}", flush=True)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    args = parser.parse_args()
    raise SystemExit(_run_training_worker_cli(args.worker))
