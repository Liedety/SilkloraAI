"""Local model library: scan models/, classify files by GGUF header, pair vision projectors."""

import difflib
import json
import re
import threading
from typing import Any, Dict, List, Optional

from .gguf import inspect_model
from .paths import DATA_DIR, MODELS_DIR

META_FILE = DATA_DIR / "models_meta.json"
_meta_lock = threading.Lock()

_QUANT_TOKENS = re.compile(
    r"(iq\d_[a-z]+|q\d_k_[a-z]|q\d_k|q\d_\d|q\d|f16|f32|bf16|fp16|imatrix|gguf|mmproj|projector|model|text)",
    re.IGNORECASE,
)


def _load_meta() -> Dict[str, Any]:
    try:
        if META_FILE.exists():
            data = json.loads(META_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def get_meta(filename: str) -> Dict[str, Any]:
    with _meta_lock:
        return dict(_load_meta().get(filename, {}))


def set_meta(filename: str, values: Dict[str, Any]):
    with _meta_lock:
        data = _load_meta()
        entry = data.get(filename, {})
        entry.update(values)
        data[filename] = entry
        try:
            META_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass


def drop_meta(filename: str):
    with _meta_lock:
        data = _load_meta()
        if filename in data:
            del data[filename]
            try:
                META_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass


def _stem(name: str) -> str:
    base = name.lower().rsplit(".gguf", 1)[0]
    base = _QUANT_TOKENS.sub("", base)
    return re.sub(r"[^a-z0-9]+", "", base)


def pair_projector(model_name: str, projectors: List[str]) -> Optional[str]:
    """Choose the projector that belongs to a model by recorded download or name similarity."""
    recorded = get_meta(model_name).get("projector")
    if recorded and recorded in projectors:
        return recorded
    stem = _stem(model_name)
    if not stem:
        return None
    best, best_score = None, 0.0
    for candidate in projectors:
        other = _stem(candidate)
        if not other:
            continue
        if stem.startswith(other) or other.startswith(stem):
            score = 1.0
        else:
            score = difflib.SequenceMatcher(None, stem, other).ratio()
        if score > best_score:
            best, best_score = candidate, score
    return best if best_score >= 0.8 else None


def scan(active_model: Optional[str] = None, active_projector: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    models: List[Dict[str, Any]] = []
    projectors: List[Dict[str, Any]] = []
    if MODELS_DIR.exists():
        for path in sorted(MODELS_DIR.glob("*.gguf"), key=lambda p: p.name.lower()):
            info = inspect_model(path)
            entry = {
                "filename": path.name,
                "size_bytes": info["size_bytes"],
                "arch": info["arch"],
                "n_layer": info["n_layer"],
                "n_ctx_train": info["n_ctx_train"],
                "valid": info["valid"],
                "error": info["error"],
                "is_projector": info["is_projector"],
                "is_active": path.name in (active_model, active_projector),
            }
            (projectors if info["is_projector"] else models).append(entry)
    names = [p["filename"] for p in projectors]
    for m in models:
        m["projector"] = pair_projector(m["filename"], names)
    return {"models": models, "projectors": projectors}
