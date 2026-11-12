"""Hugging Face discovery: search, per-repository file inspection and hardware-aware recommendations.

Recommendations are computed live from the Hugging Face catalog using only machine
characteristics (memory budgets, parameter count, architecture support). No model names
are hard-coded.
"""

import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

import requests

from .hardware import GIB, build_profile, memory_budgets
from .log import logger
from .planner import classify_fit

HF_URL = "https://huggingface.co"
CACHE_TTL_SEC = 1200
SPLIT_FILE = re.compile(r"-\d{5}-of-\d{5}", re.IGNORECASE)
QUANT_RE = re.compile(r"(IQ\d_[A-Z]+|Q\d_K_[MSL]|Q\d_K|Q\d_\d|MXFP4|BF16|F16|F32|Q\d)", re.IGNORECASE)

# Higher is better quality. Anything below Q3_K_M is never chosen automatically.
QUALITY_ORDER = ["F32", "F16", "BF16", "Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q5_1", "Q5_0", "Q4_K_M", "Q4_K_S",
                 "IQ4_XS", "Q4_1", "Q4_0", "Q3_K_L", "Q3_K_M", "IQ3_M", "IQ3_S", "Q3_K_S", "IQ3_XS", "Q2_K"]
MIN_AUTO_QUALITY = QUALITY_ORDER.index("Q3_K_M")
DEFAULT_QUANT = "Q4_K_M"

_cache: Dict[str, Any] = {}
_cache_lock = threading.Lock()


class StoreError(Exception):
    pass


def _headers() -> Dict[str, str]:
    headers = {"User-Agent": "SilkloraAI-Local-Hub/2.0"}
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _get_json(path: str, params: Optional[List] = None, timeout: int = 15):
    try:
        res = requests.get(f"{HF_URL}{path}", params=params, headers=_headers(), timeout=timeout)
    except requests.RequestException as e:
        raise StoreError(f"network: {e}")
    if res.status_code == 404:
        raise StoreError("not_found")
    if res.status_code in (401, 403):
        raise StoreError("forbidden")
    if not res.ok:
        raise StoreError(f"http_{res.status_code}")
    return res.json()


def parse_repo_id(raw: str) -> str:
    value = (raw or "").strip()
    value = re.sub(r"^https?://(www\.)?huggingface\.co/", "", value)
    value = re.sub(r"^models/", "", value)
    parts = [p for p in value.split("/") if p]
    if len(parts) >= 2 and "?" not in parts[0]:
        return f"{parts[0]}/{parts[1].split('?')[0].split('#')[0]}"
    return value


def quant_of(filename: str) -> str:
    match = QUANT_RE.search(filename)
    return match.group(1).upper() if match else ""


def is_projector_name(filename: str) -> bool:
    low = filename.lower()
    return "mmproj" in low or "projector" in low


def local_name(repo_id: str, filename: str) -> str:
    """Local file name; generic upstream names get the repository name as a prefix."""
    base = filename.rsplit("/", 1)[-1]
    repo_name = repo_id.split("/")[-1]
    key = re.sub(r"(?i)[-_.]?gguf$", "", repo_name).lower()
    key = re.sub(r"[^a-z0-9]", "", key)[:8]
    flat = re.sub(r"[^a-z0-9]", "", base.lower())
    if key and key in flat:
        return base
    return f"{re.sub(r'(?i)[-_.]?gguf$', '', repo_name)}-{base}"


def _candidate(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    repo_id = item.get("id") or item.get("modelId")
    if not repo_id:
        return None
    gguf = item.get("gguf") or {}
    total = gguf.get("total") or 0
    return {
        "repo_id": repo_id,
        "author": repo_id.split("/")[0] if "/" in repo_id else "",
        "name": repo_id.split("/")[-1],
        "downloads": item.get("downloads", 0) or 0,
        "likes": item.get("likes", 0) or 0,
        "params_b": round(total / 1e9, 1) if total else 0.0,
        "arch": gguf.get("architecture") or "",
        "ctx_train": gguf.get("context_length") or 0,
        "pipeline": item.get("pipeline_tag") or "",
    }


def _list_repos(filters: List[str], search: str = "", pipeline: str = "", limit: int = 100) -> List[Dict[str, Any]]:
    params: List = [("filter", f) for f in filters]
    params += [("sort", "downloads"), ("direction", "-1"), ("limit", str(limit))]
    for field in ("gguf", "downloads", "likes", "pipeline_tag"):
        params.append(("expand[]", field))
    if search:
        params.append(("search", search))
    if pipeline:
        params.append(("pipeline_tag", pipeline))
    items = _get_json("/api/models", params=params)
    out = []
    for item in items:
        cand = _candidate(item)
        if cand:
            out.append(cand)
    return out


def repo_files(repo_id: str) -> List[Dict[str, Any]]:
    """GGUF files in the repository root with sizes."""
    key = f"files:{repo_id}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL_SEC:
            return hit[1]
    tree = _get_json(f"/api/models/{repo_id}/tree/main")
    files = []
    for entry in tree:
        path = entry.get("path", "")
        if entry.get("type") != "file" or not path.lower().endswith(".gguf"):
            continue
        size = (entry.get("lfs") or {}).get("size") or entry.get("size") or 0
        files.append(
            {
                "filename": path,
                "size_bytes": int(size),
                "quant": quant_of(path),
                "is_projector": is_projector_name(path),
                "split": bool(SPLIT_FILE.search(path)),
            }
        )
    with _cache_lock:
        _cache[key] = (time.time(), files)
    return files


def _quality_rank(quant: str) -> int:
    try:
        return QUALITY_ORDER.index(quant)
    except ValueError:
        return len(QUALITY_ORDER)


def pick_file(files: List[Dict[str, Any]], hw: Dict[str, Any], prefer: str) -> Optional[Dict[str, Any]]:
    """Select the quantization that suits the machine.

    prefer: "fast" takes the best quality that fully fits fast memory,
            "stretch" takes the smallest decent quantization that still fits at all.
    """
    models = [f for f in files if not f["is_projector"] and not f["split"] and f["size_bytes"] > 0]
    if not models:
        return None
    ranked = sorted(models, key=lambda f: _quality_rank(f["quant"]))
    decent = [f for f in ranked if _quality_rank(f["quant"]) <= MIN_AUTO_QUALITY]

    if prefer == "fast":
        for f in decent:
            if classify_fit(f["size_bytes"], hw) in ("gpu_full", "cpu_ok") and f["quant"] not in ("F32", "F16", "BF16"):
                return f
        # Nothing fits at the preferred speed: fall through to the default quantization.
    default = [f for f in decent if f["quant"] == DEFAULT_QUANT]
    if default:
        return default[0]
    middle = [f for f in decent if f["quant"] not in ("F32", "F16", "BF16")]
    return middle[-1] if middle else decent[-1] if decent else None


def pick_projector(files: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    projectors = [f for f in files if f["is_projector"] and not f["split"]]
    if not projectors:
        return None
    for token in ("f16", "bf16"):
        for f in projectors:
            if token in f["filename"].lower():
                return f
    return sorted(projectors, key=lambda f: f["size_bytes"])[0]


def inspect_repo(repo_id: str, hw: Dict[str, Any], arch_check: Callable[[str], Optional[bool]]) -> Dict[str, Any]:
    files = repo_files(repo_id)
    info = _get_json(f"/api/models/{repo_id}", params=[("expand[]", "gguf"), ("expand[]", "downloads"), ("expand[]", "likes")])
    cand = _candidate(info) or {"repo_id": repo_id}
    for f in files:
        f["fit"] = "projector" if f["is_projector"] else classify_fit(f["size_bytes"], hw)
        f["local_name"] = local_name(repo_id, f["filename"])
    cand["files"] = files
    cand["arch_supported"] = arch_check(cand.get("arch", ""))
    cand["has_gguf"] = bool(files)
    if not files:
        try:
            cand["suggestions"] = _list_repos(["gguf"], search=repo_id.split("/")[-1], limit=10)
        except StoreError:
            cand["suggestions"] = []
    return cand


def search(query: str, kind: str, arch_check: Callable[[str], Optional[bool]]) -> List[Dict[str, Any]]:
    pipeline = "image-text-to-text" if kind == "vision" else ""
    results = _list_repos(["gguf"], search=query, pipeline=pipeline, limit=30)
    for r in results:
        r["arch_supported"] = arch_check(r["arch"])
    return results


def _fit_group(params_b: float, profile: Dict[str, Any]) -> str:
    est_gb = params_b * 0.6
    gpu = profile["gpu_budget_gb"]
    ram = profile["ram_budget_gb"]
    if profile["mode"] == "gpu":
        fast_limit = gpu * 0.95
        total_limit = gpu + ram * 0.7
    else:
        fast_limit = min(ram * 0.6, 6.0)
        total_limit = ram * 0.9
    if est_gb <= fast_limit:
        return "best" if est_gb >= fast_limit * 0.35 else "light"
    if est_gb <= total_limit:
        return "heavy"
    return ""


def recommendations(
    kind: str,
    hw: Dict[str, Any],
    arch_check: Callable[[str], Optional[bool]],
    installed: List[str],
    refresh: bool = False,
) -> Dict[str, Any]:
    profile = build_profile(hw)
    budgets = memory_budgets(hw)
    key = f"rec:{kind}:{budgets['gpu'] // GIB}:{budgets['ram'] // GIB}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit and not refresh and time.time() - hit[0] < CACHE_TTL_SEC:
            return _mark_installed(hit[1], installed)

    if kind == "vision":
        pool = _list_repos(["gguf"], pipeline="image-text-to-text", limit=100)
    else:
        pool = _list_repos(["gguf", "roleplay"], limit=100)
        if len(pool) < 25:
            seen = {c["repo_id"] for c in pool}
            pool += [c for c in _list_repos(["gguf"], pipeline="text-generation", limit=100) if c["repo_id"] not in seen]

    groups: Dict[str, List[Dict[str, Any]]] = {"best": [], "light": [], "heavy": []}
    for cand in pool:
        if cand["params_b"] <= 0:
            continue
        if arch_check(cand["arch"]) is False:
            continue
        group = _fit_group(cand["params_b"], profile)
        if group and len(groups[group]) < 6:
            groups[group].append(cand)

    chosen = [dict(c, group=g) for g, items in groups.items() for c in items]

    def enrich(cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            files = repo_files(cand["repo_id"])
        except StoreError:
            return None
        prefer = "stretch" if cand["group"] == "heavy" else "fast"
        main = pick_file(files, hw, prefer)
        if not main:
            return None
        projector = pick_projector(files)
        if kind == "vision" and not projector:
            return None
        cand["file"] = dict(main, local_name=local_name(cand["repo_id"], main["filename"]))
        cand["projector"] = dict(projector, local_name=local_name(cand["repo_id"], projector["filename"])) if projector else None
        cand["fit"] = classify_fit(main["size_bytes"], hw)
        if cand["fit"] == "too_big":
            return None
        cand["total_bytes"] = main["size_bytes"] + (projector["size_bytes"] if projector else 0)
        cand["arch_supported"] = arch_check(cand["arch"])
        return cand

    with ThreadPoolExecutor(max_workers=8) as pool_exec:
        enriched = [c for c in pool_exec.map(enrich, chosen) if c]

    order = {"best": 0, "light": 1, "heavy": 2}
    enriched.sort(key=lambda c: (order[c["group"]], -c["downloads"]))
    result = {"kind": kind, "profile": profile, "items": enriched, "generated_at": int(time.time())}
    with _cache_lock:
        _cache[key] = (time.time(), result)
    logger.info(f"Recommendations ready ({kind}): {len(enriched)} candidates")
    return _mark_installed(result, installed)


def _mark_installed(result: Dict[str, Any], installed: List[str]) -> Dict[str, Any]:
    names = set(installed)
    items = []
    for item in result["items"]:
        copy = dict(item)
        copy["installed"] = copy["file"]["local_name"] in names
        items.append(copy)
    return dict(result, items=items)
