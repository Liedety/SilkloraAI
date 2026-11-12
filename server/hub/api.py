"""HTTP layer: OpenAI-compatible endpoints for the phone app and management endpoints for the dashboard."""

import asyncio
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

from . import __version__, archs, library, settings, store
from .context import fit_messages
from .downloads import downloads
from .engine import GenerationJob, engine, engine_info
from .hardware import analyze_hardware, build_profile
from .log import logger
from .network import local_adapters
from .paths import MODELS_DIR, WEB_DIR

DEFAULT_STOP_TOKENS = [
    "USER:", "User:", "ASSISTANT:", "Assistant:",
    "\nUSER:", "\nUser:", "\n\nUSER:", "\n\nUser:",
    "\nASSISTANT:", "\nAssistant:",
    "\nПользователь:", "\nпользователь:", "\n\nПользователь:",
    "\nИгрок:", "\nигрок:", "\nВы:",
    "<用户>", "<AI>", "<end_of_turn>", "<|eot_id|>",
]

CLIENT_ACTIVE_SEC = 90
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
EXPOSED_HEADERS = ["X-Silklora-Context"]

started_at = time.time()
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
        return await call_next(request)

    # ------------------------------------------------------------------ OpenAI-compatible API

    @app.get("/health")
    @app.get("/v1/health")
    def health():
        status = engine.status()
        return {
            "status": "ok",
            "service": "SilkloraAI Local Hub",
            "version": __version__,
            "active_model": status["model"] or "none",
            "model_ready": status["ready"],
            "is_loading": status["is_loading"],
            "loading_step": status["loading_step"],
            "n_ctx": status["n_ctx"],
            "recommended_prompt_tokens": status["recommended_prompt_tokens"],
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
            "temperature": float(body.get("temperature", 0.7)),
            "top_p": float(body.get("top_p", 0.9)),
            "repeat_penalty": float(body.get("repeat_penalty", body.get("repetition_penalty", 1.12))),
            "max_tokens": max_tokens,
            "stop": stops,
        }
        for key in ("top_k", "min_p", "presence_penalty", "frequency_penalty", "seed"):
            if body.get(key) is not None:
                params[key] = body[key]

        headers = {
            "X-Silklora-Context": f"n_ctx={n_ctx}; prompt={report['prompt_tokens']}; dropped={report['dropped']}"
        }
        client = req.client.host if req.client else "unknown"
        logger.info(f"Request from {client}: {len(messages)} messages, prompt {report['prompt_tokens']}/{n_ctx} tokens, stream={stream}")

        if stream:
            job = GenerationJob(llama, params, engine.inference_lock, asyncio.get_running_loop())
            job.start()

            async def event_stream():
                try:
                    while True:
                        kind, payload = await job.events.get()
                        if kind == "chunk":
                            yield f"data: {json.dumps(payload)}\n\n"
                        elif kind == "error":
                            yield f"data: {json.dumps({'error': {'message': payload}})}\n\n"
                        else:
                            yield "data: [DONE]\n\n"
                            break
                finally:
                    job.cancel.set()

            return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

        def run_blocking():
            with engine.inference_lock:
                return llama.create_chat_completion(stream=False, **params)

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
        return {
            "version": __version__,
            "uptime_sec": int(now - started_at),
            "port": port_holder["port"],
            "engine": engine_info(),
            "model": engine.status(),
            "download": downloads.status(),
            "network": {"adapters": adapters, "primary_ip": primary},
            "phone": {"connected": bool(recent), "seconds_ago": int(now - recent[0]) if recent else None},
            "ram": {"total": mem.total, "used": mem.total - mem.available},
            "settings": settings.get_all(),
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
        try:
            engine.load_async(model, projector, {"n_ctx": data.get("n_ctx"), "n_gpu_layers": data.get("n_gpu_layers")})
        except RuntimeError:
            raise HTTPException(409, "another model is loading")
        return {"ok": True, "model": model, "projector": projector}

    @app.post("/api/models/unload")
    def unload_model():
        engine.unload()
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

    def installed_names():
        data = library.scan()
        return [m["filename"] for m in data["models"] + data["projectors"]]

    @app.get("/api/recommendations")
    async def get_recommendations(kind: str = "chat", refresh: bool = False):
        hw = analyze_hardware(fresh_gpu=True)
        try:
            return await asyncio.to_thread(store.recommendations, kind, hw, arch_check, installed_names(), refresh)
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
        if "/" not in repo_id:
            raise HTTPException(400, "repo_id is required")
        hw = analyze_hardware(fresh_gpu=False)
        try:
            result = await asyncio.to_thread(store.inspect_repo, repo_id, hw, arch_check)
        except store.StoreError as e:
            code = 404 if str(e) == "not_found" else 502
            raise HTTPException(code, str(e))
        installed = set(installed_names())
        for f in result.get("files", []):
            f["installed"] = f["local_name"] in installed
        return result

    @app.post("/api/downloads")
    async def start_download(req: Request):
        data = await req.json()
        repo_id = store.parse_repo_id(str(data.get("repo_id") or ""))
        raw_files = data.get("files") or []
        if "/" not in repo_id or not raw_files:
            raise HTTPException(400, "repo_id and files are required")
        specs = []
        for item in raw_files:
            filename = str(item.get("filename") or "")
            if not filename.lower().endswith(".gguf") or ".." in filename or filename.startswith("/"):
                raise HTTPException(400, "invalid file name")
            specs.append(
                {
                    "filename": filename,
                    "local_name": store.local_name(repo_id, filename),
                    "size_bytes": int(item.get("size_bytes") or 0),
                    "role": "projector" if item.get("role") == "projector" else "model",
                }
            )
        load_after = bool(data.get("load_after"))

        def on_complete(names):
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

    # ------------------------------------------------------------------ Dashboard: settings and diagnostics

    @app.get("/api/settings")
    def get_settings():
        return settings.get_all()

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
        return settings.update(clean)

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
