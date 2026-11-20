"""HTTP layer: OpenAI-compatible endpoints for the phone app and management endpoints for the dashboard."""

import asyncio
import inspect
import json
import os
import platform
import sys
import time
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import psutil
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, archs, assistant, library, settings, store
from .context import fit_messages
from .coordinator import coordinator
from .downloads import downloads
from .engine import GenerationJob, engine, engine_info
from .hardware import analyze_hardware, build_profile
from .image_engine import image_engine
from .log import logger
from .lora_trainer import lora_trainer
from .network import local_adapters
from .paths import DATA_DIR, IMAGE_AUX_DIR, IMAGE_MODELS_DIR, LORAS_DIR, MODELS_DIR, SCENES_DIR, WEB_DIR
from .sanitize import StreamSanitizer, extract_reasoning_and_content

DEFAULT_STOP_TOKENS = [
    "USER:", "User:", "ASSISTANT:", "Assistant:",
    "\nUSER:", "\nUser:", "\n\nUSER:", "\n\nUser:",
    "\nASSISTANT:", "\nAssistant:",
    "\n>user", "\n>fuser", "\n>assistant", "\n>model",
    "\nuser\n", "\nassistant\n", "\nfuser\n",
    "\nПользователь:", "\nпользователь:", "\n\nПользователь:",
    "\n[Собеседник:", "\n[Реплика", "\n[Пользователь:",
    "\nИгрок:", "\nигрок:", "\nВы:",
    "<用户>", "<AI>", "<end_of_turn>", "<start_of_turn>",
    "<|eot_id|>", "<|im_end|>", "<|im_start|>",
    "<|turn>user", "<|turn>system", "<turn|>",
    "\n[Заметка сцены", "\n[Scene note", "\n[Контекст хода",
]

CLIENT_ACTIVE_SEC = 90
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
EXPOSED_HEADERS = ["X-Silklora-Context"]

started_at = time.time()


def engine_setup_diagnostics() -> Dict[str, Any]:
    """Last engine selection trace written by bootstrap.py, for the dashboard and remote checks."""
    path = DATA_DIR / "setup_state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"gpu": {}, "attempts": []}
    return {
        "gpu": data.get("gpu_info") or {},
        "attempts": data.get("engine_attempts") or [],
    }
clients: Dict[str, float] = {}
port_holder = {"port": 8080}


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": code, "code": code}}, status_code=status)


def _is_local_client(host: str) -> bool:
    if host in LOOPBACK:
        return True
    return host in {a["ip"] for a in local_adapters()}


def _auto_load_last_model():
    prefs = settings.get_all()
    last = prefs.get("last_model")
    if not (prefs["auto_load_last"] and last and last.get("model")):
        return
    if not (MODELS_DIR / last["model"]).is_file() or not engine_info()["available"]:
        return
    try:
        engine.load_async(last["model"], last.get("projector") or None, {})
    except RuntimeError:
        pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Timer(1.0, _auto_load_last_model).start()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="SilkloraAI Local AI Hub", version=__version__, docs_url=None, redoc_url=None, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=EXPOSED_HEADERS,
    )

    allow_remote_dashboard = os.environ.get("SILKLORA_ALLOW_REMOTE_DASHBOARD") == "1"

    @app.middleware("http")
    async def access_policy(request: Request, call_next):
        path = request.url.path
        host = request.client.host if request.client else ""
        management = path == "/" or path.startswith("/api/") or path.startswith("/static/")
        if management and not allow_remote_dashboard and not _is_local_client(host):
            return _error(403, "local_only", "The dashboard is available only on the computer running the server.")
        if (path in ("/health", "/v1/health") or path.startswith("/v1/")) and host not in LOOPBACK:
            clients[host] = time.time()
        response = await call_next(request)
        if path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # ------------------------------------------------------------------ OpenAI-compatible API

    @app.get("/health")
    @app.get("/v1/health")
    def health():
        status = engine.status()
        coord = coordinator.status()
        img_eng = image_engine.engine_status()
        return {
            "status": "ok",
            "service": "SilkloraAI Local Hub",
            "version": __version__,
            "active_model": status["model"] or "none",
            "model_ready": status["ready"],
            "is_loading": status["is_loading"],
            "loading_step": status["loading_step"],
            "loading_progress": status.get("loading_progress", 0.0),
            "loading_elapsed": status.get("loading_elapsed", 0.0),
            "n_ctx": status["n_ctx"],
            "recommended_prompt_tokens": status["recommended_prompt_tokens"],
            "engine_gpu_offload": bool(engine_info().get("gpu_offload")),
            "engine_setup": engine_setup_diagnostics(),
            "coordinator": coord,
            "image_engine": {
                "preferred_backend": img_eng["preferred_backend"],
                "sdcpp_installed": img_eng["sdcpp"]["installed"],
                "image_model": settings.get_all().get("image_model") or "",
                "is_busy": img_eng["is_busy"],
                "active_job": img_eng.get("active_job"),
            },
            "uptime_sec": int(time.time() - started_at),
        }

    @app.get("/v1/models")
    def list_models():
        status = engine.status()
        model_id = status["model"] or "silklora-local-model"
        plan = status["plan"]
        return {
            "object": "list",
            "data": [
                {
                    "id": model_id,
                    "object": "model",
                    "created": int(started_at),
                    "owned_by": "silklora-local",
                    "loaded": status["ready"],
                    "context_length": status["n_ctx"],
                    "recommended_prompt_tokens": status["recommended_prompt_tokens"],
                    "vision": bool(status["projector"]),
                    "offload": plan.get("offload", ""),
                }
            ],
        }

    @app.post("/v1/chat/completions")
    async def chat_completions(req: Request):
        try:
            body = await req.json()
        except Exception:
            return _error(400, "invalid_json", "Request body must be JSON.")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return _error(400, "invalid_request", "messages must be a non-empty list.")

        is_bg = req.headers.get("x-silklora-background", "").strip().lower() in ("1", "true", "yes")
        llama = engine.llama
        if llama is None:
            coord_state = await asyncio.to_thread(coordinator.ensure_llm_for_chat, is_bg)
            if coord_state == "deferred":
                return _error(503, "image_mode_deferred", "Background request deferred while Image Engine is active.")
            llama = engine.llama
        elif coordinator.mode == "image" and not is_bg:
            await asyncio.to_thread(coordinator.ensure_llm_for_chat, False)
            llama = engine.llama

        if llama is None:
            message = "A model is still loading. Try again in a moment." if engine.is_loading else "No model is loaded. Open the dashboard and choose a model."
            return _error(503, "no_model", message)

        has_images = any(
            isinstance(m.get("content"), list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m["content"])
            for m in messages
            if isinstance(m, dict)
        )
        if has_images and not engine.status()["projector"]:
            return _error(
                400,
                "vision_unavailable",
                "The loaded model cannot read images. Load a vision model together with its projector file in the dashboard (Models tab, 'With images').",
            )

        n_ctx = engine.n_ctx
        stream = bool(body.get("stream", False))
        max_tokens = max(16, min(int(body.get("max_tokens") or 1024), max(256, n_ctx // 2)))

        stop = body.get("stop")
        stops = list(stop) if isinstance(stop, list) else [stop] if isinstance(stop, str) else []
        stops += [s for s in DEFAULT_STOP_TOKENS if s not in stops]

        fitted, report = await asyncio.to_thread(fit_messages, messages, n_ctx, max_tokens, engine.count_tokens)
        max_tokens = max(64, min(max_tokens, n_ctx - report["prompt_tokens"] - 16))
        if report["dropped"] or report["system_trimmed"]:
            logger.warning(
                f"Context guard: prompt {report['prompt_tokens']}/{n_ctx} tokens, "
                f"dropped {report['dropped']} old turns, system trimmed: {report['system_trimmed']}"
            )

        params: Dict[str, Any] = {
            "messages": fitted,
            "temperature": float(body.get("temperature", 0.78)),
            "top_p": float(body.get("top_p", 0.92)),
            "repeat_penalty": float(body.get("repeat_penalty", body.get("repetition_penalty", 1.12))),
            "max_tokens": max_tokens,
            "stop": stops,
        }
        optional_samplers = {
            "top_k": int(body.get("top_k", 50)),
            "min_p": float(body.get("min_p", 0.06)),
            "presence_penalty": float(body.get("presence_penalty", 0.18)),
            "frequency_penalty": float(body.get("frequency_penalty", 0.22)),
            "repeat_last_n": int(body.get("repeat_last_n", 512)),
        }
        if body.get("seed") is not None:
            optional_samplers["seed"] = body["seed"]

        try:
            sig = inspect.signature(llama.create_chat_completion)
            accepts_kwargs = any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            )
            for key, val in optional_samplers.items():
                if accepts_kwargs or key in sig.parameters:
                    params[key] = val
        except (TypeError, ValueError, AttributeError):
            for key in ("top_k", "min_p", "presence_penalty", "frequency_penalty", "seed"):
                if key in optional_samplers:
                    params[key] = optional_samplers[key]

        headers = {
            "X-Silklora-Context": f"n_ctx={n_ctx}; prompt={report['prompt_tokens']}; dropped={report['dropped']}"
        }
        client = req.client.host if req.client else "unknown"
        logger.info(f"Request from {client}: {len(messages)} messages, prompt {report['prompt_tokens']}/{n_ctx} tokens, stream={stream}")

        if stream:
            job = GenerationJob(llama, params, engine.inference_lock, asyncio.get_running_loop())
            job.start()
            sanitizer = StreamSanitizer()

            async def event_stream():
                try:
                    while True:
                        kind, payload = await job.events.get()
                        if kind == "chunk":
                            choice0 = (payload.get("choices") or [{}])[0] if isinstance(payload, dict) else {}
                            delta = choice0.get("delta") if isinstance(choice0, dict) else None
                            if isinstance(delta, dict) and (
                                isinstance(delta.get("content"), str) or bool(choice0.get("finish_reason"))
                            ):
                                content_delta = ""
                                reasoning_delta = ""
                                raw_piece = delta.get("content")
                                if isinstance(raw_piece, str) and raw_piece:
                                    content_delta, reasoning_delta = sanitizer.feed(raw_piece)
                                existing_reasoning = delta.get("reasoning_content")
                                combined_reasoning = (
                                    (existing_reasoning or "") + reasoning_delta
                                    if (existing_reasoning or reasoning_delta)
                                    else ""
                                )
                                if choice0.get("finish_reason"):
                                    tail_c, tail_r = sanitizer.finish()
                                    content_delta += tail_c
                                    if tail_r:
                                        combined_reasoning += tail_r
                                if not content_delta and not combined_reasoning and not choice0.get("finish_reason"):
                                    continue
                                new_delta = dict(delta)
                                if content_delta:
                                    new_delta["content"] = content_delta
                                else:
                                    new_delta.pop("content", None)
                                if combined_reasoning:
                                    new_delta["reasoning_content"] = combined_reasoning
                                choice0["delta"] = new_delta
                            yield f"data: {json.dumps(payload)}\n\n"
                        elif kind == "error":
                            yield f"data: {json.dumps({'error': {'message': payload}})}\n\n"
                        else:
                            tail_c, tail_r = sanitizer.finish()
                            if tail_c or tail_r:
                                tail_delta: Dict[str, Any] = {}
                                if tail_c:
                                    tail_delta["content"] = tail_c
                                if tail_r:
                                    tail_delta["reasoning_content"] = tail_r
                                flush_chunk = {
                                    "id": "chatcmpl-flush",
                                    "object": "chat.completion.chunk",
                                    "choices": [{"index": 0, "delta": tail_delta, "finish_reason": None}],
                                }
                                yield f"data: {json.dumps(flush_chunk)}\n\n"
                            yield "data: [DONE]\n\n"
                            break
                finally:
                    job.cancel.set()

            return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

        def run_blocking():
            with engine.inference_lock:
                with engine.state_lock:
                    engine.gen_started_at = time.time()
                try:
                    result = llama.create_chat_completion(stream=False, **params)
                    if isinstance(result, dict):
                        for ch in result.get("choices") or []:
                            msg = ch.get("message")
                            if isinstance(msg, dict) and isinstance(msg.get("content"), str):
                                clean_text, parsed_reasoning = extract_reasoning_and_content(msg["content"])
                                msg["content"] = clean_text
                                if parsed_reasoning:
                                    existing = (msg.get("reasoning_content") or "").strip()
                                    msg["reasoning_content"] = (
                                        f"{existing}\n\n{parsed_reasoning}".strip() if existing else parsed_reasoning
                                    )
                    return result
                finally:
                    with engine.state_lock:
                        engine.gen_started_at = 0.0

        try:
            result = await asyncio.to_thread(run_blocking)
        except Exception as e:
            logger.error(f"Inference error: {e}")
            return _error(500, "inference_error", str(e))
        return JSONResponse(result, headers=headers)

    # ------------------------------------------------------------------ Dashboard: status and hardware

    @app.get("/api/status")
    def get_status():
        adapters = local_adapters()
        primary = adapters[0]["ip"]
        mem = psutil.virtual_memory()
        now = time.time()
        recent = sorted((t for t in clients.values() if now - t < CLIENT_ACTIVE_SEC), reverse=True)
        raw_settings = settings.get_all()
        safe_settings = dict(raw_settings)
        if safe_settings.get("assistant_api_key"):
            safe_settings["assistant_api_key"] = assistant.public_config()["api_key_preview"]
        hw_cached = analyze_hardware(fresh_gpu=False)
        return {
            "version": __version__,
            "uptime_sec": int(now - started_at),
            "port": port_holder["port"],
            "engine": engine_info(),
            "engine_setup": engine_setup_diagnostics(),
            "model": engine.status(),
            "coordinator": coordinator.status(),
            "image_engine": image_engine.engine_status(),
            "lora_trainer": lora_trainer.status(hw=hw_cached),
            "download": downloads.status(),
            "network": {"adapters": adapters, "primary_ip": primary},
            "phone": {"connected": bool(recent), "seconds_ago": int(now - recent[0]) if recent else None},
            "ram": {"total": mem.total, "used": mem.total - mem.available},
            "settings": safe_settings,
        }

    @app.get("/api/hardware")
    def get_hardware():
        hw = analyze_hardware(fresh_gpu=True)
        return {"hardware": hw, "profile": build_profile(hw)}

    # ------------------------------------------------------------------ Dashboard: local models

    @app.get("/api/models")
    def get_models():
        status = engine.status()
        data = library.scan(status["model"], status["projector"])
        data["models_dir"] = str(MODELS_DIR)
        cfg = settings.get_all()
        img_lib = library.scan_image_library(cfg.get("image_model"))
        data["image_models"] = img_lib["models"]
        data["image_aux"] = img_lib["aux_files"]
        data["loras"] = img_lib["loras"]
        data["image_models_dir"] = img_lib["image_models_dir"]
        data["loras_dir"] = img_lib["loras_dir"]
        return data

    @app.get("/api/models/plan")
    def preview_plan(model: str, projector: str = ""):
        if Path(model).name != model:
            raise HTTPException(400, "invalid file name")
        if not (MODELS_DIR / model).is_file():
            raise HTTPException(404, "model not found")
        return engine.build_plan(model, projector or None, {})

    @app.post("/api/models/load")
    async def load_model(req: Request):
        data = await req.json()
        model = str(data.get("model") or "")
        projector = data.get("projector") or None
        if not model or Path(model).name != model:
            raise HTTPException(400, "model is required")
        if projector and Path(projector).name != projector:
            raise HTTPException(400, "invalid projector name")
        if projector is None and data.get("auto_projector", True):
            names = [p["filename"] for p in library.scan()["projectors"]]
            projector = library.pair_projector(model, names)
        await asyncio.to_thread(image_engine.unload)
        try:
            engine.load_async(model, projector, {"n_ctx": data.get("n_ctx"), "n_gpu_layers": data.get("n_gpu_layers")})
        except RuntimeError:
            raise HTTPException(409, "another model is loading")
        coordinator.mode = "llm"
        coordinator.saved_llm = None
        return {"ok": True, "model": model, "projector": projector}

    @app.post("/api/models/unload")
    def unload_model():
        engine.unload()
        coordinator.sync_from_engine()
        return {"ok": True}

    @app.delete("/api/models/{filename}")
    def delete_model(filename: str):
        if Path(filename).name != filename:
            raise HTTPException(400, "invalid file name")
        path = MODELS_DIR / filename
        if not path.is_file():
            raise HTTPException(404, "file not found")
        status = engine.status()
        if filename in (status["model"], status["projector"]):
            engine.unload()
        path.unlink()
        library.drop_meta(filename)
        logger.info(f"Deleted {filename}")
        return {"ok": True}

    # ------------------------------------------------------------------ Dashboard: catalog and downloads

    def arch_check(arch: str) -> Optional[bool]:
        return archs.supports_architecture(arch)

    def installed_names(kind: str = ""):
        data = library.scan()
        names = [m["filename"] for m in data["models"] + data["projectors"]]
        img = library.scan_image_library()
        img_names = [m["filename"] for m in img["models"] + img["aux_files"] + img["loras"]]
        if kind == "image":
            return img_names
        return names + img_names

    @app.get("/api/recommendations")
    async def get_recommendations(kind: str = "chat", refresh: bool = False):
        hw = analyze_hardware(fresh_gpu=True)
        try:
            return await asyncio.to_thread(store.recommendations, kind, hw, arch_check, installed_names(kind), refresh)
        except store.StoreError as e:
            raise HTTPException(502, str(e))

    @app.get("/api/hf/search")
    async def hf_search(q: str = "", kind: str = "chat"):
        query = q.strip()
        if not query:
            return {"results": []}
        if "huggingface.co/" in query:
            query = store.parse_repo_id(query).split("/")[-1]
        try:
            results = await asyncio.to_thread(store.search, query, kind, arch_check)
        except store.StoreError as e:
            raise HTTPException(502, str(e))
        return {"results": results}

    @app.post("/api/hf/inspect")
    async def hf_inspect(req: Request):
        data = await req.json()
        repo_id = store.parse_repo_id(str(data.get("repo_id") or ""))
        kind = str(data.get("kind") or "")
        if "/" not in repo_id:
            raise HTTPException(400, "repo_id is required")
        hw = analyze_hardware(fresh_gpu=False)
        try:
            result = await asyncio.to_thread(store.inspect_repo, repo_id, hw, arch_check, kind)
        except store.StoreError as e:
            code = 404 if str(e) == "not_found" else 502
            raise HTTPException(code, str(e))
        installed = set(installed_names())
        for f in result.get("files", []):
            f["installed"] = f["local_name"] in installed
        rec = result.get("recommended_download")
        if isinstance(rec, dict) and rec.get("file"):
            rec["file"]["installed"] = rec["file"].get("local_name") in installed
            all_inst = bool(rec["file"]["installed"])
            if isinstance(rec.get("projector"), dict):
                rec["projector"]["installed"] = rec["projector"].get("local_name") in installed
                all_inst = all_inst and bool(rec["projector"]["installed"])
            for c in rec.get("companions") or []:
                c["installed"] = c.get("local_name") in installed
                all_inst = all_inst and bool(c["installed"])
            rec["all_installed"] = all_inst
        return result

    @app.post("/api/downloads")
    async def start_download(req: Request):
        data = await req.json()
        repo_id = store.parse_repo_id(str(data.get("repo_id") or ""))
        raw_files = data.get("files") or []
        if "/" not in repo_id or not raw_files:
            raise HTTPException(400, "repo_id and files are required")
        allowed_exts = (".gguf", ".safetensors", ".ckpt")
        allowed_roles = {"model", "projector", "image", "vae", "clip_l", "clip_g", "t5xxl", "llm_encoder", "image_aux", "lora"}
        specs = []
        for item in raw_files:
            filename = str(item.get("filename") or "")
            if not filename.lower().endswith(allowed_exts) or ".." in filename or filename.startswith("/"):
                raise HTTPException(400, "invalid file name")
            role = str(item.get("role") or "model")
            if role not in allowed_roles:
                role = "model"
            item_repo = store.parse_repo_id(str(item.get("repo_id") or repo_id)) if item.get("repo_id") else repo_id
            custom_local = Path(str(item.get("local_name") or "")).name if item.get("local_name") else ""
            raw_url = str(item.get("url") or "").strip()
            safe_url = raw_url if raw_url.startswith("https://huggingface.co/") else ""
            spec: Dict[str, Any] = {
                "repo_id": item_repo,
                "filename": filename,
                "local_name": custom_local or store.local_name(item_repo, filename),
                "size_bytes": int(item.get("size_bytes") or 0),
                "role": role,
                "aux_role": item.get("aux_role") or (role if role in ("vae", "clip_l", "clip_g", "t5xxl", "llm_encoder") else ""),
                "trigger_word": item.get("trigger_word") or "",
            }
            if safe_url:
                spec["url"] = safe_url
            if "supports_refs" in item:
                spec["supports_refs"] = bool(item["supports_refs"])
            if item.get("family"):
                spec["family"] = str(item["family"])
            specs.append(spec)
        load_after = bool(data.get("load_after"))

        def on_complete(names):
            # Pair downloaded image companion weights & select active image model if unset
            img_specs = [s for s in specs if s["role"] == "image"]
            aux_map = {}
            for s in specs:
                if s["role"] in ("vae", "clip_l", "clip_g", "t5xxl", "llm_encoder", "image_aux"):
                    aux_key = s.get("aux_role") or s["role"]
                    if aux_key != "image_aux":
                        aux_map[aux_key] = s["local_name"]
            for s in img_specs:
                fam = library.infer_image_family(s["local_name"], {"repo": repo_id})
                library.set_meta(f"image/{s['local_name']}", {
                    "repo": repo_id,
                    "family": fam["family"],
                    "supports_refs": fam["supports_refs"],
                    "companions": aux_map,
                })
                if load_after or not settings.get_all().get("image_model"):
                    settings.update({"image_model": s["local_name"]})

            if not load_after:
                return
            model = next((s["local_name"] for s in specs if s["role"] == "model"), None)
            projector = next((s["local_name"] for s in specs if s["role"] == "projector"), None)
            if model and not engine.is_loading:
                try:
                    engine.load_async(model, projector, {})
                except RuntimeError:
                    pass

        try:
            downloads.start(repo_id, specs, on_complete)
        except RuntimeError:
            raise HTTPException(409, "another download is in progress")
        except OSError:
            raise HTTPException(507, "not enough disk space")
        return {"ok": True}

    @app.post("/api/downloads/cancel")
    def cancel_download():
        downloads.cancel()
        return {"ok": True}

    # ------------------------------------------------------------------ Image Generation, LoRA & Coordinator

    def _safe_scene_path(filename: str) -> Path:
        base = Path(filename).name
        if base != filename or ".." in base:
            raise HTTPException(400, "invalid filename")
        p = SCENES_DIR / base
        if not p.is_file():
            raise HTTPException(404, "file not found")
        return p

    @app.get("/v1/images/models")
    @app.get("/api/images/models")
    def get_image_models():
        cfg = settings.get_all()
        lib = library.scan_image_library(cfg.get("image_model"))
        return {
            **lib,
            "active_image_model": cfg.get("image_model") or "",
            "engine": image_engine.engine_status(),
            "coordinator": coordinator.status(),
        }

    @app.post("/v1/images/select")
    @app.post("/api/images/select")
    async def select_image_model(req: Request):
        data = await req.json()
        patch: Dict[str, Any] = {}
        if "model" in data:
            model = str(data.get("model") or "")
            name = Path(model).name if model else ""
            if name:
                if not (IMAGE_MODELS_DIR / name).is_file():
                    raise HTTPException(404, "image model not found")
                lib = library.scan_image_library()
                info = next((m for m in lib.get("models", []) if m["filename"] == name), None)
                if info and info.get("weight_role") == "lora":
                    raise HTTPException(
                        400,
                        f"'{name}' is a LoRA adapter, not a base image model. Move it to server/models/loras/ and select a complete base checkpoint or GGUF model.",
                    )
            patch["image_model"] = name
        if "backend" in data and data["backend"] in ("auto", "sdcpp", "comfyui", "a1111"):
            patch["image_backend"] = data["backend"]
        if "image_quality" in data and data["image_quality"] in ("fast", "balanced", "quality"):
            patch["image_quality"] = data["image_quality"]
        for key in ("image_vae", "image_clip_l", "image_clip_g", "image_t5xxl", "image_llm_encoder"):
            if key in data:
                patch[key] = Path(str(data[key])).name if data[key] else ""
        updated = settings.update(patch)
        if "image_model" in patch and not patch["image_model"]:
            await asyncio.to_thread(image_engine.unload)
        return updated

    @app.post("/v1/images/repair-companions")
    @app.post("/api/images/repair-companions")
    async def repair_image_companions(req: Request):
        body: Dict[str, Any] = {}
        try:
            body = await req.json()
        except Exception:
            pass
        cfg = settings.get_all()
        target_name = Path(str(body.get("model") or cfg.get("image_model") or "")).name
        if not target_name:
            raise HTTPException(400, "model is required")
        lib = library.scan_image_library(cfg.get("image_model"))
        info = next((m for m in lib.get("models", []) if m["filename"] == target_name), None)
        if not info:
            raise HTTPException(404, "image model not found")
        missing = list(info.get("missing_companions") or [])
        if not missing:
            return {"ok": True, "already_complete": True, "missing": []}

        comp_key = store.companion_key_for_model(info["family"], info["filename"], True, size_bytes=0)
        specs = store._DEFAULT_COMPANIONS.get(comp_key) or store._DEFAULT_COMPANIONS.get(info["family"]) or []
        dl_files = []
        for s in specs:
            if s["role"] in missing:
                dl_files.append({
                    "filename": s["filename"],
                    "repo_id": s["repo_id"],
                    "local_name": s["local_name"],
                    "url": s["url"],
                    "size_bytes": s["size_bytes"],
                    "role": s["role"],
                    "aux_role": s["role"],
                })
        if not dl_files:
            raise HTTPException(400, f"No automatic companion sources registered for family '{info['family']}' ({', '.join(missing)}).")

        def _after_repair(_names):
            cur_meta = library.get_meta(f"image/{target_name}")
            comps = dict(cur_meta.get("companions") or {})
            for item in dl_files:
                comps[item["role"]] = item["local_name"]
            library.set_meta(f"image/{target_name}", {"companions": comps})

        try:
            downloads.start(dl_files[0]["repo_id"], dl_files, on_complete=_after_repair)
        except OSError:
            raise HTTPException(507, "disk_space")
        except RuntimeError:
            raise HTTPException(409, "busy")
        return {"ok": True, "started": True, "model": target_name, "missing": missing, "files": [f["local_name"] for f in dl_files]}

    @app.post("/api/images/move-lora")
    async def move_image_to_lora(req: Request):
        data = await req.json()
        name = Path(str(data.get("filename") or "")).name
        if not name:
            raise HTTPException(400, "filename is required")
        try:
            res = library.move_image_to_lora(name)
        except FileNotFoundError:
            raise HTTPException(404, "file not found")
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        cfg = settings.get_all()
        if cfg.get("image_model") == name:
            models = library.scan_image_library().get("models", [])
            fallback = next((m["filename"] for m in models if m.get("ready_to_run")), "") or next(
                (m["filename"] for m in models if m.get("weight_role") != "lora"), ""
            )
            settings.update({"image_model": fallback})
            res["active_image_model"] = fallback
        return res

    @app.post("/api/images/move-to-image")
    async def move_lora_to_image(req: Request):
        data = await req.json()
        name = Path(str(data.get("filename") or "")).name
        if not name:
            raise HTTPException(400, "filename is required")
        try:
            res = library.move_lora_to_image(name)
        except FileNotFoundError:
            raise HTTPException(404, "file not found")
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if not settings.get_all().get("image_model"):
            settings.update({"image_model": name})
            res["active_image_model"] = name
        return res

    @app.get("/api/images/engine/status")
    def get_image_engine_status():
        return image_engine.engine_status()

    @app.post("/api/images/engine/install")
    def install_image_engine():
        return image_engine.install_sdcpp_async()

    @app.post("/v1/images/scene")
    @app.post("/v1/images/generations")
    @app.post("/api/images/generate")
    async def generate_scene_image(req: Request):
        try:
            body = await req.json()
        except Exception:
            return _error(400, "invalid_json", "Request body must be JSON.")
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return _error(400, "invalid_request", "prompt is required.")

        is_async = bool(body.get("async", False))
        model_hint = body.get("model")
        prep = await asyncio.to_thread(coordinator.prepare_for_image, model_hint)
        if is_async:
            job = image_engine.submit_job(body, wait=False)
            return JSONResponse({"ok": True, **job, "coordinator": prep})

        job = await asyncio.to_thread(image_engine.submit_job, body, True)
        if job.get("status") != "done":
            return _error(500, "image_generation_failed", job.get("error") or "Image generation failed.")
        res = job.get("result") or {}
        if req.url.path == "/v1/images/generations":
            return JSONResponse({
                "created": int(time.time()),
                "data": [{"b64_json": res.get("image_base64", "").split(",", 1)[-1], "url": res.get("image_url", "")}],
                "job": job,
                "coordinator": prep,
            })
        return JSONResponse({"ok": True, **job, "coordinator": prep})

    @app.get("/v1/images/jobs")
    @app.get("/api/images/jobs")
    def list_image_jobs():
        return {"jobs": image_engine.list_jobs(), "coordinator": coordinator.status()}

    @app.get("/v1/images/jobs/{job_id}")
    @app.get("/api/images/jobs/{job_id}")
    def get_image_job(job_id: str):
        job = image_engine.get_job(job_id)
        if not job:
            raise HTTPException(404, "job not found")
        return {**job, "coordinator": coordinator.status()}

    @app.post("/v1/images/jobs/{job_id}/cancel")
    @app.post("/api/images/jobs/{job_id}/cancel")
    async def cancel_image_job(job_id: str):
        res = await asyncio.to_thread(image_engine.cancel_job, job_id)
        if not res.get("ok"):
            raise HTTPException(404, res.get("error") or "job not found")
        return res

    @app.get("/v1/images/files/{filename}")
    @app.get("/api/images/files/{filename}")
    def serve_scene_file(filename: str):
        path = _safe_scene_path(filename)
        sfx = path.suffix.lower()
        media_type = "image/webp" if sfx == ".webp" else ("image/jpeg" if sfx in (".jpg", ".jpeg") else "image/png")
        return FileResponse(path, media_type=media_type)

    @app.post("/v1/images/unload")
    @app.post("/api/images/unload")
    async def unload_image_mode(req: Request):
        restore_llm = False
        try:
            body = await req.json()
            restore_llm = bool(body.get("restore_llm"))
        except Exception:
            pass
        out = image_engine.unload()
        if restore_llm:
            restored = await asyncio.to_thread(coordinator.force_restore_llm)
            out["coordinator"] = restored
        else:
            coordinator.sync_from_engine()
            out["coordinator"] = coordinator.status()
        return out

    @app.get("/v1/images/loras")
    @app.get("/api/images/loras")
    def list_loras():
        cfg = settings.get_all()
        lib = library.scan_image_library(cfg.get("image_model"))
        active_info = next((m for m in lib["models"] if m.get("is_active")), None)
        trainable = [
            {
                "filename": m["filename"],
                "family": m["family"],
                "variant": m.get("variant", ""),
                "is_active": bool(m.get("is_active")),
            }
            for m in lib["models"]
            if m.get("format") in ("safetensors", "ckpt")
            and m.get("family") in ("sdxl", "sd15")
            and m.get("weight_role") == "checkpoint"
        ]
        trainable_names = {t["filename"] for t in trainable}
        inference_only = [
            {
                "filename": m["filename"],
                "family": m["family"],
                "variant": m.get("variant", ""),
                "format": m.get("format", ""),
                "is_active": bool(m.get("is_active")),
            }
            for m in lib["models"]
            if m.get("weight_role") != "lora" and m["filename"] not in trainable_names
        ]
        ready_models = [
            {
                "filename": m["filename"],
                "family": m["family"],
                "variant": m.get("variant", ""),
                "format": m.get("format", ""),
                "is_active": bool(m.get("is_active")),
            }
            for m in lib["models"]
            if m.get("ready_to_run") and m.get("weight_role") != "lora"
        ]
        return {
            "loras": lib["loras"],
            "trainer": lora_trainer.status(),
            "active_image_model": (
                {
                    "filename": active_info["filename"],
                    "family": active_info["family"],
                    "variant": active_info.get("variant", ""),
                    "format": active_info.get("format", ""),
                    "ready_to_run": bool(active_info.get("ready_to_run")),
                    "missing_companions": list(active_info.get("missing_companions") or []),
                }
                if active_info
                else None
            ),
            "trainable_checkpoints": trainable,
            "inference_only_models": inference_only,
            "ready_models": ready_models,
        }

    @app.get("/v1/images/lora/status")
    @app.get("/api/images/lora/status")
    def get_lora_status():
        return lora_trainer.status()

    @app.post("/api/images/lora/install")
    def install_lora_trainer():
        return lora_trainer.install_trainer_async()

    @app.post("/v1/images/lora/train")
    @app.post("/api/images/lora/train")
    async def train_lora(req: Request):
        body = await req.json()
        await asyncio.to_thread(coordinator.prepare_for_training)
        try:
            job = lora_trainer.start_training(body)
            return {"ok": True, "job": job}
        except Exception as exc:
            return _error(400, "lora_train_error", str(exc))

    @app.delete("/api/images/models/{filename}")
    def delete_image_model(filename: str):
        if Path(filename).name != filename:
            raise HTTPException(400, "invalid filename")
        p = IMAGE_MODELS_DIR / filename
        if not p.is_file():
            raise HTTPException(404, "file not found")
        p.unlink()
        library.drop_meta(f"image/{filename}")
        if settings.get_all().get("image_model") == filename:
            settings.update({"image_model": ""})
        return {"ok": True}

    @app.delete("/api/images/aux/{filename}")
    def delete_image_aux(filename: str):
        if Path(filename).name != filename:
            raise HTTPException(400, "invalid filename")
        p = IMAGE_AUX_DIR / filename
        if not p.is_file():
            raise HTTPException(404, "file not found")
        p.unlink()
        library.drop_meta(f"image_aux/{filename}")
        return {"ok": True}

    @app.delete("/api/images/loras/{filename}")
    def delete_lora_file(filename: str):
        if Path(filename).name != filename:
            raise HTTPException(400, "invalid filename")
        p = LORAS_DIR / filename
        if not p.is_file():
            raise HTTPException(404, "file not found")
        p.unlink()
        library.drop_meta(f"loras/{filename}")
        return {"ok": True}

    # ------------------------------------------------------------------ Server AI Model-Finder Assistant

    @app.get("/api/assistant/config")
    def get_assistant_config():
        return assistant.public_config()

    @app.post("/api/assistant/config")
    async def save_assistant_config(req: Request):
        data = await req.json()
        return assistant.save_config(data)

    @app.post("/api/assistant/recommend")
    async def assistant_recommend(req: Request):
        data = await req.json()
        query = str(data.get("query") or "").strip()
        kind_hint = str(data.get("kind") or "auto")
        mode_override = str(data.get("mode") or "")
        lang = str(data.get("lang") or "ru")
        hw = analyze_hardware(fresh_gpu=True)
        try:
            return await asyncio.to_thread(assistant.recommend, query, hw, kind_hint, mode_override, lang)
        except Exception as exc:
            return _error(400, "assistant_error", str(exc))

    # ------------------------------------------------------------------ Dashboard: settings and diagnostics

    @app.get("/api/settings")
    def get_settings():
        data = dict(settings.get_all())
        if data.get("assistant_api_key"):
            data["assistant_api_key"] = assistant.public_config()["api_key_preview"]
        return data

    @app.post("/api/settings")
    async def save_settings(req: Request):
        data = await req.json()
        clean: Dict[str, Any] = {}
        if "ctx_cap" in data:
            clean["ctx_cap"] = max(2048, min(int(data["ctx_cap"]), 131072))
        if "kv_quant" in data:
            clean["kv_quant"] = bool(data["kv_quant"])
        if "auto_load_last" in data:
            clean["auto_load_last"] = bool(data["auto_load_last"])
        if "ctx_mode" in data:
            clean["ctx_mode"] = "auto" if data["ctx_mode"] in ("auto", None, "") else str(int(data["ctx_mode"]))
        if "gpu_layers_mode" in data:
            clean["gpu_layers_mode"] = "auto" if data["gpu_layers_mode"] in ("auto", None, "") else str(int(data["gpu_layers_mode"]))
        if "image_backend" in data and data["image_backend"] in ("auto", "sdcpp", "comfyui", "a1111"):
            clean["image_backend"] = data["image_backend"]
        if "image_quality" in data and data["image_quality"] in ("fast", "balanced", "quality"):
            clean["image_quality"] = data["image_quality"]
        if "image_model" in data:
            clean["image_model"] = Path(str(data["image_model"])).name if data["image_model"] else ""
        for k in ("image_vae", "image_clip_l", "image_clip_g", "image_t5xxl", "image_llm_encoder", "image_sampler", "image_low_vram", "comfyui_url", "a1111_url"):
            if k in data:
                clean[k] = str(data[k] or "").strip()
        if "image_steps" in data:
            val = int(data["image_steps"] or 0)
            clean["image_steps"] = 0 if val <= 0 else max(4, min(60, val))
        if "image_cfg" in data:
            fval = float(data["image_cfg"] or 0)
            clean["image_cfg"] = 0.0 if fval <= 0 else max(1.0, min(15.0, fval))
        if "image_width" in data:
            clean["image_width"] = max(256, min(2048, int(data["image_width"])))
        if "image_height" in data:
            clean["image_height"] = max(256, min(2048, int(data["image_height"])))
        updated = dict(settings.update(clean))
        if updated.get("assistant_api_key"):
            updated["assistant_api_key"] = assistant.public_config()["api_key_preview"]
        return updated

    @app.get("/api/logs")
    def get_logs():
        return {"logs": logger.entries()}

    @app.post("/api/logs/clear")
    def clear_logs():
        logger.clear()
        return {"ok": True}

    @app.get("/api/logs/download")
    def download_report():
        hw = analyze_hardware(fresh_gpu=True)
        profile = build_profile(hw)
        info = engine_info()
        status = engine.status()
        adapters = local_adapters()
        lib = library.scan(status["model"], status["projector"])
        gib = 1024 ** 3
        lines = [
            "SilkloraAI Local Hub - diagnostic report",
            f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            "[System]",
            f"OS: {hw['os']}",
            f"Python: {platform.python_version()} ({sys.executable})",
            f"Hub version: {__version__}",
            f"Engine: available={info['available']} backend={info['backend']} version={info['version']} {info['error']}",
            "",
            "[Hardware]",
            f"CPU: {hw['cpu']['cores']} cores / {hw['cpu']['threads']} threads ({hw['cpu']['arch']})",
            f"RAM: {hw['ram_total'] / gib:.1f} GB total, {hw['ram_available'] / gib:.1f} GB available",
            f"GPU: {hw['gpu']['name'] or 'none'} ({hw['gpu']['vram_total'] / gib:.1f} GB total, {hw['gpu']['vram_free'] / gib:.1f} GB free)",
            f"Compute capability: {hw['gpu']['compute_cap'] or 'n/a'}  Driver: {hw['gpu']['driver'] or 'n/a'}",
            f"Tier: {profile['tier']} (GPU budget {profile['gpu_budget_gb']} GB, RAM budget {profile['ram_budget_gb']} GB)",
            "",
            "[Network]",
            f"Port: {port_holder['port']}",
        ]
        lines += [f"  {a['ip']} ({a['interface']}, {a['kind']}){' primary' if a['is_primary'] else ''}" for a in adapters]
        lines += ["", "[Models]"]
        for m in lib["models"] + lib["projectors"]:
            tag = "projector" if m["is_projector"] else "model"
            lines.append(f"  {m['filename']} ({m['size_bytes'] / gib:.2f} GB, {tag}, arch={m['arch'] or '?'}){' ACTIVE' if m['is_active'] else ''}")
        lines += [
            "",
            "[Active model]",
            f"Model: {status['model'] or 'none'}  Projector: {status['projector'] or 'none'}",
            f"Plan: {json.dumps({k: v for k, v in status['plan'].items() if k != 'warnings'})}",
            f"Warnings: {status['plan'].get('warnings', [])}",
            f"Last load error: {status['load_error']}",
            "",
            "[Log]",
        ]
        lines += logger.entries()
        filename = f"silklora_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        return Response(
            "\n".join(lines),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # ------------------------------------------------------------------ Web dashboard

    @app.get("/")
    def index():
        page = WEB_DIR / "index.html"
        if not page.is_file():
            return Response("Dashboard files are missing (web/index.html).", status_code=500)
        return FileResponse(page, headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    return app
