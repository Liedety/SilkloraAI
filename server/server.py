#!/usr/bin/env python3
"""
SilkloraAI Local AI Hub - Standalone Desktop Server (Windows / Linux / macOS)
High-performance OpenAI-compatible inference server for local GGUF models & Vision projectors (mmproj).
"""

import os
import sys
import subprocess
import importlib.util

REQUIRED_DEPS = [
    ("fastapi", "fastapi>=0.100.0"),
    ("uvicorn", "uvicorn[standard]>=0.23.0"),
    ("requests", "requests>=2.31.0"),
    ("huggingface_hub", "huggingface_hub>=0.20.0"),
    ("psutil", "psutil>=5.9.0"),
    ("multipart", "python-multipart>=0.0.6"),
]

def auto_install_dependencies():
    missing = []
    for mod_name, pkg_spec in REQUIRED_DEPS:
        if importlib.util.find_spec(mod_name) is None:
            missing.append(pkg_spec)
    
    if missing:
        missing_str = ", ".join(missing)
        print(f"[SilkloraAI Hub] Missing dependencies detected: {missing_str}")
        print("[SilkloraAI Hub] Installing required dependencies via pip...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--prefer-binary", *missing])
            print("[SilkloraAI Hub] Dependencies successfully installed.")
        except Exception:
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "--prefer-binary", *missing])
                print("[SilkloraAI Hub] Dependencies installed with --user flag.")
            except Exception as e:
                print(f"[SilkloraAI Hub] Warning: Could not auto-install dependencies: {e}")

auto_install_dependencies()

import json
import time
import socket
import threading
import traceback
import urllib.parse
import platform
import shutil
from pathlib import Path
from typing import List, Dict, Any, Optional

import requests
import psutil
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Optional llama-cpp-python import with automatic installation attempt
LLAMA_AVAILABLE = False
LLAMA_BACKEND = "none"
try:
    import llama_cpp
    from llama_cpp import Llama
    try:
        from llama_cpp.llama_chat_format import Llava15ChatHandler, MoondreamChatHandler
    except ImportError:
        pass
    LLAMA_AVAILABLE = True
    LLAMA_BACKEND = "installed"
except ImportError:
    try:
        print("[SilkloraAI Hub] Attempting to install prebuilt llama-cpp-python...")
        subprocess.check_call([
            sys.executable, "-m", "pip", "install",
            "llama-cpp-python",
            "--prefer-binary",
            "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cpu"
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import llama_cpp
        from llama_cpp import Llama
        try:
            from llama_cpp.llama_chat_format import Llava15ChatHandler, MoondreamChatHandler
        except ImportError:
            pass
        LLAMA_AVAILABLE = True
        LLAMA_BACKEND = "cpu_prebuilt"
        print("[SilkloraAI Hub] llama-cpp-python successfully initialized.")
    except Exception:
        LLAMA_AVAILABLE = False
        LLAMA_BACKEND = "none"

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)
DASHBOARD_FILE = BASE_DIR / "dashboard.html"
QRCODE_FILE = BASE_DIR / "qrcode.min.js"

app = FastAPI(title="SilkloraAI Local AI Hub", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

def analyze_system_hardware() -> Dict[str, Any]:
    """Inspect host hardware (RAM, CPU, NVIDIA GPU / VRAM) and compute model compatibility tiers."""
    ram = psutil.virtual_memory()
    total_ram_gb = round(ram.total / (1024**3), 1)
    avail_ram_gb = round(ram.available / (1024**3), 1)
    cpu_cores = psutil.cpu_count(logical=False) or 4
    cpu_threads = psutil.cpu_count(logical=True) or 8

    gpu = {
        "has_gpu": False,
        "name": "CPU Only",
        "vram_total_gb": 0.0,
        "vram_free_gb": 0.0,
        "cuda_ready": False,
    }

    nvsmi = shutil.which("nvidia-smi")
    if not nvsmi and os.name == "nt":
        for cand in [
            r"C:\Windows\System32\nvidia-smi.exe",
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
        ]:
            if os.path.exists(cand):
                nvsmi = cand
                break

    if nvsmi:
        try:
            out = subprocess.check_output(
                [nvsmi, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
                universal_newlines=True, timeout=3
            ).strip()
            if out:
                line = out.split("\n")[0]
                parts = [p.strip() for p in line.split(",")]
                gpu["has_gpu"] = True
                gpu["name"] = parts[0]
                gpu["vram_total_gb"] = round(int(parts[1]) / 1024, 1)
                gpu["vram_free_gb"] = round(int(parts[2]) / 1024, 1)
                gpu["cuda_ready"] = True
        except Exception:
            pass

    vram = gpu["vram_total_gb"]
    if vram >= 15.0:
        tier_level = "Ultra (16+ GB VRAM)"
        max_model_param = "12B - 20B Models"
        recommended_quant = "Q5_K_M or Q8_0"
        summary_en = f"Dedicated NVIDIA GPU with {vram} GB VRAM. Can run 12B to 14B models with 100% VRAM offload."
        summary_ru = f"Мощная видеокарта с {vram} ГБ VRAM. Полная выгрузка моделей 12B-14B в видеопамять."
        presets = [
            {"name": "Mistral-Nemo 12B HERETIC", "repo": "mradermacher/Mistral-Nemo-2407-12B-Thinking-Claude-Gemini-GPT5.2-Uncensored-HERETIC-GGUF", "desc_en": "Top RP model without censorship (12B Q5_K_M ~9.2GB)", "desc_ru": "Лучшая RP модель без цензуры (12B Q5_K_M ~9.2ГБ)", "badge": "12B Q5_K_M"},
            {"name": "Qwen 2.5 14B Instruct", "repo": "Qwen/Qwen2.5-14B-Instruct-GGUF", "desc_en": "Advanced 14B multilingual model (~9.8GB)", "desc_ru": "Продвинутая модель 14B с отличным русским (~9.8ГБ)", "badge": "14B Q4_K_M"},
            {"name": "MiniCPM-V 2.6 (Vision 8B)", "repo": "openbmb/MiniCPM-V-2_6-gguf", "desc_en": "Multimodal Vision model with mmproj (~5.8GB)", "desc_ru": "Мультимодальная модель с проектором mmproj (~5.8ГБ)", "badge": "Vision 8B"},
        ]
    elif vram >= 7.5:
        tier_level = "High (8 - 12 GB VRAM)"
        max_model_param = "8B - 12B Models"
        recommended_quant = "Q4_K_M"
        summary_en = f"Dedicated NVIDIA GPU with {vram} GB VRAM. Optimal for 8B to 12B models (Q4_K_M) with complete VRAM offload."
        summary_ru = f"Дискретная видеокарта с {vram} ГБ VRAM. Оптимально для моделей 8B-12B (Q4_K_M) с полной выгрузкой в GPU."
        presets = [
            {"name": "Mistral-Nemo 12B HERETIC", "repo": "mradermacher/Mistral-Nemo-2407-12B-Thinking-Claude-Gemini-GPT5.2-Uncensored-HERETIC-GGUF", "desc_en": "Top RP model without censorship (12B Q4_K_M ~8.1GB)", "desc_ru": "Лучшая RP модель без цензуры (12B Q4_K_M ~8.1ГБ)", "badge": "12B Q4_K_M"},
            {"name": "Llama 3.1 8B Instruct", "repo": "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", "desc_en": "Universal 8B model (~5.5GB VRAM)", "desc_ru": "Универсальная модель 8B (~5.5ГБ VRAM)", "badge": "8B Q4_K_M"},
            {"name": "MiniCPM-V 2.6 (Vision 8B)", "repo": "openbmb/MiniCPM-V-2_6-gguf", "desc_en": "Multimodal Vision model with mmproj (~5.8GB)", "desc_ru": "Мультимодальная модель с проектором mmproj (~5.8ГБ)", "badge": "Vision 8B"},
        ]
    elif vram >= 4.0:
        tier_level = "Medium (4 - 6 GB VRAM)"
        max_model_param = "3B - 8B Models"
        recommended_quant = "Q4_K_M (3B) / Q3_K_M (8B)"
        summary_en = f"Dedicated GPU with {vram} GB VRAM. Recommended for 3B-4B models or 8B models with partial offloading."
        summary_ru = f"Видеокарта с {vram} ГБ VRAM. Рекомендуются модели 3B-4B или 8B с частичной выгрузкой слоев."
        presets = [
            {"name": "Llama 3.2 3B Instruct", "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF", "desc_en": "Fast 3B model (fits 100% in VRAM ~2.2GB)", "desc_ru": "Быстрая модель 3B (100% помещается в VRAM ~2.2ГБ)", "badge": "3B Q4_K_M"},
            {"name": "Qwen 2.5 3B Instruct", "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF", "desc_en": "Smart 3B model with great multilingual support (~2.2GB)", "desc_ru": "Умная модель 3B с отличным русским языком (~2.2ГБ)", "badge": "3B Q4_K_M"},
            {"name": "Moondream 2 (Vision 1.8B)", "repo": "vikhyatk/moondream2", "desc_en": "Ultra-lightweight 1.8B Vision model (~1.4GB)", "desc_ru": "Ультралегкая модель зрения 1.8B (~1.4ГБ)", "badge": "Vision 1.8B"},
        ]
    else:
        tier_level = "CPU Mode"
        max_model_param = "1B - 7B Models"
        recommended_quant = "Q4_K_M (3B) / Q3_K_M (7B)"
        summary_en = f"Inference will run on CPU ({cpu_cores} physical cores) using {total_ram_gb} GB RAM."
        summary_ru = f"Инференс на процессоре ({cpu_cores} ядер) с использованием {total_ram_gb} ГБ RAM."
        presets = [
            {"name": "Llama 3.2 3B Instruct", "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF", "desc_en": "Fast and responsive on CPU (~2.2GB RAM)", "desc_ru": "Быстрая модель на процессоре (~2.2ГБ RAM)", "badge": "3B Q4_K_M"},
            {"name": "Qwen 2.5 3B Instruct", "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF", "desc_en": "Efficient bilingual 3B model (~2.2GB)", "desc_ru": "Эффективная двуязычная модель 3B (~2.2ГБ)", "badge": "3B Q4_K_M"},
            {"name": "Llama 3.2 1B Instruct", "repo": "bartowski/Llama-3.2-1B-Instruct-GGUF", "desc_en": "Ultra-fast 1B model (~0.9GB RAM)", "desc_ru": "Сверхбыстрая модель 1B (~0.9ГБ RAM)", "badge": "1B Q4_K_M"},
        ]

    return {
        "ram": {"total_gb": total_ram_gb, "avail_gb": avail_ram_gb},
        "cpu": {"cores": cpu_cores, "threads": cpu_threads, "arch": platform.machine()},
        "gpu": gpu,
        "tier": {
            "level": tier_level,
            "max_model_param": max_model_param,
            "recommended_quant": recommended_quant,
            "summary_en": summary_en,
            "summary_ru": summary_ru,
            "presets": presets,
        }
    }

def get_local_ip_addresses() -> List[str]:
    ip_list = []
    try:
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

    try:
        addrs = psutil.net_if_addrs()
        for iface_name, iface_addrs in addrs.items():
            for addr in iface_addrs:
                if addr.family == socket.AF_INET:
                    ip = addr.address
                    if ip and not ip.startswith("127.") and ip not in ip_list:
                        if ip.startswith("192.168.") or ip.startswith("10.") or ip.startswith("172."):
                            ip_list.insert(0, ip)
                        else:
                            ip_list.append(ip)
    except Exception:
        pass

    return ip_list or ["127.0.0.1"]

def scan_local_models() -> List[Dict[str, Any]]:
    models = []
    if not MODELS_DIR.exists():
        return models

    for file_path in MODELS_DIR.glob("*.gguf"):
        size_bytes = file_path.stat().st_size
        size_gb = round(size_bytes / (1024**3), 2)
        is_mmproj = "mmproj" in file_path.name.lower() or "projector" in file_path.name.lower()
        is_active = (str(file_path) == state.active_model_path) or (str(file_path) == state.active_mmproj_path)
        
        models.append({
            "filename": file_path.name,
            "path": str(file_path),
            "size_gb": size_gb,
            "size_bytes": size_bytes,
            "is_mmproj": is_mmproj,
            "is_active": is_active,
        })
    
    models.sort(key=lambda x: (x["is_mmproj"], x["filename"].lower()))
    return models

def unload_current_model():
    with state.lock:
        if state.llama_instance is not None:
            del state.llama_instance
            state.llama_instance = None
        state.active_model_path = None
        state.active_model_name = "None (No model loaded)"
        state.active_mmproj_path = None
        state.active_mmproj_name = None
        print("[SilkloraAI Hub] Active model unloaded from memory.")

def load_gguf_model(model_path: str, mmproj_path: Optional[str] = None, n_ctx: int = 4096, n_gpu_layers: int = -1):
    with state.lock:
        unload_current_model()
        
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
                    print(f"[SilkloraAI Hub] Notice: Failed to init Llava15ChatHandler ({e}), loading text only.")
            
            print(f"[SilkloraAI Hub] Loading GGUF Model: {state.active_model_name} (gpu_layers={n_gpu_layers}, ctx={n_ctx})...")
            state.llama_instance = Llama(
                model_path=state.active_model_path,
                n_ctx=n_ctx,
                n_gpu_layers=n_gpu_layers,
                chat_handler=chat_handler,
                verbose=False,
            )
            print(f"[SilkloraAI Hub] Successfully loaded: {state.active_model_name}")
        else:
            print(f"[SilkloraAI Hub] [Simulation Mode] Selected: {state.active_model_name} (llama-cpp-python not compiled)")

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
            "speed_mb": 0.0,
            "error": None,
        }

    try:
        print(f"[SilkloraAI Hub] Starting download: {filename} from {repo_id}...")
        headers = {"User-Agent": "SilkloraAI-Local-Hub/1.2"}
        resp = requests.get(download_url, headers=headers, stream=True, timeout=30)
        resp.raise_for_status()

        total_size = int(resp.headers.get("content-length", 0))
        with state.download_lock:
            if state.download_task:
                state.download_task["total_bytes"] = total_size

        downloaded = 0
        start_time = time.time()
        last_update = time.time()

        with open(temp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 1024):
                if state.cancel_download_flag:
                    print(f"[SilkloraAI Hub] Download cancelled: {filename}")
                    temp_path.unlink(missing_ok=True)
                    with state.download_lock:
                        state.download_task = {"status": "cancelled", "filename": filename}
                    
                    def _clear_cancelled():
                        time.sleep(4)
                        with state.download_lock:
                            if state.download_task and state.download_task.get("status") == "cancelled":
                                state.download_task = None
                    threading.Thread(target=_clear_cancelled, daemon=True).start()
                    return

                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    
                    now = time.time()
                    if now - last_update >= 0.5:
                        elapsed = now - start_time
                        speed = (downloaded / (1024 * 1024)) / (elapsed if elapsed > 0 else 1)
                        pct = round((downloaded / total_size) * 100, 1) if total_size > 0 else 0.0
                        with state.download_lock:
                            if state.download_task:
                                state.download_task["downloaded_bytes"] = downloaded
                                state.download_task["percent"] = pct
                                state.download_task["speed_mb"] = round(speed, 2)
                        last_update = now

        temp_path.rename(target_path)
        print(f"[SilkloraAI Hub] Download complete: {filename}")
        with state.download_lock:
            state.download_task = {"status": "completed", "filename": filename, "percent": 100.0}
        
        def _clear_completed():
            time.sleep(4)
            with state.download_lock:
                if state.download_task and state.download_task.get("status") == "completed":
                    state.download_task = None
        threading.Thread(target=_clear_completed, daemon=True).start()

    except Exception as e:
        print(f"[SilkloraAI Hub] Download error: {e}")
        temp_path.unlink(missing_ok=True)
        with state.download_lock:
            state.download_task = {"status": "failed", "filename": filename, "error": str(e)}
        
        def _clear_failed():
            time.sleep(4)
            with state.download_lock:
                if state.download_task and state.download_task.get("status") == "failed":
                    state.download_task = None
        threading.Thread(target=_clear_failed, daemon=True).start()

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

    # Fallback simulation engine
    model_name = state.active_model_name
    simulated_reply = f"SilkloraAI Local Hub is active.\n\nCurrent model: {model_name}.\n"
    if not LLAMA_AVAILABLE:
        simulated_reply += "\n[System Notice]: llama-cpp-python is not installed in the current environment. Please install or enable CUDA."

    has_image = False
    for msg in messages:
        c = msg.get("content")
        if isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and part.get("type") == "image_url":
                    has_image = True
                    break
    if has_image:
        simulated_reply += "\n[Vision]: Processing visual input through mmproj projector."

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
# Hub Management APIs
# -------------------------------------------------------------
@app.get("/api/status")
def get_status():
    ips = get_local_ip_addresses()
    primary_ip = ips[0] if ips else "127.0.0.1"
    mobile_url = f"http://{primary_ip}:{state.port}/v1"
    
    mem = psutil.virtual_memory()
    return {
        "status": "online",
        "uptime_sec": int(time.time() - state.start_time),
        "llama_cpp_available": LLAMA_AVAILABLE,
        "llama_backend": LLAMA_BACKEND,
        "active_model": state.active_model_name,
        "active_model_path": state.active_model_path,
        "active_mmproj": state.active_mmproj_name,
        "n_ctx": state.n_ctx,
        "n_gpu_layers": state.n_gpu_layers,
        "local_ips": ips,
        "primary_ip": primary_ip,
        "mobile_url": mobile_url,
        "ram_total_gb": round(mem.total / (1024**3), 1),
        "ram_used_gb": round(mem.used / (1024**3), 1),
        "ram_percent": mem.percent,
        "download_task": state.download_task,
    }

@app.get("/api/hardware")
def get_hardware_analysis():
    return analyze_system_hardware()

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
    
    # Auto-clear download_task if it matches deleted file
    with state.download_lock:
        if state.download_task and state.download_task.get("filename") == filename:
            state.download_task = None

    return {"ok": True, "deleted": filename}

@app.get("/api/hf/search")
def search_huggingface(q: str = ""):
    """Search Hugging Face models by keyword or model name."""
    query = q.strip()
    if not query:
        return {"query": "", "results": []}

    if "huggingface.co/" in query:
        query = query.split("huggingface.co/")[-1].strip("/")
        if query.startswith("models/"):
            query = query.replace("models/", "")
        if "/" in query:
            query = query.split("/")[-1]

    search_term = query.replace("https://", "").replace("http://", "")
    url = f"https://huggingface.co/api/models?search={urllib.parse.quote(search_term)}&filter=gguf&sort=downloads&direction=-1&limit=25"
    try:
        res = requests.get(url, headers={"User-Agent": "SilkloraAI-Local-Hub/1.2"}, timeout=12)
        res.raise_for_status()
        items = res.json()
        results = []
        for it in items:
            repo_id = it.get("id") or it.get("modelId")
            if not repo_id:
                continue
            results.append({
                "repo_id": repo_id,
                "downloads": it.get("downloads", 0),
                "likes": it.get("likes", 0),
                "author": repo_id.split("/")[0] if "/" in repo_id else "",
                "name": repo_id.split("/")[-1] if "/" in repo_id else repo_id,
            })
        return {"query": query, "results": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/hf/inspect")
async def inspect_huggingface_repo(req: Request):
    """Inspect a HuggingFace repository ID or URL and list available GGUF files with sizes and quantization advice."""
    data = await req.json()
    raw_input = data.get("repo_id_or_url", "").strip()
    if not raw_input:
        raise HTTPException(status_code=400, detail="Repository ID or URL is required")

    clean_repo = raw_input
    if "huggingface.co/" in clean_repo:
        clean_repo = clean_repo.split("huggingface.co/")[-1].strip("/")
        if clean_repo.startswith("models/"):
            clean_repo = clean_repo.replace("models/", "")

    api_url = f"https://huggingface.co/api/models/{clean_repo}"
    try:
        res = requests.get(api_url, headers={"User-Agent": "SilkloraAI-Local-Hub/1.2"}, timeout=15)
        if res.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Repository not found on HuggingFace: {clean_repo}")
        res.raise_for_status()
        info = res.json()

        tree_sizes = {}
        try:
            tree_url = f"https://huggingface.co/api/models/{clean_repo}/tree/main"
            t_res = requests.get(tree_url, headers={"User-Agent": "SilkloraAI-Local-Hub/1.2"}, timeout=10)
            if t_res.ok:
                for f_obj in t_res.json():
                    f_path = f_obj.get("path")
                    f_size = f_obj.get("size")
                    if f_path and f_size is not None:
                        tree_sizes[f_path] = f_size
        except Exception:
            pass
        
        siblings = info.get("siblings", [])
        gguf_files = []
        for s in siblings:
            rfilename = s.get("rfilename", "")
            if rfilename.lower().endswith(".gguf"):
                is_mmproj = "mmproj" in rfilename.lower() or "projector" in rfilename.lower()
                size_bytes = tree_sizes.get(rfilename, 0)
                size_gb = round(size_bytes / (1024**3), 2) if size_bytes else None

                q_tag = "standard"
                fname_upper = rfilename.upper()
                if is_mmproj:
                    q_tag = "mmproj"
                elif "Q4_K_M" in fname_upper or "Q4_K_S" in fname_upper:
                    q_tag = "recommended"
                elif "Q5_K_M" in fname_upper or "Q5_K_S" in fname_upper:
                    q_tag = "high"
                elif "Q8_0" in fname_upper or "Q8_1" in fname_upper:
                    q_tag = "ultra"
                elif "Q3_K" in fname_upper or "Q2_K" in fname_upper or "IQ3" in fname_upper:
                    q_tag = "economy"

                gguf_files.append({
                    "filename": rfilename,
                    "is_mmproj": is_mmproj,
                    "size_bytes": size_bytes,
                    "size_gb": size_gb,
                    "q_tag": q_tag,
                })

        # If repo is unquantized safetensors (like DavidAU) without GGUF files
        suggested_repos = []
        if not gguf_files:
            model_slug = clean_repo.split("/")[-1]
            s_url = f"https://huggingface.co/api/models?search={urllib.parse.quote(model_slug)}&filter=gguf&sort=downloads&direction=-1&limit=15"
            try:
                s_res = requests.get(s_url, headers={"User-Agent": "SilkloraAI-Local-Hub/1.2"}, timeout=10)
                if s_res.ok:
                    for s_item in s_res.json():
                        s_id = s_item.get("id") or s_item.get("modelId")
                        if s_id and s_id != clean_repo:
                            suggested_repos.append({
                                "repo_id": s_id,
                                "downloads": s_item.get("downloads", 0),
                                "likes": s_item.get("likes", 0),
                                "author": s_id.split("/")[0] if "/" in s_id else "",
                                "name": s_id.split("/")[-1] if "/" in s_id else s_id,
                            })
            except Exception:
                pass

        return {
            "repo_id": clean_repo,
            "author": info.get("author", clean_repo.split("/")[0] if "/" in clean_repo else ""),
            "downloads": info.get("downloads", 0),
            "likes": info.get("likes", 0),
            "files": gguf_files,
            "has_gguf": len(gguf_files) > 0,
            "suggested_gguf_repos": suggested_repos,
        }
    except requests.RequestException as e:
        raise HTTPException(status_code=500, detail=f"HuggingFace query failed: {str(e)}")

@app.get("/api/hf/vision")
def get_curated_vision_models():
    """Curated multimodal Vision models with paired base model and mmproj projectors."""
    return {
        "catalog": [
            {
                "id": "minicpm-v-2.6",
                "name": "MiniCPM-V 2.6 (8B)",
                "author": "openbmb",
                "description_en": "High performance multimodal model with state-of-the-art visual comprehension and Russian OCR/conversation.",
                "description_ru": "Мощная мультимодальная модель с превосходным пониманием картинок, распознаванием русского текста и диалогом.",
                "vram_rec": "8+ GB VRAM",
                "repo_id": "openbmb/MiniCPM-V-2_6-gguf",
                "base_file": "ggml-model-Q4_K_M.gguf",
                "base_size_gb": 5.5,
                "mmproj_file": "mmproj-model-f16.gguf",
                "mmproj_size_gb": 0.6,
            },
            {
                "id": "llava-1.5-7b",
                "name": "LLaVA 1.5 (7B)",
                "author": "mys",
                "description_en": "Popular versatile vision model for general photo description and visual Q&A.",
                "description_ru": "Популярная универсальная модель для описания фотографий и ответов на вопросы по изображениям.",
                "vram_rec": "6-8 GB VRAM",
                "repo_id": "mys/ggml_llava-v1.5-7b",
                "base_file": "ggml-model-q4_k.gguf",
                "base_size_gb": 4.1,
                "mmproj_file": "mmproj-model-f16.gguf",
                "mmproj_size_gb": 0.6,
            },
            {
                "id": "moondream2-1.8b",
                "name": "Moondream 2 (1.8B)",
                "author": "vikhyatk",
                "description_en": "Ultra-lightweight 1.8B vision model designed to run smoothly on lower-spec hardware and CPUs.",
                "description_ru": "Ультралегкая компактная модель 1.8B для работы на слабых видеокартах или процессоре.",
                "vram_rec": "3-4 GB VRAM / CPU",
                "repo_id": "vikhyatk/moondream2",
                "base_file": "moondream2-text-model-f16.gguf",
                "base_size_gb": 1.4,
                "mmproj_file": "moondream2-mmproj-f16.gguf",
                "mmproj_size_gb": 0.5,
            },
            {
                "id": "qwen2-vl-7b",
                "name": "Qwen2-VL (7B)",
                "author": "Qwen",
                "description_en": "Advanced visual reasoning model capable of analyzing high-resolution images and complex diagrams.",
                "description_ru": "Продвинутая модель визуального рассуждения с поддержкой высокого разрешения и схем.",
                "vram_rec": "8-12 GB VRAM",
                "repo_id": "Qwen/Qwen2-VL-7B-Instruct-GGUF",
                "base_file": "qwen2-vl-7b-instruct-q4_k_m.gguf",
                "base_size_gb": 4.8,
                "mmproj_file": "mmproj-Qwen2-VL-7B-Instruct-f16.gguf",
                "mmproj_size_gb": 0.8,
            }
        ]
    }

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

@app.post("/api/enable-cuda")
def enable_cuda():
    """Attempt background installation of CUDA-accelerated llama-cpp-python."""
    def _install():
        print("[SilkloraAI Hub] Initiating CUDA llama-cpp-python installation...")
        try:
            subprocess.check_call([
                sys.executable, "-m", "pip", "install", "--upgrade", "--force-reinstall",
                "llama-cpp-python",
                "--prefer-binary",
                "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu121"
            ])
            print("[SilkloraAI Hub] CUDA llama-cpp-python installed successfully.")
        except Exception as e:
            print(f"[SilkloraAI Hub] CUDA install failed: {e}")

    threading.Thread(target=_install, daemon=True).start()
    return {"ok": True, "message": "CUDA installation started in background."}

@app.get("/qrcode.min.js")
def get_qrcode_js():
    if QRCODE_FILE.exists():
        return FileResponse(QRCODE_FILE, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="qrcode.min.js not found")

@app.get("/", response_class=HTMLResponse)
def index_page():
    if DASHBOARD_FILE.exists():
        return HTMLResponse(content=DASHBOARD_FILE.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>SilkloraAI Local Hub</h1><p>dashboard.html not found</p>", status_code=500)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    state.port = port
    print("==================================================================")
    print(f"  SilkloraAI Local AI Hub running at: http://localhost:{port}")
    print("==================================================================")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
