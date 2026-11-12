"""Linking of NVIDIA CUDA runtime DLLs shipped as pip packages (no CUDA Toolkit required)."""

import os
import shutil
import sys
from pathlib import Path
from typing import List, Tuple

_DLL_PREFIXES = ("cudart64_", "cublas64_", "cublaslt64_")


def site_package_dirs() -> List[Path]:
    dirs = []
    for p in sys.path:
        if ("site-packages" in p or "dist-packages" in p) and Path(p).is_dir():
            dirs.append(Path(p))
    if not dirs:
        fallback = Path(sys.executable).parent / "Lib" / "site-packages"
        if fallback.is_dir():
            dirs.append(fallback)
    return dirs


def find_runtime_dlls() -> List[Path]:
    found = {}
    for sp in site_package_dirs():
        nvidia = sp / "nvidia"
        if not nvidia.is_dir():
            continue
        for dll in nvidia.glob("**/bin/**/*.dll"):
            if dll.name.lower().startswith(_DLL_PREFIXES):
                found[dll.name] = dll
    return list(found.values())


def link_cuda_dlls() -> Tuple[bool, str]:
    """Copy CUDA runtime DLLs next to llama_cpp and the interpreter so the wheel can resolve them."""
    dlls = find_runtime_dlls()
    if not dlls:
        return False, "CUDA runtime DLLs not found in site-packages/nvidia"

    targets = []
    for sp in site_package_dirs():
        lib_dir = sp / "llama_cpp" / "lib"
        if lib_dir.is_dir():
            targets.append(lib_dir)
    py_dir = Path(sys.executable).parent
    if py_dir not in targets:
        targets.append(py_dir)

    copied = 0
    for target in targets:
        for dll in dlls:
            dst = target / dll.name
            try:
                if dst.exists() and dst.stat().st_size == dll.stat().st_size:
                    continue
                shutil.copy2(dll, dst)
                copied += 1
            except Exception:
                pass
    return True, f"{len(dlls)} CUDA DLLs available, {copied} copied into {len(targets)} directories"


def register_dll_directories():
    """Make every directory that may hold CUDA or llama DLLs visible to the Windows loader."""
    if os.name != "nt":
        return
    candidates = [Path(sys.executable).parent]
    toolkit = Path(os.environ.get("CUDA_PATH", ""))
    if toolkit.is_dir():
        candidates.append(toolkit / "bin")
    for sp in site_package_dirs():
        candidates.append(sp / "llama_cpp" / "lib")
        nvidia = sp / "nvidia"
        if nvidia.is_dir():
            for root, _dirs, files in os.walk(nvidia):
                if any(name.lower().endswith(".dll") for name in files):
                    candidates.append(Path(root))
    for path in candidates:
        if path.is_dir():
            try:
                os.add_dll_directory(str(path))
            except Exception:
                pass
