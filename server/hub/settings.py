import json
import threading
from typing import Any, Dict

from .paths import SETTINGS_FILE

DEFAULTS: Dict[str, Any] = {
    "ctx_cap": 32768,
    "kv_quant": True,
    "auto_load_last": True,
    "last_model": None,
    "ctx_mode": "auto",
    "gpu_layers_mode": "auto",
}

_lock = threading.Lock()
_cache: Dict[str, Any] = {}


def _load() -> Dict[str, Any]:
    data = dict(DEFAULTS)
    try:
        if SETTINGS_FILE.exists():
            stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                data.update({k: v for k, v in stored.items() if k in DEFAULTS})
    except Exception:
        pass
    return data


def get_all() -> Dict[str, Any]:
    with _lock:
        if not _cache:
            _cache.update(_load())
        return dict(_cache)


def update(changes: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        if not _cache:
            _cache.update(_load())
        for key, value in changes.items():
            if key in DEFAULTS:
                _cache[key] = value
        try:
            SETTINGS_FILE.write_text(json.dumps(_cache, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        return dict(_cache)
