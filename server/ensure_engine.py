#!/usr/bin/env python3
"""
SilkloraAI - Automated Inference Engine & CUDA 12 Installer
Ensures llama-cpp-python v0.3.16+ with CUDA 12 acceleration and Qwen2.5-VL architecture support.
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path

# Disable Windows Console QuickEdit mode to prevent accidental mouse clicks from suspending the server
if sys.platform == "win32":
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        hStdin = kernel32.GetStdHandle(-10) # STD_INPUT_HANDLE
        mode = ctypes.c_ulong()
        if kernel32.GetConsoleMode(hStdin, ctypes.byref(mode)):
            kernel32.SetConsoleMode(hStdin, (mode.value & ~0x0040) | 0x0080)
    except Exception:
        pass

def get_installed_llama_version():
    try:
        import llama_cpp
        ver_str = getattr(llama_cpp, "__version__", "0.0.0")
        has_gpu = False
        try:
            has_gpu = bool(llama_cpp.llama_supports_gpu_offload())
        except Exception:
            pass
        return ver_str, has_gpu
    except Exception:
        return None, False

def verify_in_fresh_process():
    """Runs a fresh Python process to inspect the newly installed package without module cache bias."""
    try:
        cmd = [
            sys.executable, "-c",
            "import llama_cpp; v=getattr(llama_cpp, '__version__', 'unknown'); g=bool(llama_cpp.llama_supports_gpu_offload()); print(f'{v}|{g}'); sys.exit(0 if g else 1)"
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if proc.returncode == 0 and "|" in proc.stdout:
            v_str, g_str = proc.stdout.strip().split("|", 1)
            return v_str.strip(), g_str.strip() == "True"
    except Exception:
        pass
    return None, False

def is_engine_satisfactory(ver_str, has_gpu):
    if not ver_str or not has_gpu:
        return False
    # Need at least 0.3.16 for Qwen2.5-VL and modern vision architecture
    parts = []
    for x in ver_str.split(".")[:3]:
        num = "".join(ch for ch in x if ch.isdigit())
        if num:
            parts.append(int(num))
        else:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)

    # Check >= 0.3.16
    if parts[0] > 0:
        return True
    if parts[0] == 0:
        if parts[1] > 3:
            return True
        if parts[1] == 3 and parts[2] >= 16:
            return True
    return False

def link_cuda_dlls():
    py_dir = Path(sys.executable).parent
    site_dirs = []
    for p in sys.path:
        if ("site-packages" in p or "dist-packages" in p) and Path(p).is_dir():
            site_dirs.append(Path(p))

    if not site_dirs:
        sp = py_dir / "Lib" / "site-packages"
        if sp.is_dir():
            site_dirs.append(sp)

    llama_lib_dirs = []
    for sp in site_dirs:
        lld = sp / "llama_cpp" / "lib"
        if lld.is_dir():
            llama_lib_dirs.append(lld)

    nvidia_dlls = {}
    for sp in site_dirs:
        nvidia_base = sp / "nvidia"
        if nvidia_base.is_dir():
            for dll in nvidia_base.glob("**/bin/*.dll"):
                name_lower = dll.name.lower()
                if name_lower in ("cudart64_12.dll", "cublas64_12.dll", "cublaslt64_12.dll"):
                    nvidia_dlls[dll.name] = dll

    if not nvidia_dlls:
        return False, "No CUDA runtime DLLs found in site-packages/nvidia."

    target_dirs = list(llama_lib_dirs)
    if py_dir not in target_dirs:
        target_dirs.append(py_dir)

    copied = 0
    for td in target_dirs:
        td.mkdir(parents=True, exist_ok=True)
        for name, src_dll in nvidia_dlls.items():
            dst = td / name
            if dst.exists():
                try:
                    if dst.stat().st_size == src_dll.stat().st_size:
                        continue
                except Exception:
                    pass
            try:
                shutil.copy2(src_dll, dst)
                copied += 1
            except Exception:
                pass

    return True, f"Linked {len(nvidia_dlls)} CUDA DLLs ({copied} copied) into {len(target_dirs)} directories."

def run_pip(args):
    cmd = [sys.executable, "-m", "pip"] + args
    return subprocess.run(cmd)

def main():
    print("==========================================================")
    print("   SilkloraAI - Auto Engine & CUDA 12 Hardware Linker")
    print("==========================================================")

    current_ver, has_gpu = get_installed_llama_version()
    print(f"Current engine: llama-cpp-python {current_ver or 'not installed'} (GPU offload: {has_gpu})")

    if is_engine_satisfactory(current_ver, has_gpu):
        print("[SUCCESS] Modern GPU inference engine (>= 0.3.16) is already active.")
        link_cuda_dlls()
        return 0

    print("\nUpgrading inference engine for Qwen2.5-VL and RTX GPU acceleration...")

    # 1. Install NVIDIA CUDA runtime wheels
    print("Step 1/3: Ensuring NVIDIA CUDA 12 runtime packages...")
    run_pip(["install", "nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12", "--prefer-binary"])

    # 2. Select appropriate pre-compiled CUDA 12.4 wheel
    py_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    wheel_url = f"https://huggingface.co/datasets/AIencoder/llama-cpp-wheels/resolve/main/windows/x86_64/cuda12.4/0.3.16/llama_cpp_python-0.3.16%2Bcu124-{py_tag}-{py_tag}-win_amd64.whl"

    print(f"Step 2/3: Installing pre-compiled CUDA wheel for {py_tag}...")
    print(f"Source: Hugging Face AIencoder/llama-cpp-wheels (v0.3.16)")
    res = run_pip(["install", "--upgrade", "--no-cache-dir", wheel_url])

    if res.returncode != 0:
        print("[Notice] Direct wheel install returned non-zero code. Trying pip index fallback...")
        run_pip(["install", "--upgrade", "llama-cpp-python", "--prefer-binary", "--extra-index-url", "https://abetlen.github.io/llama-cpp-python/whl/cu121"])

    # 3. Link CUDA runtime DLLs
    print("Step 3/3: Linking CUDA 12 DLLs into runtime environment...")
    ok, msg = link_cuda_dlls()
    print(f"DLL Link status: {msg}")

    # 4. Verify in a clean subprocess
    new_ver, new_has_gpu = verify_in_fresh_process()
    if not new_ver:
        new_ver, new_has_gpu = get_installed_llama_version()

    print("\n----------------------------------------------------------")
    print(f"Verification: llama-cpp-python {new_ver} (GPU: {new_has_gpu})")
    if is_engine_satisfactory(new_ver, new_has_gpu):
        print("[SUCCESS] Qwen2.5-VL and RTX GPU inference engine ready!")
        print("----------------------------------------------------------")
        return 0
    else:
        print("[WARNING] Engine updated but GPU offload verification did not pass.")
        print("----------------------------------------------------------")
        return 1

if __name__ == "__main__":
    sys.exit(main())
