"""Inference engine: llama.cpp loading, automatic planning and generation with safe cancellation."""

import asyncio
import gc
import threading
import time
import traceback
from typing import Any, Dict, List, Optional

from . import cuda, settings
from .context import estimate_tokens
from .gguf import inspect_model
from .hardware import analyze_hardware, build_profile
from .log import logger
from .paths import MODELS_DIR
from .planner import plan_load

llama_cpp = None
Llama = None
IMPORT_ERROR = ""


def import_llama():
    """Import llama_cpp once, after the Windows DLL search path has been prepared."""
    global llama_cpp, Llama, IMPORT_ERROR
    if llama_cpp is not None:
        return True
    cuda.register_dll_directories()
    try:
        import llama_cpp as module
        from llama_cpp import Llama as llama_class

        llama_cpp, Llama = module, llama_class
        return True
    except Exception as e:
        IMPORT_ERROR = f"{type(e).__name__}: {e}"
        return False


def engine_info() -> Dict[str, Any]:
    if not import_llama():
        return {"available": False, "backend": "none", "version": "", "gpu_offload": False, "error": IMPORT_ERROR}
    offload = False
    try:
        offload = bool(llama_cpp.llama_supports_gpu_offload())
    except Exception:
        pass
    return {
        "available": True,
        "backend": "gpu" if offload else "cpu",
        "version": getattr(llama_cpp, "__version__", "unknown"),
        "gpu_offload": offload,
        "error": "",
    }


def is_illegal_instruction(text: str) -> bool:
    low = (text or "").lower()
    return "1073741795" in low or "0xc000001d" in low or "illegal instruction" in low


def _handler_class(name: str):
    try:
        import importlib

        module = importlib.import_module("llama_cpp.llama_chat_format")
        return getattr(module, name, None)
    except Exception:
        return None


def vision_handler_candidates(model_info: Dict[str, Any], projector_info: Dict[str, Any], model_name: str) -> List[str]:
    """Order chat handler classes by the projector type and architecture found in the GGUF headers."""
    ptype = (projector_info.get("projector_type") or "").lower()
    arch = (model_info.get("arch") or "").lower()
    hint = f"{model_name} {model_info.get('name', '')}".lower()

    rules = [
        (lambda: "qwen2.5vl" in ptype or "qwen25vl" in ptype, ["Qwen25VLChatHandler"]),
        (lambda: "qwen3vl" in ptype or arch.startswith("qwen3vl"), ["Qwen3VLChatHandler", "Qwen25VLChatHandler"]),
        (lambda: "qwen2vl" in ptype or arch.startswith("qwen2vl"), ["Qwen25VLChatHandler"]),
        (lambda: "resampler" in ptype or arch.startswith("minicpm"), ["MiniCPMv26ChatHandler"]),
        (lambda: "gemma3" in ptype or arch.startswith("gemma3"), ["Gemma3ChatHandler"]),
        (lambda: "moondream" in hint, ["MoondreamChatHandler"]),
        (lambda: "nanollava" in hint or "nano-llava" in hint, ["NanoLlavaChatHandler"]),
        (lambda: "llama-3" in hint and "vision" in hint, ["Llama3VisionAlphaChatHandler"]),
        (lambda: any(t in hint for t in ("llava-1.6", "llava-v1.6", "llava1.6", "llava-next")), ["Llava16ChatHandler"]),
    ]
    ordered: List[str] = []
    for test, names in rules:
        try:
            if test():
                ordered.extend(n for n in names if n not in ordered)
        except Exception:
            continue
    ordered.append("Llava15ChatHandler")
    return ordered


class Engine:
    def __init__(self):
        self.state_lock = threading.RLock()
        self.inference_lock = threading.Lock()
        self.llama: Optional[Any] = None
        self.model_name: str = ""
        self.projector_name: str = ""
        self.plan: Dict[str, Any] = {}
        self.model_info: Dict[str, Any] = {}
        self.is_loading = False
        self.loading_model = ""
        self.loading_step = ""
        self.load_started = 0.0
        self.load_seconds: Optional[float] = None
        self.load_error: Optional[Dict[str, Any]] = None
        self.started_at = time.time()

    @property
    def ready(self) -> bool:
        return self.llama is not None

    @property
    def n_ctx(self) -> int:
        return int(self.plan.get("n_ctx", 0)) if self.llama is not None else 0

    def count_tokens(self, text: str) -> int:
        llama = self.llama
        if llama is None or not text:
            return estimate_tokens(text)
        try:
            return len(llama.tokenize(text.encode("utf-8"), add_bos=False, special=False))
        except Exception:
            return estimate_tokens(text)

    def recommended_prompt_tokens(self) -> int:
        """Prompt size the client should aim for: large enough for long scenes, small enough to stay fast."""
        n_ctx = self.n_ctx
        if not n_ctx:
            return 0
        speed_cap = {"full": 8192, "partial": 4608, "none": 3072}.get(self.plan.get("offload", "none"), 3072)
        return max(1024, min(n_ctx - 1280, speed_cap))

    def _set_step(self, text: str):
        with self.state_lock:
            self.loading_step = text
        logger.info(text)

    def unload(self):
        # Wait for a running generation to finish so the model is never freed under it.
        acquired = self.inference_lock.acquire(timeout=120)
        try:
            with self.state_lock:
                if self.llama is not None:
                    logger.info(f"Unloading model: {self.model_name}")
                self.llama = None
                self.model_name = ""
                self.projector_name = ""
                self.plan = {}
                self.model_info = {}
            gc.collect()
        finally:
            if acquired:
                self.inference_lock.release()

    def build_plan(self, model_name: str, projector_name: Optional[str], options: Dict[str, Any]) -> Dict[str, Any]:
        model_path = MODELS_DIR / model_name
        info = inspect_model(model_path)
        proj_bytes = 0
        if projector_name:
            proj_bytes = inspect_model(MODELS_DIR / projector_name)["size_bytes"]
        hw = analyze_hardware(fresh_gpu=True)
        prefs = settings.get_all()
        ctx_request = options.get("n_ctx")
        if ctx_request in (None, "", "auto", 0):
            ctx_request = None if prefs["ctx_mode"] == "auto" else int(prefs["ctx_mode"])
        layers_request = options.get("n_gpu_layers")
        if layers_request in (None, "", "auto"):
            layers_request = None if prefs["gpu_layers_mode"] == "auto" else int(prefs["gpu_layers_mode"])
        plan = plan_load(
            info,
            hw,
            mmproj_bytes=proj_bytes,
            ctx_request=int(ctx_request) if ctx_request else None,
            layers_request=int(layers_request) if layers_request is not None else None,
            kv_quant=bool(prefs["kv_quant"]),
            ctx_cap=int(prefs["ctx_cap"]),
            vision=bool(projector_name),
        )
        plan["model_name"] = model_name
        plan["projector_name"] = projector_name or ""
        plan["arch"] = info["arch"]
        plan["profile"] = build_profile(hw)["tier"]
        return plan

    def load_async(self, model_name: str, projector_name: Optional[str] = None, options: Optional[Dict[str, Any]] = None):
        with self.state_lock:
            if self.is_loading:
                raise RuntimeError("busy")
            self.is_loading = True
            self.loading_model = model_name
            self.load_error = None
            self.load_started = time.time()
            self.loading_step = "Preparing"
        threading.Thread(
            target=self._load_worker,
            args=(model_name, projector_name, options or {}),
            daemon=True,
        ).start()

    def _fail(self, code: str, message: str, **extra):
        with self.state_lock:
            self.load_error = {"code": code, "message": message, **extra}
        logger.error(f"Load failed [{code}]: {message}")

    def _load_worker(self, model_name: str, projector_name: Optional[str], options: Dict[str, Any]):
        try:
            if not import_llama():
                self._fail("engine_missing", IMPORT_ERROR)
                return

            model_path = MODELS_DIR / model_name
            if not model_path.is_file():
                self._fail("file_missing", model_name)
                return
            info = inspect_model(model_path)
            if info["is_projector"]:
                self._fail("is_projector", model_name)
                return
            if not info["valid"]:
                self._fail("file_invalid", info["error"] or "unreadable GGUF header", file=model_name)
                return
            if info["size_bytes"] < 50 * 1024 * 1024:
                logger.warning(f"{model_name} is unusually small; the download may be incomplete")

            proj_path = None
            proj_info: Dict[str, Any] = {}
            if projector_name:
                proj_path = MODELS_DIR / projector_name
                if proj_path.is_file():
                    proj_info = inspect_model(proj_path)
                else:
                    logger.warning(f"Projector {projector_name} not found, loading text only")
                    projector_name, proj_path = None, None

            self._set_step("Releasing memory of the previous model")
            self.unload()
            time.sleep(0.4)

            self._set_step("Planning memory use for this machine")
            plan = self.build_plan(model_name, projector_name, options)
            logger.info(
                f"Plan: ctx={plan['n_ctx']} offload={plan['offload']} "
                f"({plan['layers_gpu']}/{plan['n_layer']} layers) kv={plan['kv_type']} "
                f"gpu~{plan['est_gpu_gb']} GB ram~{plan['est_ram_gb']} GB"
            )

            chat_handler = None
            if proj_path is not None:
                chat_handler = self._create_handler(info, proj_info, model_name, str(proj_path))
                if chat_handler is None:
                    projector_name = None
                    plan["projector_name"] = ""
                    plan.setdefault("warnings", []).append("vision_handler_missing")

            self._set_step("Loading model into memory")
            llama, used_plan, last_error = self._instantiate(str(model_path), plan, chat_handler)
            if llama is None:
                self._report_failure(info, last_error)
                return

            elapsed = round(time.time() - self.load_started, 1)
            with self.state_lock:
                self.llama = llama
                self.model_name = model_name
                self.projector_name = projector_name or ""
                self.plan = used_plan
                self.model_info = info
                self.load_seconds = elapsed
                self.load_error = None
            settings.update({"last_model": {"model": model_name, "projector": projector_name or ""}})
            logger.info(
                f"Model ready in {elapsed}s: {model_name} (context {used_plan['n_ctx']}, offload {used_plan['offload']})"
            )
        except Exception as e:
            logger.error(f"Unexpected load error: {e}\n{traceback.format_exc()}")
            self._fail("load_failed", f"{type(e).__name__}: {e}")
        finally:
            with self.state_lock:
                self.is_loading = False
                self.loading_step = ""

    def _create_handler(self, info, proj_info, model_name, proj_path):
        for class_name in vision_handler_candidates(info, proj_info, model_name):
            cls = _handler_class(class_name)
            if cls is None:
                continue
            try:
                handler = cls(clip_model_path=proj_path, verbose=False)
                logger.info(f"Vision handler: {class_name}")
                return handler
            except TypeError:
                try:
                    handler = cls(clip_model_path=proj_path)
                    logger.info(f"Vision handler: {class_name}")
                    return handler
                except Exception as e:
                    logger.warning(f"{class_name} failed: {e}")
            except Exception as e:
                logger.warning(f"{class_name} failed: {e}")
        logger.warning("No compatible vision handler in this engine version; loading as a text model")
        return None

    def _attempts(self, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Progressively safer configurations tried when the planned one fails."""
        base = dict(
            n_ctx=plan["n_ctx"],
            n_gpu_layers=plan["n_gpu_layers"],
            flash_attn=plan["flash_attn"],
            type_k=plan["type_k"],
            type_v=plan["type_v"],
            n_threads=plan["n_threads"],
        )
        attempts = [(base, plan["offload"], plan["kv_type"])]
        if plan["flash_attn"] or plan["kv_type"] != "f16":
            plain = dict(base, flash_attn=False, type_k=None, type_v=None)
            attempts.append((plain, plan["offload"], "f16"))
        if plan["layers_gpu"] > 0:
            layers = max(1, int(plan["layers_gpu"] * 0.6)) if plan["offload"] != "full" else max(1, int(plan["n_layer"] * 0.7))
            reduced = dict(base, n_ctx=max(2048, plan["n_ctx"] // 2), n_gpu_layers=layers, flash_attn=False, type_k=None, type_v=None)
            attempts.append((reduced, "partial", "f16"))
            cpu = dict(base, n_ctx=min(plan["n_ctx"], 4096), n_gpu_layers=0, flash_attn=False, type_k=None, type_v=None)
            attempts.append((cpu, "none", "f16"))
        else:
            small = dict(base, n_ctx=max(2048, plan["n_ctx"] // 2), flash_attn=False, type_k=None, type_v=None)
            attempts.append((small, "none", "f16"))
        return attempts

    def _instantiate(self, model_path: str, plan: Dict[str, Any], chat_handler):
        last_error = ""
        for number, (kwargs, offload, kv_type) in enumerate(self._attempts(plan), start=1):
            if number > 1:
                self._set_step(f"Retrying with safer settings (attempt {number})")
            call = {k: v for k, v in kwargs.items() if v is not None}
            try:
                llama = Llama(model_path=model_path, chat_handler=chat_handler, verbose=True, **call)
            except TypeError:
                for key in ("type_k", "type_v", "flash_attn"):
                    call.pop(key, None)
                try:
                    llama = Llama(model_path=model_path, chat_handler=chat_handler, verbose=True, **call)
                except Exception as e:
                    last_error = str(e)
                    logger.warning(f"Attempt {number} failed: {e}")
                    gc.collect()
                    if is_illegal_instruction(last_error):
                        break
                    continue
            except Exception as e:
                last_error = str(e)
                logger.warning(f"Attempt {number} failed: {e}")
                gc.collect()
                if is_illegal_instruction(last_error):
                    break
                continue

            used = dict(plan)
            used.update(
                n_ctx=int(call["n_ctx"]),
                n_gpu_layers=call["n_gpu_layers"],
                offload=offload,
                kv_type=kv_type,
                flash_attn=bool(call.get("flash_attn", False)),
            )
            if number > 1:
                used["warnings"] = list(plan["warnings"]) + ["fallback_settings"]
            return llama, used, ""
        return None, plan, last_error

    def _report_failure(self, info: Dict[str, Any], error: str):
        low = (error or "").lower()
        version = getattr(llama_cpp, "__version__", "unknown")
        if is_illegal_instruction(error):
            self._fail("engine_crash", error, engine=version)
        elif "out of memory" in low or "cudamalloc" in low or "failed to allocate" in low:
            self._fail("out_of_memory", error)
        else:
            self._fail("load_failed", error or "Failed to load model", arch=info.get("arch", ""), engine=version)

    def status(self) -> Dict[str, Any]:
        with self.state_lock:
            return {
                "ready": self.llama is not None,
                "model": self.model_name,
                "projector": self.projector_name,
                "plan": dict(self.plan),
                "is_loading": self.is_loading,
                "loading_model": self.loading_model,
                "loading_step": self.loading_step,
                "loading_elapsed": round(time.time() - self.load_started, 1) if self.is_loading else 0.0,
                "load_seconds": self.load_seconds,
                "load_error": self.load_error,
                "n_ctx": self.n_ctx,
                "recommended_prompt_tokens": self.recommended_prompt_tokens(),
            }


engine = Engine()


class GenerationJob:
    """Runs one streamed completion on its own thread so that cancelling never races with llama.cpp."""

    def __init__(self, llama, params: Dict[str, Any], lock: threading.Lock, loop: asyncio.AbstractEventLoop):
        self.llama = llama
        self.params = params
        self.lock = lock
        self.loop = loop
        self.cancel = threading.Event()
        self.events: "asyncio.Queue" = asyncio.Queue()

    def _emit(self, item):
        try:
            self.loop.call_soon_threadsafe(self.events.put_nowait, item)
        except RuntimeError:
            pass

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        generator = None
        try:
            with self.lock:
                if self.cancel.is_set():
                    return
                generator = self.llama.create_chat_completion(stream=True, **self.params)
                for chunk in generator:
                    if self.cancel.is_set():
                        break
                    self._emit(("chunk", chunk))
        except Exception as e:
            logger.error(f"Generation error: {e}")
            self._emit(("error", str(e)))
        finally:
            if generator is not None:
                try:
                    generator.close()
                except Exception:
                    pass
            self._emit(("done", None))
