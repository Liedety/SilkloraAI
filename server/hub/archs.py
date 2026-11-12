"""Detect which model architectures the installed llama.cpp build understands.

Architecture names are compiled into the llama library as plain C strings, so the library
file itself is the source of truth. No model names are involved.
"""

import importlib.util
import mmap
from pathlib import Path
from typing import Optional

_LIB_NAMES = ("llama.dll", "libllama.so", "libllama.dylib")
_cache = {"path": None, "stamp": None, "known": {}}


def _library_path() -> Optional[Path]:
    try:
        spec = importlib.util.find_spec("llama_cpp")
        root = Path(spec.origin).resolve().parent
    except Exception:
        return None
    for folder in (root / "lib", root):
        for name in _LIB_NAMES:
            candidate = folder / name
            if candidate.is_file():
                return candidate
    return None


def supports_architecture(arch: str) -> Optional[bool]:
    """True or False when the engine library can be inspected, None when it cannot."""
    if not arch:
        return None
    if arch == "clip":
        return True
    path = _library_path()
    if path is None:
        return None
    try:
        stamp = (path.stat().st_mtime_ns, path.stat().st_size)
    except OSError:
        return None
    if _cache["path"] != str(path) or _cache["stamp"] != stamp:
        _cache.update(path=str(path), stamp=stamp, known={})
    known = _cache["known"]
    if arch in known:
        return known[arch]
    needle = b"\x00" + arch.encode("utf-8") + b"\x00"
    try:
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            found = mm.find(needle) != -1
    except Exception:
        return None
    known[arch] = found
    return found
