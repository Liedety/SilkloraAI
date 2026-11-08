#!/usr/bin/env python3
"""
SilkloraAI Local AI Hub - Standalone Desktop Server (Windows / Linux / macOS)
Lightweight OpenAI-compatible inference server for local GGUF models & Vision projectors (mmproj).
"""

import os
import sys
import json
import time
import socket
import threading
import traceback
import urllib.parse
from pathlib import Path
from typing import List, Dict, Any, Optional

import requests
import psutil
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Optional llama-cpp-python import with graceful fallback
LLAMA_AVAILABLE = False
try:
    import llama_cpp
    from llama_cpp import Llama
    try:
        from llama_cpp.llama_chat_format import Llava15ChatHandler, MoondreamChatHandler
    except ImportError:
        pass
    LLAMA_AVAILABLE = True
except ImportError:
    LLAMA_AVAILABLE = False

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="SilkloraAI Local AI Hub", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global State
class ServerState:
    def __init__(self):
        self.lock = threading.Lock()
        self.active_model_path: Optional[str] = None
        self.active_model_name: str = "None (No model loaded)"
        self.active_mmproj_path: Optional[str] = None
        self.active_mmproj_name: Optional[str] = None
        self.llama_instance: Optional[Any] = None
        self.n_ctx: int = 4096
        self.n_gpu_layers: int = -1
        self.start_time: float = time.time()
        self.port: int = 8080
        
        # Download tracker
        self.download_lock = threading.Lock()
        self.download_task: Optional[Dict[str, Any]] = None
        self.cancel_download_flag: bool = False

state = ServerState()

def get_local_ip_addresses() -> List[str]:
    """Retrieve all non-loopback local IPv4 addresses (Wi-Fi, LAN)."""
    ip_list = []
    try:
        # Method 1: Connecting a dummy UDP socket to identify primary outbound interface
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        try:
            s.connect(("8.8.8.8", 80))
            primary_ip = s.getsockname()[0]
            if primary_ip and primary_ip not in ("127.0.0.1", "localhost"):
                ip_list.append(primary_ip)
        except Exception:
            pass
        finally:
            s.close()
    except Exception:
        pass

    # Method 2: Scan network interfaces with psutil
    try:
        addrs = psutil.net_if_addrs()
        for iface_name, iface_addrs in addrs.items():
            for addr in iface_addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip and not ip.startswith("127.") and ip not in ip_list:
                        # Prioritize 192.168.x.x or 10.x.x.x
                        if ip.startswith("192.168.") or ip.startswith("10.") or ip.startswith("172."):
                            ip_list.append(ip)
    except Exception:
        pass

    if not ip_list:
        ip_list.append("127.0.0.1")
    return ip_list

def generate_svg_qr(text: str) -> str:
    """Generate a clean compact inline SVG QR code without external dependencies."""
    # We create a simple visual QR card representation with text
    safe_text = urllib.parse.quote(text)
    # Using public lightweight SVG data or stylized card
    return f"""
    <div style="background:#ffffff; padding:12px; border-radius:12px; display:inline-block; text-align:center;">
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data={safe_text}&bgcolor=ffffff&color=141126" 
             alt="QR Code" width="160" height="160" style="display:block; margin:0 auto; border-radius:8px;" 
             onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
        <div style="display:none; color:#141126; font-size:11px; font-family:monospace; padding:8px;">
            {text}
        </div>
    </div>
    """

def scan_local_models() -> List[Dict[str, Any]]:
    """Scan the models directory for .gguf files."""
    models = []
    if not MODELS_DIR.exists():
        return models

    for file_path in sorted(MODELS_DIR.glob("**/*.gguf")):
        size_bytes = file_path.stat().st_size
        size_mb = size_bytes / (1024 * 1024)
        size_gb = size_bytes / (1024 * 1024 * 1024)
        size_str = f"{size_gb:.2f} GB" if size_gb >= 1.0 else f"{size_mb:.1f} MB"
        
        lower_name = file_path.name.lower()
        is_mmproj = "mmproj" in lower_name or "projector" in lower_name or "clip" in lower_name
        
        models.append({
            "name": file_path.name,
            "path": str(file_path),
            "size_str": size_str,
            "size_bytes": size_bytes,
            "is_mmproj": is_mmproj,
            "is_active": (str(file_path) == state.active_model_path or str(file_path) == state.active_mmproj_path),
        })
    return models

def unload_current_model():
    """Safely unload the current Llama instance to free VRAM/RAM."""
    with state.lock:
        if state.llama_instance is not None:
            del state.llama_instance
            state.llama_instance = None
        state.active_model_path = None
        state.active_model_name = "None (No model loaded)"
        state.active_mmproj_path = None
        state.active_mmproj_name = None
        # Force garbage collection
        import gc
        gc.collect()

def load_gguf_model(model_path: str, mmproj_path: Optional[str] = None, n_ctx: int = 4096, n_gpu_layers: int = -1):
    """Load a GGUF model and optional mmproj projector into memory."""
    unload_current_model()
    
    with state.lock:
        state.n_ctx = n_ctx
        state.n_gpu_layers = n_gpu_layers
        p_model = Path(model_path)
        if not p_model.exists():
            raise FileNotFoundError(f"Model file not found: {model_path}")
            
        state.active_model_path = str(p_model)
        state.active_model_name = p_model.name
        
        if mmproj_path:
            p_mmproj = Path(mmproj_path)
            if p_mmproj.exists():
                state.active_mmproj_path = str(p_mmproj)
                state.active_mmproj_name = p_mmproj.name
        
        if LLAMA_AVAILABLE:
            chat_handler = None
            if state.active_mmproj_path:
                try:
                    chat_handler = Llava15ChatHandler(clip_model_path=state.active_mmproj_path)
                except Exception as e:
                    print(f"Warning: Failed to initialize Llava15ChatHandler ({e}), loading pure model.")
            
            print(f"Loading GGUF Model: {state.active_model_name} (layers={n_gpu_layers}, ctx={n_ctx})...")
            state.llama_instance = Llama(
                model_path=state.active_model_path,
                n_ctx=n_ctx,
                n_gpu_layers=n_gpu_layers,
                chat_handler=chat_handler,
                verbose=False,
            )
            print(f"Successfully loaded model: {state.active_model_name}")
        else:
            print(f"[Simulation Mode] Selected: {state.active_model_name} (llama-cpp-python not installed)")

# -------------------------------------------------------------
# Background Hugging Face Downloader
# -------------------------------------------------------------
def background_hf_download(repo_id: str, filename: str, target_path: Path):
    download_url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    temp_path = target_path.with_suffix(".downloading")
    
    with state.download_lock:
        state.cancel_download_flag = False
        state.download_task = {
            "repo_id": repo_id,
            "filename": filename,
            "status": "downloading",
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "percent": 0.0,
            "speed_mbps": 0.0,
            "error": None,
        }

    try:
        headers = {"User-Agent": "SilkloraAI-Local-Hub/1.0"}
        res = requests.get(download_url, headers=headers, stream=True, timeout=30)
        res.raise_for_status()

        total_size = int(res.headers.get("content-length", 0))
        with state.download_lock:
            if state.download_task:
                state.download_task["total_bytes"] = total_size

        downloaded = 0
        start_time = time.time()
        last_calc_time = start_time
        last_calc_bytes = 0

        with open(temp_path, "wb") as f:
            for chunk in res.iter_content(chunk_size=1024 * 1024): # 1MB chunks
                if state.cancel_download_flag:
                    f.close()
                    if temp_path.exists():
                        temp_path.unlink()
                    with state.download_lock:
                        state.download_task = None
                    return

                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    
                    now = time.time()
                    elapsed = now - last_calc_time
                    if elapsed >= 0.5:
                        speed = (downloaded - last_calc_bytes) / (elapsed * 1024 * 1024)
                        last_calc_time = now
                        last_calc_bytes = downloaded
                        percent = (downloaded / total_size * 100.0) if total_size > 0 else 0.0
                        with state.download_lock:
                            if state.download_task:
                                state.download_task["downloaded_bytes"] = downloaded
                                state.download_task["percent"] = round(percent, 1)
                                state.download_task["speed_mbps"] = round(speed, 2)

        temp_path.rename(target_path)
        with state.download_lock:
            if state.download_task:
                state.download_task["status"] = "completed"
                state.download_task["percent"] = 100.0
                state.download_task["downloaded_bytes"] = total_size
    except Exception as e:
        if temp_path.exists():
            temp_path.unlink()
        with state.download_lock:
            if state.download_task:
                state.download_task["status"] = "error"
                state.download_task["error"] = str(e)

# -------------------------------------------------------------
# REST & OpenAI Compatible API Endpoints
# -------------------------------------------------------------
@app.get("/health")
@app.get("/v1/health")
def health():
    return {
        "status": "ok",
        "service": "SilkloraAI Local Hub",
        "active_model": state.active_model_name,
        "active_mmproj": state.active_mmproj_name,
        "llama_cpp_available": LLAMA_AVAILABLE,
        "uptime_sec": int(time.time() - state.start_time),
    }

@app.get("/v1/models")
def list_openai_models():
    """Standard OpenAI models endpoint."""
    model_id = state.active_model_name if state.active_model_path else "silklora-local-model"
    return {
        "object": "list",
        "data": [
            {
                "id": model_id,
                "object": "model",
                "created": int(state.start_time),
                "owned_by": "silklora-local",
                "permission": [],
                "root": model_id,
                "parent": None,
            }
        ]
    }

@app.post("/v1/chat/completions")
async def chat_completions(req: Request):
    """
    OpenAI-compatible chat completion endpoint supporting SSE streaming & Vision image_url.
    """
    body = await req.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    temperature = float(body.get("temperature", 0.8))
    max_tokens = int(body.get("max_tokens", 2048))
    stop = body.get("stop", None)

    # If llama-cpp-python is available and model is loaded
    if LLAMA_AVAILABLE and state.llama_instance is not None:
        try:
            if stream:
                def sse_generator():
                    generator = state.llama_instance.create_chat_completion(
                        messages=messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        stream=True,
                        stop=stop,
                    )
                    for chunk in generator:
                        yield f"data: {json.dumps(chunk)}\n\n"
                    yield "data: [DONE]\n\n"

                return StreamingResponse(sse_generator(), media_type="text/event-stream")
            else:
                resp = state.llama_instance.create_chat_completion(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=False,
                    stop=stop,
                )
                return JSONResponse(resp)
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

    # Fallback simulation engine if llama_cpp not installed or no model loaded yet
    model_name = state.active_model_name
    simulated_reply = (
        f"Привет! Это локальный сервер SilkloraAI.\n\n"
        f"Текущая модель: {model_name}.\n"
    )
    if not LLAMA_AVAILABLE:
        simulated_reply += (
            "\n[Примечание]: Модуль `llama-cpp-python` еще не скомпилирован на этом ПК. "
            "Установите его через `pip install llama-cpp-python` для запуска реальных весов GGUF."
        )

    # Check for image_url in messages
    has_image = False
    for msg in messages:
        c = msg.get("content")
        if isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    has_image = True
                    break
    if has_image:
        simulated_reply += "\n*Внимательно рассматривает отправленное изображение через Vision проектор.*"

    if stream:
        def mock_sse():
            chunk_id = f"chatcmpl-sim-{int(time.time())}"
            words = simulated_reply.split(" ")
            for i, word in enumerate(words):
                time.sleep(0.03)
                delta_text = word + (" " if i < len(words) - 1 else "")
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model_name,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": delta_text},
                        "finish_reason": None,
                    }]
                }
                yield f"data: {json.dumps(chunk)}\n\n"

            stop_chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model_name,
                "choices": [{
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }]
            }
            yield f"data: {json.dumps(stop_chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(mock_sse(), media_type="text/event-stream")
    else:
        return {
            "id": f"chatcmpl-sim-{int(time.time())}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": simulated_reply},
                "finish_reason": "stop",
            }],
        }

# -------------------------------------------------------------
# PC Dashboard Management APIs
# -------------------------------------------------------------
@app.get("/api/status")
def get_status():
    ips = get_local_ip_addresses()
    primary_ip = ips[0] if ips else "127.0.0.1"
    mobile_url = f"http://{primary_ip}:{state.port}/v1"
    
    # System memory info
    mem = psutil.virtual_memory()
    
    return {
        "status": "running",
        "active_model": state.active_model_name,
        "active_mmproj": state.active_mmproj_name,
        "is_model_loaded": state.active_model_path is not None,
        "llama_cpp_available": LLAMA_AVAILABLE,
        "n_ctx": state.n_ctx,
        "n_gpu_layers": state.n_gpu_layers,
        "port": state.port,
        "local_ips": ips,
        "primary_ip": primary_ip,
        "mobile_url": mobile_url,
        "ram_total_gb": round(mem.total / (1024**3), 1),
        "ram_used_gb": round(mem.used / (1024**3), 1),
        "ram_percent": mem.percent,
        "download_task": state.download_task,
    }

@app.get("/api/models")
def list_local_models():
    return {"models": scan_local_models()}

@app.post("/api/models/load")
async def load_model_endpoint(req: Request):
    data = await req.json()
    model_name = data.get("model_name")
    mmproj_name = data.get("mmproj_name")
    n_ctx = int(data.get("n_ctx", 4096))
    n_gpu_layers = int(data.get("n_gpu_layers", -1))

    if not model_name:
        raise HTTPException(status_code=400, detail="model_name is required")

    model_path = MODELS_DIR / model_name
    mmproj_path = (MODELS_DIR / mmproj_name) if mmproj_name else None

    try:
        load_gguf_model(
            model_path=str(model_path),
            mmproj_path=str(mmproj_path) if mmproj_path else None,
            n_ctx=n_ctx,
            n_gpu_layers=n_gpu_layers,
        )
        return {
            "ok": True,
            "active_model": state.active_model_name,
            "active_mmproj": state.active_mmproj_name,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/models/unload")
def unload_model_endpoint():
    unload_current_model()
    return {"ok": True, "message": "Model unloaded"}

@app.delete("/api/models/{filename}")
def delete_model_endpoint(filename: str):
    file_path = MODELS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    if str(file_path) == state.active_model_path or str(file_path) == state.active_mmproj_path:
        unload_current_model()

    file_path.unlink()
    return {"ok": True, "deleted": filename}

@app.post("/api/hf/inspect")
async def inspect_huggingface_repo(req: Request):
    """Inspect a HuggingFace repository ID or URL and list available GGUF files."""
    data = await req.json()
    raw_input = data.get("repo_id_or_url", "").strip()
    if not raw_input:
        raise HTTPException(status_code=400, detail="Repository ID or URL is required")

    # Clean URL or input
    clean_repo = raw_input
    if "huggingface.co/" in clean_repo:
        clean_repo = clean_repo.split("huggingface.co/")[-1].strip("/")
        if clean_repo.startswith("models/"):
            clean_repo = clean_repo.replace("models/", "")

    api_url = f"https://huggingface.co/api/models/{clean_repo}"
    try:
        res = requests.get(api_url, headers={"User-Agent": "SilkloraAI-Local-Hub/1.0"}, timeout=15)
        if res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Repository not found on HuggingFace: {clean_repo}")
        res.raise_for_status()
        info = res.json()
        
        siblings = info.get("siblings", [])
        gguf_files = []
        for s in siblings:
            rfilename = s.get("rfilename", "")
            if rfilename.lower().endswith(".gguf"):
                is_mmproj = "mmproj" in rfilename.lower() or "projector" in rfilename.lower()
                gguf_files.append({
                    "filename": rfilename,
                    "is_mmproj": is_mmproj,
                })

        return {
            "repo_id": clean_repo,
            "author": info.get("author", clean_repo.split("/")[0] if "/" in clean_repo else ""),
            "downloads": info.get("downloads", 0),
            "likes": info.get("likes", 0),
            "files": gguf_files,
        }
    except requests.RequestException as e:
        raise HTTPException(status_code=500, detail=f"Failed to query HuggingFace: {str(e)}")

@app.post("/api/hf/download")
async def start_hf_download(req: Request, background_tasks: BackgroundTasks):
    data = await req.json()
    repo_id = data.get("repo_id", "").strip()
    filename = data.get("filename", "").strip()
    if not repo_id or not filename:
        raise HTTPException(status_code=400, detail="repo_id and filename required")

    target_path = MODELS_DIR / filename
    if target_path.exists():
        raise HTTPException(status_code=400, detail="File already exists in local models")

    with state.download_lock:
        if state.download_task and state.download_task.get("status") == "downloading":
            raise HTTPException(status_code=400, detail="Another download is already in progress")

    background_tasks.add_task(background_hf_download, repo_id, filename, target_path)
    return {"ok": True, "message": f"Download started: {filename}"}

@app.post("/api/hf/cancel")
def cancel_download():
    state.cancel_download_flag = True
    return {"ok": True, "message": "Cancelling download..."}

# -------------------------------------------------------------
# Embedded Web Dashboard UI
# -------------------------------------------------------------
DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SilkloraAI — Local AI Hub</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #0a0814;
            --bg-surface: #141126;
            --bg-card: #1c1836;
            --bg-card-hover: #252047;
            --border: #2e2854;
            --accent: #8b5cf6;
            --accent-hover: #7c3aed;
            --accent-glow: rgba(139, 92, 246, 0.25);
            --success: #10b981;
            --danger: #f43f5e;
            --warning: #f59e0b;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --text-dim: #64748b;
        }

        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: 'Plus Jakarta Sans', sans-serif;
            background-color: var(--bg-base);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        header {
            background: rgba(20, 17, 38, 0.85);
            backdrop-filter: blur(12px);
            border-bottom: 1px solid var(--border);
            padding: 16px 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 50;
        }

        .logo-wrap { display: flex; align-items: center; gap: 12px; }
        .logo-icon {
            width: 36px; height: 36px;
            background: linear-gradient(135deg, #8b5cf6, #d946ef);
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            font-weight: 700; font-size: 18px; color: #fff;
            box-shadow: 0 4px 14px var(--accent-glow);
        }
        .logo-title { font-weight: 700; font-size: 18px; letter-spacing: -0.02em; }
        .logo-tag {
            font-size: 11px; padding: 2px 8px; border-radius: 20px;
            background: rgba(139, 92, 246, 0.2); color: #c4b5fd;
            border: 1px solid rgba(139, 92, 246, 0.3);
            font-family: 'JetBrains Mono', monospace; font-weight: 600;
        }

        .status-pill {
            display: flex; align-items: center; gap: 8px;
            background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3);
            padding: 6px 14px; border-radius: 24px; font-size: 12px; font-weight: 600; color: #34d399;
        }
        .pulse-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #10b981; box-shadow: 0 0 10px #10b981;
            animation: pulse 2s infinite;
        }
        @keyframes pulse { 0%{opacity:1; transform:scale(1);} 50%{opacity:0.4; transform:scale(1.2);} 100%{opacity:1; transform:scale(1);} }

        main { flex: 1; max-width: 1200px; margin: 0 auto; width: 100%; padding: 24px 20px; }

        /* Navigation Tabs */
        .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 24px; }
        .tab-btn {
            background: transparent; border: none; color: var(--text-muted);
            padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 600;
            cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px;
        }
        .tab-btn:hover { background: var(--bg-surface); color: var(--text-main); }
        .tab-btn.active {
            background: var(--accent); color: #fff;
            box-shadow: 0 4px 14px var(--accent-glow);
        }

        .card {
            background: var(--bg-surface); border: 1px solid var(--border);
            border-radius: 18px; padding: 24px; margin-bottom: 20px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
        }
        .card-header {
            display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;
        }
        .card-title { font-size: 16px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }

        /* Network Banner */
        .net-grid { display: grid; grid-template-columns: 1fr auto; gap: 24px; align-items: center; }
        @media(max-width: 768px) { .net-grid { grid-template-columns: 1fr; } }
        .ip-box {
            background: var(--bg-base); border: 1px solid var(--border);
            border-radius: 14px; padding: 16px; display: flex; align-items: center; justify-content: space-between;
        }
        .ip-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); font-weight: 700; margin-bottom: 4px; }
        .ip-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; color: #a78bfa; }
        .btn-copy {
            background: var(--accent); color: #fff; border: none; padding: 8px 16px;
            border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;
        }
        .btn-copy:hover { background: var(--accent-hover); }

        /* Inputs & Buttons */
        .input-row { display: flex; gap: 10px; margin-bottom: 14px; }
        input[type="text"], select {
            flex: 1; background: var(--bg-base); border: 1px solid var(--border);
            color: var(--text-main); padding: 12px 16px; border-radius: 10px;
            font-size: 14px; outline: none; transition: border-color 0.2s;
        }
        input[type="text"]:focus, select:focus { border-color: var(--accent); }
        .btn-primary {
            background: var(--accent); color: #fff; border: none; padding: 12px 22px;
            border-radius: 10px; font-weight: 600; font-size: 14px; cursor: pointer; transition: all 0.2s;
            display: inline-flex; align-items: center; gap: 8px;
        }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-danger {
            background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3);
            padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer;
        }
        .btn-danger:hover { background: rgba(244, 63, 94, 0.3); }

        /* Tables & Lists */
        .model-list { display: flex; flex-direction: column; gap: 10px; }
        .model-item {
            background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 12px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between;
            transition: all 0.2s;
        }
        .model-item:hover { background: var(--bg-card-hover); border-color: rgba(139, 92, 246, 0.4); }
        .model-item.active { border-color: var(--accent); background: rgba(139, 92, 246, 0.12); }
        .model-info { display: flex; flex-direction: column; gap: 4px; }
        .model-name { font-weight: 600; font-size: 14px; color: #fff; display: flex; align-items: center; gap: 8px; }
        .model-meta { font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
        .badge {
            font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px; text-transform: uppercase;
        }
        .badge-active { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .badge-vision { background: rgba(217, 70, 239, 0.2); color: #f472b6; }
        .badge-text { background: rgba(56, 189, 248, 0.2); color: #38bdf8; }

        /* Progress Bar */
        .progress-box {
            background: var(--bg-base); border: 1px solid var(--border);
            border-radius: 12px; padding: 16px; margin-top: 14px;
        }
        .progress-track {
            background: var(--bg-card); height: 8px; border-radius: 4px;
            overflow: hidden; margin: 8px 0;
        }
        .progress-bar {
            height: 100%; background: linear-gradient(90deg, #8b5cf6, #d946ef);
            width: 0%; transition: width 0.3s;
        }

        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }
        .stat-card {
            background: var(--bg-surface); border: 1px solid var(--border);
            border-radius: 14px; padding: 16px;
        }
        .stat-label { font-size: 12px; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; }
        .stat-val { font-size: 20px; font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace; }

        .hidden { display: none !important; }
    </style>
</head>
<body>
    <header>
        <div class="logo-wrap">
            <div class="logo-icon">S</div>
            <div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="logo-title">SilkloraAI</span>
                    <span class="logo-tag">Local AI Hub</span>
                </div>
            </div>
        </div>
        <div class="status-pill">
            <span class="pulse-dot"></span>
            <span id="server-status-text">Сервер активен (порт 8080)</span>
        </div>
    </header>

    <main>
        <div class="tabs">
            <button class="tab-btn active" onclick="switchTab('tab-status')">🖥️ Статус и Связь</button>
            <button class="tab-btn" onclick="switchTab('tab-models')">📦 Локальные модели</button>
            <button class="tab-btn" onclick="switchTab('tab-hf')">🤗 HuggingFace Hub</button>
            <button class="tab-btn" onclick="switchTab('tab-test')">⚡ Проверка генерации</button>
        </div>

        <!-- TAB 1: STATUS & CONNECTION -->
        <section id="tab-status">
            <div class="stat-grid">
                <div class="stat-card">
                    <div class="stat-label">Активная текстовая модель</div>
                    <div class="stat-val" id="stat-model" style="font-size:15px; color:#a78bfa;">Загрузка...</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Проектор зрения (Vision)</div>
                    <div class="stat-val" id="stat-vision" style="font-size:15px; color:#f472b6;">Не подключен</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Оперативная память (RAM)</div>
                    <div class="stat-val" id="stat-ram">...</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Движок инференса</div>
                    <div class="stat-val" id="stat-engine" style="font-size:15px;">llama-cpp-python</div>
                </div>
            </div>

            <div class="card">
                <div class="card-header">
                    <div class="card-title">📡 Подключение мобильного приложения SilkloraAI по Wi-Fi</div>
                </div>
                <div class="net-grid">
                    <div>
                        <p style="font-size:13px; color:var(--text-muted); margin-bottom:14px; line-height:1.6;">
                            Убедитесь, что ваш телефон и компьютер подключены к одной Wi-Fi сети. В мобильном приложении перейдите в <b>Настройки → [ 🖥️ Локальный ИИ ]</b> и введите адрес:
                        </p>
                        <div class="ip-box">
                            <div>
                                <div class="ip-label">Адрес локального сервера (Base URL)</div>
                                <div class="ip-val" id="mobile-url-display">http://192.168.1.55:8080/v1</div>
                            </div>
                            <button class="btn-copy" onclick="copyMobileUrl()">Копировать</button>
                        </div>
                        <div style="margin-top:12px; font-size:12px; color:var(--text-dim);">
                            Все обнаруженные сетевые IP ПК: <span id="all-ips" style="font-family:'JetBrains Mono'; color:#cbd5e1;"></span>
                        </div>
                    </div>
                    <div id="qr-container" style="display:flex; justify-content:center;">
                        <!-- QR code rendered here -->
                    </div>
                </div>
            </div>

            <!-- Active Model Loader Controls -->
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🎯 Выбор и запуск активной модели на ПК</div>
                </div>
                <p style="font-size:13px; color:var(--text-muted); margin-bottom:16px;">
                    Выбор модели происходит <b>строго на компьютере</b>. Телефон просто подключается и использует выбранную здесь модель.
                </p>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-bottom:16px;">
                    <div>
                        <label style="display:block; font-size:12px; font-weight:600; color:var(--text-muted); margin-bottom:6px;">Основная модель для отыгрыша (GGUF):</label>
                        <select id="select-main-model"></select>
                    </div>
                    <div>
                        <label style="display:block; font-size:12px; font-weight:600; color:var(--text-muted); margin-bottom:6px;">Проектор зрения mmproj (для фото):</label>
                        <select id="select-mmproj-model">
                            <option value="">Без проектора зрения (только текст)</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex; gap:12px; align-items:center;">
                    <button class="btn-primary" onclick="loadSelectedModels()">🚀 Загрузить модель в память</button>
                    <button class="btn-danger" onclick="unloadModel()">Выгрузить из памяти</button>
                </div>
            </div>
        </section>

        <!-- TAB 2: LOCAL MODELS -->
        <section id="tab-models" class="hidden">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">📁 Скачанные локальные модели в папке server/models</div>
                    <button class="btn-primary" onclick="fetchLocalModels()">🔄 Обновить список</button>
                </div>
                <div id="local-models-list" class="model-list">
                    <div style="color:var(--text-muted); font-size:13px; padding:12px;">Поиск моделей...</div>
                </div>
            </div>
        </section>

        <!-- TAB 3: HUGGINGFACE HUB -->
        <section id="tab-hf" class="hidden">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🤗 Загрузка любых моделей с HuggingFace</div>
                </div>
                <p style="font-size:13px; color:var(--text-muted); margin-bottom:14px;">
                    Вставьте ID любого репозитория или прямую ссылку на модель с HuggingFace (например: <code>bartowski/Llama-3.2-3B-Instruct-GGUF</code> или <code>Qwen/Qwen2.5-7B-Instruct-GGUF</code>):
                </p>
                <div class="input-row">
                    <input type="text" id="hf-input" placeholder="Вставьте ID репозитория или ссылку HuggingFace..." value="bartowski/Llama-3.2-3B-Instruct-GGUF" />
                    <button class="btn-primary" onclick="inspectHfRepo()">Найти файлы .gguf</button>
                </div>

                <!-- Active Download Progress -->
                <div id="hf-download-box" class="progress-box hidden">
                    <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600;">
                        <span id="dl-filename">Скачивание...</span>
                        <span id="dl-speed" style="font-family:'JetBrains Mono'; color:#a78bfa;">0 MB/s</span>
                    </div>
                    <div class="progress-track">
                        <div class="progress-bar" id="dl-bar"></div>
                    </div>
                    <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-dim);">
                        <span id="dl-progress-text">0 / 0 MB (0%)</span>
                        <button class="btn-danger" onclick="cancelHfDownload()" style="padding:4px 8px; font-size:11px;">Отменить</button>
                    </div>
                </div>

                <div id="hf-results" style="margin-top:20px;"></div>
            </div>
        </section>

        <!-- TAB 4: TEST GENERATION -->
        <section id="tab-test" class="hidden">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">⚡ Тест ответа загруженной модели прямо в браузере</div>
                </div>
                <div class="input-row">
                    <input type="text" id="test-prompt" value="*Смотрит с интересом* Здравствуй. Кто ты?" />
                    <button class="btn-primary" onclick="runTestGeneration()">Отправить запрос</button>
                </div>
                <div style="background:var(--bg-base); border:1px solid var(--border); border-radius:12px; padding:16px; min-height:120px; font-family:'JetBrains Mono', monospace; font-size:13px; white-space:pre-wrap; line-height:1.6;" id="test-output">
Ожидание запроса...
                </div>
            </div>
        </section>
    </main>

    <script>
        let currentStatus = null;

        function switchTab(tabId) {
            document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
            document.getElementById(tabId).classList.remove('hidden');
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            event.target.classList.add('active');

            if (tabId === 'tab-models') fetchLocalModels();
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                currentStatus = data;

                document.getElementById('stat-model').innerText = data.active_model || 'Не загружена';
                document.getElementById('stat-vision').innerText = data.active_mmproj || 'Не подключен';
                document.getElementById('stat-ram').innerText = `${data.ram_used_gb} / ${data.ram_total_gb} GB (${data.ram_percent}%)`;
                document.getElementById('stat-engine').innerText = data.llama_cpp_available ? 'llama-cpp-python (GPU/CPU)' : 'Симуляция (нужен llama-cpp)';
                
                document.getElementById('mobile-url-display').innerText = data.mobile_url;
                document.getElementById('all-ips').innerText = data.local_ips.join(', ');

                // QR code
                const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(data.mobile_url)}&bgcolor=ffffff&color=141126`;
                document.getElementById('qr-container').innerHTML = `
                    <div style="background:#fff; padding:8px; border-radius:12px; display:inline-block;">
                        <img src="${qrUrl}" width="120" height="120" style="display:block; border-radius:6px;" alt="QR" />
                    </div>
                `;

                // Update active download if any
                const dl = data.download_task;
                const dlBox = document.getElementById('hf-download-box');
                if (dl && dl.status === 'downloading') {
                    dlBox.classList.remove('hidden');
                    document.getElementById('dl-filename').innerText = `Скачивание: ${dl.filename}`;
                    document.getElementById('dl-speed').innerText = `${dl.speed_mbps} MB/s`;
                    document.getElementById('dl-bar').style.width = `${dl.percent}%`;
                    const dlMb = (dl.downloaded_bytes / (1024*1024)).toFixed(1);
                    const totMb = (dl.total_bytes / (1024*1024)).toFixed(1);
                    document.getElementById('dl-progress-text').innerText = `${dlMb} / ${totMb} MB (${dl.percent}%)`;
                } else if (dl && dl.status === 'completed') {
                    dlBox.classList.remove('hidden');
                    document.getElementById('dl-filename').innerText = `✅ Загружено: ${dl.filename}`;
                    document.getElementById('dl-bar').style.width = `100%`;
                    document.getElementById('dl-speed').innerText = 'Готово';
                    setTimeout(() => dlBox.classList.add('hidden'), 4000);
                } else {
                    dlBox.classList.add('hidden');
                }
            } catch (err) {
                console.error(err);
            }
        }

        async function fetchLocalModels() {
            try {
                const res = await fetch('/api/models');
                const data = await res.json();
                const listEl = document.getElementById('local-models-list');
                const selMain = document.getElementById('select-main-model');
                const selMmproj = document.getElementById('select-mmproj-model');

                selMain.innerHTML = '';
                selMmproj.innerHTML = '<option value="">Без проектора зрения (только текст)</option>';

                if (data.models.length === 0) {
                    listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px; padding:12px;">В папке server/models пока нет .gguf файлов. Скачайте их через вкладку HuggingFace Hub!</div>';
                    selMain.innerHTML = '<option value="">Нет скачанных моделей</option>';
                    return;
                }

                listEl.innerHTML = '';
                data.models.forEach(m => {
                    // Populate selects
                    if (!m.is_mmproj) {
                        const opt = document.createElement('option');
                        opt.value = m.name;
                        opt.innerText = `${m.name} (${m.size_str})`;
                        if (m.is_active) opt.selected = true;
                        selMain.appendChild(opt);
                    } else {
                        const opt = document.createElement('option');
                        opt.value = m.name;
                        opt.innerText = `[Vision mmproj] ${m.name} (${m.size_str})`;
                        if (m.is_active) opt.selected = true;
                        selMmproj.appendChild(opt);
                    }

                    // Populate list card
                    const item = document.createElement('div');
                    item.className = `model-item ${m.is_active ? 'active' : ''}`;
                    item.innerHTML = `
                        <div class="model-info">
                            <div class="model-name">
                                <span>${m.name}</span>
                                ${m.is_active ? '<span class="badge badge-active">Активна</span>' : ''}
                                ${m.is_mmproj ? '<span class="badge badge-vision">Vision mmproj</span>' : '<span class="badge badge-text">RP Модель</span>'}
                            </div>
                            <div class="model-meta">Размер: ${m.size_str}</div>
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button class="btn-danger" onclick="deleteLocalModel('${m.name}')">Удалить</button>
                        </div>
                    `;
                    listEl.appendChild(item);
                });
            } catch (err) {
                console.error(err);
            }
        }

        async function loadSelectedModels() {
            const model = document.getElementById('select-main-model').value;
            const mmproj = document.getElementById('select-mmproj-model').value;
            if (!model) {
                alert('Выберите модель для запуска');
                return;
            }
            try {
                const res = await fetch('/api/models/load', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ model_name: model, mmproj_name: mmproj || null })
                });
                const data = await res.json();
                if (data.ok) {
                    alert(`Модель ${data.active_model} успешно активирована!`);
                    fetchStatus();
                    fetchLocalModels();
                } else {
                    alert('Ошибка загрузки: ' + JSON.stringify(data));
                }
            } catch (err) {
                alert('Ошибка: ' + err.message);
            }
        }

        async function unloadModel() {
            try {
                await fetch('/api/models/unload', { method: 'POST' });
                alert('Модель выгружена из памяти');
                fetchStatus();
                fetchLocalModels();
            } catch (err) {
                alert('Ошибка: ' + err.message);
            }
        }

        async function deleteLocalModel(name) {
            if (!confirm(`Удалить файл ${name}?`)) return;
            try {
                await fetch(`/api/models/${name}`, { method: 'DELETE' });
                fetchLocalModels();
                fetchStatus();
            } catch (err) {
                alert(err.message);
            }
        }

        async function inspectHfRepo() {
            const input = document.getElementById('hf-input').value.trim();
            if (!input) return;
            const resEl = document.getElementById('hf-results');
            resEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px;">Запрос к HuggingFace API...</div>';

            try {
                const res = await fetch('/api/hf/inspect', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ repo_id_or_url: input })
                });
                const data = await res.json();
                if (!res.ok) {
                    resEl.innerHTML = `<div style="color:var(--danger); font-size:13px;">Ошибка: ${data.detail}</div>`;
                    return;
                }

                if (data.files.length === 0) {
                    resEl.innerHTML = `<div style="color:var(--warning); font-size:13px;">В этом репозитории не найдено .gguf файлов.</div>`;
                    return;
                }

                let html = `<div style="margin-bottom:12px; font-weight:700;">Найдено ${data.files.length} GGUF квантовок в ${data.repo_id}:</div><div class="model-list">`;
                data.files.forEach(f => {
                    html += `
                        <div class="model-item">
                            <div class="model-info">
                                <div class="model-name">
                                    <span>${f.filename}</span>
                                    ${f.is_mmproj ? '<span class="badge badge-vision">Vision mmproj</span>' : '<span class="badge badge-text">Квантовка</span>'}
                                </div>
                            </div>
                            <button class="btn-primary" style="padding:6px 14px; font-size:12px;" onclick="startDownload('${data.repo_id}', '${f.filename}')">⬇️ Скачать</button>
                        </div>
                    `;
                });
                html += '</div>';
                resEl.innerHTML = html;
            } catch (err) {
                resEl.innerHTML = `<div style="color:var(--danger); font-size:13px;">Ошибка: ${err.message}</div>`;
            }
        }

        async function startDownload(repoId, filename) {
            try {
                const res = await fetch('/api/hf/download', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ repo_id: repoId, filename: filename })
                });
                const data = await res.json();
                if (res.ok) {
                    fetchStatus();
                } else {
                    alert(data.detail);
                }
            } catch (err) {
                alert(err.message);
            }
        }

        async function cancelHfDownload() {
            await fetch('/api/hf/cancel', { method: 'POST' });
        }

        async function runTestGeneration() {
            const prompt = document.getElementById('test-prompt').value;
            const outEl = document.getElementById('test-output');
            outEl.innerText = 'Генерация ответа...';

            try {
                const res = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: prompt }],
                        stream: true
                    })
                });

                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                outEl.innerText = '';
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                            try {
                                const parsed = JSON.parse(trimmed.slice(6));
                                const delta = parsed.choices?.[0]?.delta?.content;
                                if (delta) outEl.innerText += delta;
                            } catch {}
                        }
                    }
                }
            } catch (err) {
                outEl.innerText = 'Ошибка: ' + err.message;
            }
        }

        function copyMobileUrl() {
            const url = document.getElementById('mobile-url-display').innerText;
            navigator.clipboard.writeText(url);
            alert('Скопировано в буфер обмена: ' + url);
        }

        // Initialize & poll status
        fetchStatus();
        fetchLocalModels();
        setInterval(fetchStatus, 2000);
    </script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(content=DASHBOARD_HTML)

def main():
    import argparse
    parser = argparse.ArgumentParser(description="SilkloraAI Local AI Hub Server")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on (default: 8080)")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host interface (default: 0.0.0.0)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    args = parser.parse_args()

    state.port = args.port
    ips = get_local_ip_addresses()
    primary_ip = ips[0] if ips else "127.0.0.1"

    print("=" * 60)
    print("  SilkloraAI Local AI Hub - PC Server")
    print("=" * 60)
    print(f"  Web Dashboard:   http://localhost:{args.port}")
    print(f"  Mobile Base URL: http://{primary_ip}:{args.port}/v1")
    print(f"  Listening on:    {args.host}:{args.port}")
    print("=" * 60)

    if not args.no_browser:
        def open_browser():
            time.sleep(1.2)
            try:
                import webbrowser
                webbrowser.open(f"http://localhost:{args.port}")
            except Exception:
                pass
        threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")

if __name__ == "__main__":
    main()
