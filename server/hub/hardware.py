"""Host hardware detection and capability profile.

The profile describes what the machine can run (memory budgets, parameter classes,
quantization class). It never names specific models.
"""

import glob
import json
import os
import platform
import re
import shutil
import subprocess
import time
from typing import Any, Dict, Optional

import psutil

GIB = 1024 ** 3

_static_cache: Dict[str, Any] = {}
_STATIC_TTL_SEC = 600


def _find_nvidia_smi() -> Optional[str]:
    path = shutil.which("nvidia-smi")
    if path:
        return path
    if os.name == "nt":
        for candidate in (
            r"C:\Windows\System32\nvidia-smi.exe",
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
        ):
            if os.path.exists(candidate):
                return candidate
        driver_store = glob.glob(r"C:\Windows\System32\DriverStore\FileRepository\nv*\nvidia-smi.exe")
        if driver_store:
            driver_store.sort(key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)
            return driver_store[0]
    else:
        for candidate in ("/usr/bin/nvidia-smi", "/usr/local/nvidia/bin/nvidia-smi", "/opt/bin/nvidia-smi"):
            if os.path.exists(candidate):
                return candidate
    return None


def _parse_mib(raw: str) -> int:
    if not raw:
        return 0
    match = re.search(r"(\d+(?:\.\d+)?)", raw)
    if not match:
        return 0
    try:
        return int(float(match.group(1))) * 1024 * 1024
    except ValueError:
        return 0


def _query_nvidia() -> Optional[Dict[str, Any]]:
    smi = _find_nvidia_smi()
    if not smi:
        return None
    fields_sets = (
        "name,memory.total,memory.free,compute_cap,driver_version",
        "name,memory.total,memory.free,driver_version",
        "name,memory.total,driver_version",
    )
    for fields in fields_sets:
        try:
            out = subprocess.check_output(
                [smi, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
                universal_newlines=True,
                timeout=5,
                stderr=subprocess.DEVNULL,
            ).strip()
        except Exception:
            continue
        gpus = []
        field_list = fields.split(",")
        for line in out.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < len(field_list):
                continue
            row = dict(zip(field_list, parts))
            name = row.get("name", "")
            if not name:
                continue
            vram_total = _parse_mib(row.get("memory.total", ""))
            vram_free = _parse_mib(row.get("memory.free", ""))
            if vram_total <= 0 and "nvidia" in name.lower():
                vram_total = 4 * GIB
            if vram_free <= 0 and vram_total > 0:
                vram_free = int(vram_total * 0.88)
            comp = row.get("compute_cap", "")
            if comp and ("n/a" in comp.lower() or "not" in comp.lower()):
                comp = ""
            gpu = {
                "name": name,
                "vram_total": vram_total,
                "vram_free": vram_free,
                "compute_cap": comp,
                "driver": row.get("driver_version", ""),
            }
            if vram_total > 0:
                gpus.append(gpu)
        if gpus:
            return {"gpus": gpus}
    return None


def _detect_windows_wmi_nvidia() -> Optional[Dict[str, Any]]:
    """Fallback when nvidia-smi is not in PATH or blocked on Windows."""
    if os.name != "nt":
        return None
    cmd = [
        "powershell",
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
    ]
    try:
        out = subprocess.check_output(cmd, universal_newlines=True, timeout=6, stderr=subprocess.DEVNULL).strip()
        if not out:
            return None
        data = json.loads(out)
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("Name") or "").strip()
            if "nvidia" in name.lower() or "geforce" in name.lower() or "rtx" in name.lower() or "gtx" in name.lower():
                raw_ram = int(item.get("AdapterRAM") or 0)
                # Win32_VideoController caps AdapterRAM at 4 GiB (uint32); estimate by model name if capped
                low = name.lower()
                if any(x in low for x in ("4090", "3090", "5090")):
                    vram_total = 24 * GIB
                elif any(x in low for x in ("4080", "5080", "4070 ti super", "3080 12")):
                    vram_total = 16 * GIB
                elif any(x in low for x in ("4070", "3060", "3080", "4060 ti", "6700", "7700")):
                    vram_total = 12 * GIB
                elif any(x in low for x in ("4060", "3070", "3060 ti", "2080", "2070", "2060 super", "1080", "1070")):
                    vram_total = 8 * GIB
                elif any(x in low for x in ("2060", "1660", "3050 6", "1060")):
                    vram_total = 6 * GIB
                else:
                    vram_total = max(raw_ram, 4 * GIB)
                return {
                    "name": name,
                    "count": 1,
                    "vram_total": vram_total,
                    "vram_free": int(vram_total * 0.88),
                    "compute_cap": "",
                    "driver": str(item.get("DriverVersion") or ""),
                }
    except Exception:
        pass
    return None


def detect_nvidia() -> Optional[Dict[str, Any]]:
    """Return a summary of the NVIDIA GPUs (memory is summed across devices)."""
    data = _query_nvidia()
    if not data:
        return _detect_windows_wmi_nvidia()
    gpus = data["gpus"]
    best = max(gpus, key=lambda g: g["vram_total"])
    return {
        "name": best["name"] + (f" x{len(gpus)}" if len(gpus) > 1 else ""),
        "count": len(gpus),
        "vram_total": sum(g["vram_total"] for g in gpus),
        "vram_free": sum(g["vram_free"] for g in gpus),
        "compute_cap": best["compute_cap"],
        "driver": best["driver"],
    }


def _is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def analyze_hardware(fresh_gpu: bool = True) -> Dict[str, Any]:
    now = time.time()
    if "static" not in _static_cache or now - _static_cache.get("at", 0) > _STATIC_TTL_SEC:
        _static_cache["static"] = {
            "cpu_name": platform.processor() or platform.machine(),
            "cores": psutil.cpu_count(logical=False) or 4,
            "threads": psutil.cpu_count(logical=True) or 8,
            "arch": platform.machine(),
            "nvidia": detect_nvidia(),
        }
        _static_cache["at"] = now
    static = _static_cache["static"]

    nvidia = static["nvidia"]
    if nvidia and fresh_gpu:
        live = detect_nvidia()
        if live:
            nvidia = live
            static["nvidia"] = live

    mem = psutil.virtual_memory()
    gpu = {
        "has_gpu": False,
        "kind": "none",
        "name": "",
        "count": 0,
        "vram_total": 0,
        "vram_free": 0,
        "compute_cap": "",
        "driver": "",
    }
    if nvidia:
        gpu.update(nvidia)
        gpu["has_gpu"] = True
        gpu["kind"] = "cuda"
    elif _is_apple_silicon():
        usable = int(mem.total * 0.66)
        gpu.update(
            has_gpu=True,
            kind="metal",
            name="Apple Silicon (unified memory)",
            count=1,
            vram_total=usable,
            vram_free=min(usable, int(mem.available * 0.85)),
        )

    return {
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
        "ram_total": mem.total,
        "ram_available": mem.available,
        "cpu": {
            "name": static["cpu_name"],
            "cores": static["cores"],
            "threads": static["threads"],
            "arch": static["arch"],
        },
        "gpu": gpu,
    }


def memory_budgets(hw: Dict[str, Any]) -> Dict[str, int]:
    """Bytes that can safely be used for model weights plus KV cache."""
    gpu = hw["gpu"]
    gpu_budget = 0
    if gpu["has_gpu"] and gpu["vram_total"] >= 2 * GIB:
        gpu_budget = max(0, int(gpu["vram_free"] * 0.92) - int(0.6 * GIB))
    ram_budget = max(0, int(hw["ram_available"] * 0.85) - int(1.0 * GIB))
    if gpu["kind"] == "metal":
        ram_budget = 0
    return {"gpu": gpu_budget, "ram": ram_budget}


def build_profile(hw: Dict[str, Any]) -> Dict[str, Any]:
    """Describe what this machine can run, in hardware terms only."""
    budgets = memory_budgets(hw)
    gpu_gb = budgets["gpu"] / GIB
    ram_gb = budgets["ram"] / GIB

    if gpu_gb >= 20:
        tier = "ultra"
    elif gpu_gb >= 10:
        tier = "high"
    elif gpu_gb >= 6:
        tier = "mid"
    elif gpu_gb >= 2.5:
        tier = "low"
    else:
        tier = "cpu"

    if gpu_gb >= 2.5:
        mode = "gpu"
        reference_gb = gpu_gb
        target_ctx = 16384 if gpu_gb >= 8 else 8192
    else:
        mode = "cpu"
        reference_gb = min(ram_gb * 0.6, 6.0)
        target_ctx = 8192

    # About 0.6 GB of weights per billion parameters at 4-bit quantization, plus cache headroom.
    comfortable_params_b = max(1.0, round((reference_gb - 1.5) / 0.6, 1))
    stretch_gb = gpu_gb + ram_gb * 0.7 if mode == "gpu" else ram_gb
    stretch_params_b = max(comfortable_params_b, round((stretch_gb - 1.5) / 0.6, 1))

    quant = "Q5_K_M" if mode == "gpu" and gpu_gb >= 14 else "Q4_K_M"

    return {
        "tier": tier,
        "mode": mode,
        "gpu_budget_gb": round(gpu_gb, 1),
        "ram_budget_gb": round(ram_gb, 1),
        "comfortable_params_b": comfortable_params_b,
        "stretch_params_b": stretch_params_b,
        "quant": quant,
        "target_ctx": target_ctx,
        "budgets_bytes": budgets,
    }
