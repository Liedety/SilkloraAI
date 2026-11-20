"""GPU / RAM Lifecycle Coordinator for Text LLM <-> Image Engine swapping.

Ensures:
1. Text analysis completes BEFORE unloading the local LLM.
2. When VRAM/RAM cannot comfortably hold both, cleanly unloads llama-cpp before running
   image generation and keeps `image` mode active for repeated regenerations/tweaks.
3. Background memory/summary calls (`X-Silklora-Background: 1`) do NOT evict the active
   Image Engine; they are deferred cleanly until normal chat resumes.
4. On the next regular user chat message (`/v1/chat/completions`), automatically unloads
   any image worker / external WebUI cache and synchronously reloads the saved LLM before
   streaming the text reply.
"""

import gc
import threading
import time
from typing import Any, Dict, Optional

from . import hardware, library, paths, settings as settings_mod
from .engine import engine
from .hardware import GIB
from .image_engine import image_engine
from .log import logger


class Coordinator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.mode: str = "idle"  # "idle" | "llm" | "image" | "swapping"
        self.saved_llm: Optional[Dict[str, Any]] = None
        self.swap_message: str = ""
        self.swap_started_at: float = 0.0
        self.last_swap_error: str = ""

    def sync_from_engine(self) -> None:
        with self._lock:
            if engine.llama is not None and self.mode != "image":
                self.mode = "llm"
            elif engine.llama is None and self.mode == "llm" and not engine.is_loading:
                self.mode = "idle"

    def status(self) -> Dict[str, Any]:
        self.sync_from_engine()
        with self._lock:
            elapsed = round(time.time() - self.swap_started_at, 1) if (self.mode == "swapping" and self.swap_started_at > 0) else 0.0
            return {
                "mode": self.mode,
                "saved_llm": dict(self.saved_llm) if self.saved_llm else None,
                "swap_message": self.swap_message,
                "swap_elapsed": elapsed,
                "last_swap_error": self.last_swap_error,
            }

    def _estimate_image_bytes(self, image_model_name: Optional[str]) -> int:
        lib = library.scan_image_library(image_model_name)
        models = lib["models"]
        target = next((m for m in models if m["filename"] == image_model_name), models[0] if models else None)
        if not target:
            return 6 * GIB
        total = int(target.get("size_bytes") or 0)
        for comp_name in (target.get("companions") or {}).values():
            p = paths.IMAGE_AUX_DIR / str(comp_name)
            if p.is_file():
                total += p.stat().st_size
        return max(3 * GIB, total + 2 * GIB)

    def can_coexist(self, image_model_name: Optional[str] = None) -> bool:
        cfg = settings_mod.get_all()
        vram_mode = str(cfg.get("image_low_vram") or "auto")
        if vram_mode in ("always", "always_unload"):
            return False
        if vram_mode in ("off", "keep_both"):
            return True
        if engine.llama is None:
            return True

        hw = hardware.analyze_hardware()
        gpu = hw.get("gpu") or {}
        need_bytes = self._estimate_image_bytes(image_model_name)
        if gpu.get("has_gpu"):
            vram_free = int(gpu.get("vram_free") or 0)
            # Only keep both loaded in VRAM if at least 2 GB spare remains after image model
            return vram_free >= need_bytes + 2 * GIB
        ram_avail = int(hw.get("ram_available") or 0)
        return ram_avail >= need_bytes + 4 * GIB

    def prepare_for_image(self, image_model_name: Optional[str] = None) -> Dict[str, Any]:
        """Switch hub cleanly into Image mode, unloading the local LLM if hardware needs the memory."""
        self.sync_from_engine()
        unloaded_llm = False

        # Wait briefly if a model load was already finishing
        deadline = time.time() + 30
        while engine.is_loading and time.time() < deadline:
            time.sleep(0.2)

        with self._lock:
            self.last_swap_error = ""
            if engine.llama is not None and not self.can_coexist(image_model_name):
                self.mode = "swapping"
                self.swap_started_at = time.time()
                self.swap_message = "Unloading local text LLM to free memory for image generation..."
                st = engine.status()
                self.saved_llm = {
                    "model": st.get("model"),
                    "projector": st.get("projector"),
                    "ctx": st.get("n_ctx"),
                }
                need_unload = True
            else:
                need_unload = False
                self.mode = "image"

        if need_unload:
            try:
                engine.unload()
                gc.collect()
                if (hardware.analyze_hardware().get("gpu") or {}).get("has_gpu"):
                    time.sleep(0.8)
                unloaded_llm = True
                logger.info(f"Coordinator unloaded LLM ({self.saved_llm}) before image generation")
            except Exception as exc:
                logger.warning(f"Coordinator unload warning: {exc}")
            with self._lock:
                self.mode = "image"
                self.swap_message = ""
                self.swap_started_at = 0.0

        return {"mode": self.mode, "unloaded_llm": unloaded_llm, "saved_llm": self.saved_llm}

    def prepare_for_training(self) -> None:
        """Free both LLM and Image Engine before running LoRA PyTorch training."""
        if engine.llama is not None:
            st = engine.status()
            with self._lock:
                self.saved_llm = {
                    "model": st.get("model"),
                    "projector": st.get("projector"),
                    "ctx": st.get("n_ctx"),
                }
            engine.unload()
        image_engine.unload()
        gc.collect()
        with self._lock:
            self.mode = "image"

    def ensure_llm_for_chat(self, is_background: bool = False) -> str:
        """Called on `/v1/chat/completions`.

        Returns:
          - "ok": LLM is loaded and ready.
          - "deferred": background request deferred because Image mode is active.
          - "no_model": no LLM is loaded and nothing saved to restore.
        """
        self.sync_from_engine()

        if engine.llama is not None:
            should_unload_image = False
            with self._lock:
                if self.mode == "image" and not is_background:
                    should_unload_image = True
                    self.mode = "llm"
            if should_unload_image:
                image_engine.unload()
            return "ok"

        with self._lock:
            current_mode = self.mode
            saved = dict(self.saved_llm) if self.saved_llm else None

        if current_mode == "image":
            if is_background:
                return "deferred"
            if not saved or not saved.get("model"):
                last = settings_mod.get_all().get("last_model")
                if isinstance(last, dict) and last.get("model"):
                    saved = {
                        "model": last.get("model"),
                        "projector": last.get("projector") or "",
                        "ctx": None,
                    }
            if not saved or not saved.get("model"):
                with self._lock:
                    self.mode = "idle"
                return "no_model"

            with self._lock:
                self.mode = "swapping"
                self.swap_started_at = time.time()
                self.swap_message = f"Restoring local LLM ({saved['model']})..."
                self.last_swap_error = ""

            try:
                image_engine.unload()
                gc.collect()
                if (hardware.analyze_hardware().get("gpu") or {}).get("has_gpu"):
                    time.sleep(0.8)
                model_name = str(saved["model"])
                if not (paths.MODELS_DIR / model_name).is_file():
                    raise RuntimeError(f"Saved model {model_name} no longer exists in models/.")
                proj_name = str(saved.get("projector") or "") or None
                if proj_name and not (paths.MODELS_DIR / proj_name).is_file():
                    proj_name = None
                opts = {"n_ctx": int(saved["ctx"])} if saved.get("ctx") else {}
                engine.load_async(model_name, proj_name, opts)

                deadline = time.time() + 180
                while engine.is_loading and time.time() < deadline:
                    time.sleep(0.25)

                if engine.llama is None:
                    err_obj = engine.load_error
                    err = (err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj or "")) or "Timed out reloading saved text model."
                    with self._lock:
                        self.last_swap_error = err
                        self.mode = "idle"
                        self.swap_message = ""
                        self.swap_started_at = 0.0
                    return "no_model"

                with self._lock:
                    self.mode = "llm"
                    self.saved_llm = None
                    self.swap_message = ""
                    self.swap_started_at = 0.0
                logger.info(f"Coordinator restored text LLM {saved['model']}")
                return "ok"
            except Exception as exc:
                with self._lock:
                    self.last_swap_error = str(exc)
                    self.mode = "idle"
                    self.swap_message = ""
                    self.swap_started_at = 0.0
                logger.error(f"Coordinator failed to restore LLM: {exc}")
                return "no_model"

        return "no_model"

    def force_restore_llm(self) -> Dict[str, Any]:
        """Explicit API helper so user/dashboard can manually switch back from Image -> LLM."""
        res = self.ensure_llm_for_chat(is_background=False)
        return {"status": res, **self.status()}


coordinator = Coordinator()
