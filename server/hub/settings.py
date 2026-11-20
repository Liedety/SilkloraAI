import json
import threading
from typing import Any, Dict

from .paths import SETTINGS_FILE

DEFAULTS: Dict[str, Any] = {
    "settings_version": 2,
    "ctx_cap": 32768,
    "kv_quant": True,
    "auto_load_last": True,
    "last_model": None,
    "ctx_mode": "auto",
    "gpu_layers_mode": "auto",
    # Image generation & VRAM coordinator settings
    "image_backend": "sdcpp",
    "image_model": "",
    "image_vae": "",
    "image_clip_l": "",
    "image_clip_g": "",
    "image_t5xxl": "",
    "image_llm_encoder": "",
    "image_steps": 0,
    "image_cfg": 0.0,
    "image_width": 896,
    "image_height": 640,
    "image_sampler": "euler",
    "image_quality": "balanced",
    "image_low_vram": "auto",
    "comfyui_url": "",
    "a1111_url": "",
    # Server model-finder AI assistant
    "assistant_mode": "local",
    "assistant_provider": "openrouter",
    "assistant_base_url": "",
    "assistant_api_key": "",
    "assistant_model": "",
}

_lock = threading.Lock()
_cache: Dict[str, Any] = {}


def _load() -> Dict[str, Any]:
    data = dict(DEFAULTS)
    migrated = False
    try:
        if SETTINGS_FILE.exists():
            stored = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            if isinstance(stored, dict):
                data.update({k: v for k, v in stored.items() if k in DEFAULTS})
                try:
                    ver = int(stored.get("settings_version") or 0)
                except (TypeError, ValueError):
                    ver = 0
                if ver < 2:
                    # Reset pre-v2 global image_cfg / image_steps so distilled/flow models
                    # never inherit legacy CFG 5.0 or mismatched step counts.
                    data["image_cfg"] = 0.0
                    data["image_steps"] = 0
                    data["settings_version"] = 2
                    migrated = True
                if data.get("image_low_vram") not in ("auto", "always", "off", "always_unload", "keep_both"):
                    data["image_low_vram"] = "auto"
                    migrated = True
                if (
                    data.get("assistant_mode") == "api"
                    and not str(data.get("assistant_api_key") or "").strip()
                    and not str(data.get("assistant_base_url") or "").strip()
                ):
                    data["assistant_mode"] = "local"
                    migrated = True
                if migrated:
                    try:
                        SETTINGS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
                    except Exception:
                        pass
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
