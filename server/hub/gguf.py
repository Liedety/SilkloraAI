"""Minimal GGUF header reader.

Reads only the metadata block (architecture, layer counts, context length, projector type),
so that models can be classified and sized without loading any weights.
"""

import struct
from pathlib import Path
from typing import Any, Dict, Optional

_FIXED_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_FIXED_FORMATS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_TYPE_STRING = 8
_TYPE_ARRAY = 9
_MAX_SMALL_ARRAY = 256
_MAX_STRING = 1 << 20

_cache: Dict[str, Any] = {}


class GGUFError(Exception):
    pass


def _read(f, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise GGUFError("unexpected end of file")
    return data


def _read_string(f) -> str:
    (length,) = struct.unpack("<Q", _read(f, 8))
    if length > _MAX_STRING:
        f.seek(length, 1)
        return ""
    return _read(f, length).decode("utf-8", errors="replace")


def _read_value(f, vtype: int):
    if vtype in _FIXED_FORMATS:
        return struct.unpack(_FIXED_FORMATS[vtype], _read(f, _FIXED_SIZES[vtype]))[0]
    if vtype == _TYPE_STRING:
        return _read_string(f)
    if vtype == _TYPE_ARRAY:
        (etype,) = struct.unpack("<I", _read(f, 4))
        (count,) = struct.unpack("<Q", _read(f, 8))
        if etype in _FIXED_SIZES:
            if count <= _MAX_SMALL_ARRAY:
                return [_read_value(f, etype) for _ in range(count)]
            f.seek(count * _FIXED_SIZES[etype], 1)
            return None
        if etype == _TYPE_STRING:
            for _ in range(count):
                (length,) = struct.unpack("<Q", _read(f, 8))
                f.seek(length, 1)
            return None
        raise GGUFError(f"unsupported array element type {etype}")
    raise GGUFError(f"unsupported value type {vtype}")


def read_metadata(path: Path) -> Dict[str, Any]:
    """Return GGUF key/value pairs that precede the tokenizer block."""
    with open(path, "rb") as f:
        if _read(f, 4) != b"GGUF":
            raise GGUFError("not a GGUF file")
        (version,) = struct.unpack("<I", _read(f, 4))
        if version < 2:
            raise GGUFError(f"unsupported GGUF version {version}")
        _tensor_count, kv_count = struct.unpack("<QQ", _read(f, 16))
        meta: Dict[str, Any] = {}
        for _ in range(kv_count):
            key = _read_string(f)
            if key.startswith("tokenizer.") and "general.architecture" in meta:
                break
            (vtype,) = struct.unpack("<I", _read(f, 4))
            meta[key] = _read_value(f, vtype)
        return meta


def _scalar(value, reducer=max):
    if isinstance(value, list):
        nums = [v for v in value if isinstance(v, (int, float)) and v > 0]
        return int(reducer(nums)) if nums else 0
    return int(value) if isinstance(value, (int, float)) else 0


def _find_suffix(meta: Dict[str, Any], suffix: str) -> Optional[Any]:
    for key, value in meta.items():
        if key.endswith(suffix):
            return value
    return None


def inspect_model(path: Path) -> Dict[str, Any]:
    """Classify a GGUF file and extract the numbers needed for memory planning."""
    path = Path(path)
    stat = path.stat()
    cache_key = f"{path}|{stat.st_mtime_ns}|{stat.st_size}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return dict(cached)

    info: Dict[str, Any] = {
        "filename": path.name,
        "size_bytes": stat.st_size,
        "arch": "",
        "name": "",
        "is_projector": False,
        "projector_type": "",
        "n_layer": 0,
        "n_ctx_train": 0,
        "n_embd": 0,
        "n_head": 0,
        "n_head_kv": 0,
        "key_len": 0,
        "val_len": 0,
        "valid": False,
        "error": "",
    }
    try:
        meta = read_metadata(path)
        arch = str(meta.get("general.architecture", ""))
        info["arch"] = arch
        info["name"] = str(meta.get("general.name", ""))
        if arch == "clip":
            info["is_projector"] = True
            info["projector_type"] = str(_find_suffix(meta, "projector_type") or "")
        else:
            info["n_layer"] = _scalar(meta.get(f"{arch}.block_count"))
            info["n_ctx_train"] = _scalar(meta.get(f"{arch}.context_length"))
            info["n_embd"] = _scalar(meta.get(f"{arch}.embedding_length"))
            n_head = _scalar(meta.get(f"{arch}.attention.head_count"))
            n_head_kv = _scalar(meta.get(f"{arch}.attention.head_count_kv")) or n_head
            info["n_head"] = n_head
            info["n_head_kv"] = n_head_kv
            head_dim = (info["n_embd"] // n_head) if n_head else 0
            info["key_len"] = _scalar(meta.get(f"{arch}.attention.key_length")) or head_dim
            info["val_len"] = _scalar(meta.get(f"{arch}.attention.value_length")) or head_dim
        info["valid"] = bool(arch)
    except Exception as e:
        info["error"] = str(e)

    _cache[cache_key] = dict(info)
    return info
