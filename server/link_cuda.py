#!/usr/bin/env python3
"""
SilkloraAI - NVIDIA CUDA 12 Runtime Linker
Locates nvidia-cuda-runtime and nvidia-cublas DLLs and links them into llama_cpp/lib and Python directory
so llama-cpp-python (cu121) can run with full GPU acceleration without CUDA Toolkit.
"""

import os
import sys
import shutil
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

def ensure_cuda_dlls():
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
            except Exception as e:
                pass

    return True, f"Successfully linked {len(nvidia_dlls)} CUDA DLLs ({copied} copied) into {len(target_dirs)} directories."

def main():
    print("==========================================================")
    print("      SilkloraAI - NVIDIA CUDA 12 Runtime Linker")
    print("==========================================================")
    
    ok, msg = ensure_cuda_dlls()
    print(f"Status: {msg}")
    
    if not ok:
        print("\nPlease make sure nvidia-cuda-runtime-cu12 and nvidia-cublas-cu12 are installed.")
        return 1

    # Register DLL directories in Python 3.8+ Windows
    if sys.platform == "win32":
        py_dir = Path(sys.executable).parent
        if py_dir.is_dir():
            try:
                os.add_dll_directory(str(py_dir))
            except Exception:
                pass

        for p in sys.path:
            lld = Path(p) / "llama_cpp" / "lib"
            if lld.is_dir():
                try:
                    os.add_dll_directory(str(lld))
                except Exception:
                    pass
            nv = Path(p) / "nvidia"
            if nv.is_dir():
                for root, dirs, files in os.walk(str(nv)):
                    if "bin" in dirs:
                        try:
                            os.add_dll_directory(os.path.join(root, "bin"))
                        except Exception:
                            pass

    print("\nVerifying llama_cpp inference engine...")
    try:
        import llama_cpp
        from llama_cpp import Llama
        has_gpu = False
        try:
            has_gpu = bool(llama_cpp.llama_supports_gpu_offload())
        except Exception:
            pass

        print(f"[SUCCESS] llama_cpp successfully loaded (version: {getattr(llama_cpp, '__version__', 'unknown')})")
        print(f"GPU Offload Supported: {has_gpu}")
        if has_gpu:
            print("\nNVIDIA GPU acceleration (CUDA 12) is 100% active!")
            print("When you load a model with GPU Layers = -1, it will load into your 8 GB VRAM.")
            return 0
        else:
            print("\nNotice: llama_cpp loaded, but reports CPU-only offload.")
            return 2
    except Exception as e:
        print(f"\n[ERROR] Could not load llama_cpp: {e}")
        import traceback
        traceback.print_exc()
        return 3

if __name__ == "__main__":
    sys.exit(main())
