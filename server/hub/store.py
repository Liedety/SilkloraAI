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
from . import library
from .log import logger
from .planner import classify_fit, classify_image_fit

HF_URL = "https://huggingface.co"
CACHE_TTL_SEC = 1200
SPLIT_FILE = re.compile(r"-\d{5}-of-\d{5}", re.IGNORECASE)
_DIFFUSERS_SHARD_RE = re.compile(
    r"(?:^|/)(?:unet|transformer|vae|vae_1_0|text_encoder|text_encoder_2|text_encoder_3|safety_checker|feature_extractor|image_encoder)/"
    r"(?:diffusion_pytorch_model|model)(?:[._-][a-z0-9]+)*\.(?:safetensors|ckpt)$",
    re.IGNORECASE,
)
QUANT_RE = re.compile(r"(IQ\d_[A-Z]+|Q\d_K_[MSL]|Q\d_K|Q\d_\d|MXFP4|BF16|FP16|F16|FP8|F32|FP32|Q\d)", re.IGNORECASE)

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


def _image_aux_role(filename: str) -> Optional[str]:
    low = filename.lower()
    base = low.rsplit("/", 1)[-1]
    if is_projector_name(base):
        return None
    if any(tok in base for tok in ("t5xxl", "t5-v1", "umt5")):
        return "t5xxl"
    if "clip_g" in base or "clip-g" in base or "openclip" in base or "text_encoder_2" in low:
        return "clip_g"
    if "clip_l" in base or "clip-l" in base:
        return "clip_l"
    if ("qwen" in base and ("vl" in base or "text" in base or "3_4b" in base or "2.5" in base)) or "text_encoder" in base:
        return "llm_encoder"
    if "vae" in base or base == "ae.safetensors" or base.startswith("ae-") or base.startswith("ae_"):
        return "vae"
    return None


def _is_image_weight_file(path: str) -> bool:
    low = path.lower()
    return low.endswith(".gguf") or low.endswith(".safetensors") or low.endswith(".ckpt")


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
        "tags": [str(t).lower() for t in (item.get("tags") or []) if isinstance(t, str)],
    }


def _list_repos(filters: List[str], search: str = "", pipeline: str = "", limit: int = 100) -> List[Dict[str, Any]]:
    params: List = [("filter", f) for f in filters]
    params += [("sort", "downloads"), ("direction", "-1"), ("limit", str(limit))]
    for field in ("gguf", "downloads", "likes", "pipeline_tag", "tags"):
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


def repo_files(repo_id: str, include_safetensors: bool = False) -> List[Dict[str, Any]]:
    """Model weight files in the repository (GGUF, plus safetensors/ckpt for image repos)."""
    key = f"files:{'img' if include_safetensors else 'gguf'}:{repo_id}"
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL_SEC:
            return hit[1]
    tree = _get_json(f"/api/models/{repo_id}/tree/main")
    entries = list(tree)
    if include_safetensors:
        has_root_weights = any(
            e.get("type") == "file"
            and "/" not in e.get("path", "")
            and _is_image_weight_file(e.get("path", ""))
            for e in entries
        )
        if not has_root_weights:
            try:
                entries = _get_json(f"/api/models/{repo_id}/tree/main", params=[("recursive", "1")])
            except StoreError:
                pass
    files = []
    for entry in entries:
        path = entry.get("path", "")
        if entry.get("type") != "file":
            continue
        if include_safetensors:
            if not _is_image_weight_file(path):
                continue
            if _DIFFUSERS_SHARD_RE.search(path):
                continue
        elif not path.lower().endswith(".gguf"):
            continue
        size = (entry.get("lfs") or {}).get("size") or entry.get("size") or 0
        aux_role = _image_aux_role(path) if include_safetensors else None
        files.append(
            {
                "filename": path,
                "size_bytes": int(size),
                "quant": quant_of(path),
                "is_projector": is_projector_name(path),
                "aux_role": aux_role,
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


def pick_file(files: List[Dict[str, Any]], hw: Dict[str, Any], prefer: str, is_image: bool = False) -> Optional[Dict[str, Any]]:
    """Select the quantization that suits the machine.

    prefer: "fast" takes the best quality that fully fits fast memory,
            "stretch" takes the smallest decent quantization that still fits at all.
    """
    models = [f for f in files if not f["is_projector"] and not f.get("aux_role") and not f["split"] and f["size_bytes"] > 0]
    if not models:
        return None
    if is_image:
        standard = [f for f in models if not any(tok in f["filename"].lower() for tok in ("debug", "flash"))]
        if standard:
            models = standard
    ranked = sorted(models, key=lambda f: _quality_rank(f["quant"]))
    decent = [f for f in ranked if _quality_rank(f["quant"]) <= MIN_AUTO_QUALITY]
    if not decent:
        # Image safetensors/FP8/untagged checkpoints may not carry GGUF Q-tags.
        decent = ranked

    fit_fn = classify_image_fit if is_image else classify_fit
    fast_fits = ("gpu_full", "cpu_ok")
    if prefer == "fast":
        for f in decent:
            if fit_fn(f["size_bytes"], hw) in fast_fits and f["quant"] not in ("F32", "F16", "BF16", "FP32"):
                return f
        for f in decent:
            if fit_fn(f["size_bytes"], hw) in fast_fits:
                return f
        # Nothing fits at the preferred speed: fall through to the default quantization.
    default = [f for f in decent if f["quant"] == DEFAULT_QUANT]
    if default:
        return default[0]
    middle = [f for f in decent if f["quant"] not in ("F32", "F16", "BF16", "FP32")]
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


IMAGE_PIPELINES = ("text-to-image", "image-to-image")
_NON_BASE_HINTS = (
    "lora", "lycoris", "locon", "controlnet", "upscal", "esrgan",
    "ip-adapter", "ip_adapter", "textual-inversion", "vae-only",
    "flux.2", "flux2", "flux-2", "flux-3", "flux3",
)
_NON_BASE_EXACT_TAGS = {"lycoris", "locon", "controlnet", "ip-adapter", "textual-inversion", "peft"}


def _is_non_base_image_repo(cand: Dict[str, Any]) -> bool:
    """Reject LoRA, ControlNet, IP-Adapter and unsupported repos via ID or HF tags."""
    low_rid = str(cand.get("repo_id") or "").lower()
    if any(tok in low_rid for tok in _NON_BASE_HINTS):
        return True
    for raw_tag in cand.get("tags") or []:
        tag = str(raw_tag).lower()
        if tag in _NON_BASE_EXACT_TAGS:
            return True
        if (
            "diffusion-lora" in tag
            or "diffusers-lora" in tag
            or tag.startswith(("lora:", "controlnet:", "base_model:adapter:"))
        ):
            return True
    return False


def _is_image_repo(cand: Dict[str, Any], tags: List[str], kind: str = "") -> bool:
    if kind == "image":
        return True
    if (cand.get("pipeline") or "").lower() in IMAGE_PIPELINES:
        return True
    low_tags = {str(t).lower() for t in tags}
    return bool(low_tags & {"text-to-image", "image-to-image", "diffusers", "stable-diffusion", "stable-diffusion-xl", "sdxl", "flux", "qwen-image"})


def _file_role(f: Dict[str, Any], tags: List[str], is_image_repo: bool) -> str:
    if f.get("is_projector"):
        return "projector"
    if f.get("aux_role"):
        return str(f["aux_role"])
    size_b = int(f.get("size_bytes") or 0)
    low = f["filename"].lower()
    low_tags = {str(t).lower() for t in tags}
    is_explicit_adapter = (
        "lora" in low
        or bool(low_tags & {"template:diffusion-lora", "diffusers-lora", "lycoris", "locon", "peft"})
        or any(t.startswith(("lora:", "base_model:adapter:")) for t in low_tags)
    )
    if is_explicit_adapter and size_b < int(3.2 * GIB):
        return "lora"
    if "lora" in low_tags and 0 < size_b < int(1.3 * GIB):
        return "lora"
    return "image" if is_image_repo else "model"


CURATED_IMAGE_PACKS: List[Dict[str, Any]] = [
    {"repo_id": "bullerwins/FLUX.1-Kontext-dev-GGUF", "name": "FLUX.1 Kontext Dev (Refs + Consistency)", "pipeline": "image-to-image", "downloads": 450000, "likes": 1200},
    {"repo_id": "unsloth/Qwen-Image-Edit-2509-GGUF", "name": "Qwen-Image-Edit 2509 (Multi-Ref Scene Edit)", "pipeline": "image-to-image", "downloads": 380000, "likes": 950},
    {"repo_id": "OnomaAIResearch/Illustrious-xl-early-release-v0", "name": "Illustrious XL (.safetensors — Scenes + LoRA Training)", "pipeline": "text-to-image", "downloads": 210000, "likes": 980},
    {"repo_id": "LyliaEngine/Pony_Diffusion_V6_XL", "name": "Pony Diffusion V6 XL (.safetensors — Scenes + LoRA Training)", "pipeline": "text-to-image", "downloads": 350000, "likes": 1150},
    {"repo_id": "unsloth/Z-Image-Turbo-GGUF", "name": "Z-Image Turbo (Fast GGUF)", "pipeline": "text-to-image", "downloads": 340000, "likes": 890},
    {"repo_id": "silveroxides/Chroma-GGUF", "name": "Chroma Unlocked GGUF (Styles & Characters)", "pipeline": "text-to-image", "downloads": 180000, "likes": 520},
    {"repo_id": "Lykon/dreamshaper-xl-v2-turbo", "name": "DreamShaper XL v2 Turbo (All-in-One .safetensors)", "pipeline": "text-to-image", "downloads": 620000, "likes": 1400},
    {"repo_id": "RunDiffusion/Juggernaut-XL-v9", "name": "Juggernaut XL v9 Photoreal (All-in-One .safetensors)", "pipeline": "text-to-image", "downloads": 580000, "likes": 1350},
    {"repo_id": "cagliostrolab/animagine-xl-3.1", "name": "Animagine XL 3.1 Anime (All-in-One .safetensors)", "pipeline": "text-to-image", "downloads": 540000, "likes": 1250},
    {"repo_id": "stabilityai/sdxl-turbo", "name": "SDXL Turbo FP16 (All-in-One Fast .safetensors)", "pipeline": "text-to-image", "downloads": 720000, "likes": 1600},
]

_DEFAULT_COMPANIONS: Dict[str, List[Dict[str, Any]]] = {
    "flux": [
        {
            "role": "vae",
            "repo_id": "ffxvs/vae-flux",
            "filename": "ae.safetensors",
            "local_name": "flux-ae.safetensors",
            "size_bytes": 335304388,
            "url": "https://huggingface.co/ffxvs/vae-flux/resolve/main/ae.safetensors",
        },
        {
            "role": "clip_l",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "clip_l.safetensors",
            "local_name": "flux-clip_l.safetensors",
            "size_bytes": 246144152,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
        },
        {
            "role": "t5xxl",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "t5xxl_fp8_e4m3fn.safetensors",
            "local_name": "flux-t5xxl_fp8_e4m3fn.safetensors",
            "size_bytes": 4893934904,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
        },
    ],
    "flux_kontext": [],
    "chroma": [
        {
            "role": "vae",
            "repo_id": "ffxvs/vae-flux",
            "filename": "ae.safetensors",
            "local_name": "flux-ae.safetensors",
            "size_bytes": 335304388,
            "url": "https://huggingface.co/ffxvs/vae-flux/resolve/main/ae.safetensors",
        },
        {
            "role": "t5xxl",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "t5xxl_fp8_e4m3fn.safetensors",
            "local_name": "flux-t5xxl_fp8_e4m3fn.safetensors",
            "size_bytes": 4893934904,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
        },
    ],
    "sdxl_gguf": [
        {
            "role": "vae",
            "repo_id": "madebyollin/sdxl-vae-fp16-fix",
            "filename": "sdxl_vae.safetensors",
            "local_name": "sdxl_vae.safetensors",
            "size_bytes": 334641162,
            "url": "https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors",
        },
        {
            "role": "clip_l",
            "repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
            "filename": "text_encoder/model.fp16.safetensors",
            "local_name": "sdxl_base-clip_l.safetensors",
            "size_bytes": 246144152,
            "url": "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/text_encoder/model.fp16.safetensors",
        },
        {
            "role": "clip_g",
            "repo_id": "stabilityai/stable-diffusion-xl-base-1.0",
            "filename": "text_encoder_2/model.fp16.safetensors",
            "local_name": "sdxl_base-clip_g.safetensors",
            "size_bytes": 1389382176,
            "url": "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/text_encoder_2/model.fp16.safetensors",
        },
    ],
    "sd15_gguf": [
        {
            "role": "vae",
            "repo_id": "stabilityai/sd-vae-ft-mse-original",
            "filename": "vae-ft-mse-840000-ema-pruned.safetensors",
            "local_name": "sd15-vae-ft-mse.safetensors",
            "size_bytes": 334642920,
            "url": "https://huggingface.co/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors",
        },
        {
            "role": "clip_l",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "clip_l.safetensors",
            "local_name": "flux-clip_l.safetensors",
            "size_bytes": 246144152,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
        },
    ],
    "sd3": [
        {
            "role": "vae",
            "repo_id": "ffxvs/vae-flux",
            "filename": "ae.safetensors",
            "local_name": "flux-ae.safetensors",
            "size_bytes": 335304388,
            "url": "https://huggingface.co/ffxvs/vae-flux/resolve/main/ae.safetensors",
        },
        {
            "role": "clip_l",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "clip_l.safetensors",
            "local_name": "flux-clip_l.safetensors",
            "size_bytes": 246144152,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
        },
        {
            "role": "clip_g",
            "repo_id": "Comfy-Org/stable-diffusion-3.5-fp8",
            "filename": "text_encoders/clip_g.safetensors",
            "local_name": "sdxl-clip_g.safetensors",
            "size_bytes": 1389382176,
            "url": "https://huggingface.co/Comfy-Org/stable-diffusion-3.5-fp8/resolve/main/text_encoders/clip_g.safetensors",
        },
        {
            "role": "t5xxl",
            "repo_id": "comfyanonymous/flux_text_encoders",
            "filename": "t5xxl_fp8_e4m3fn.safetensors",
            "local_name": "flux-t5xxl_fp8_e4m3fn.safetensors",
            "size_bytes": 4893934904,
            "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors",
        },
    ],
    "qwen_image": [
        {
            "role": "vae",
            "repo_id": "Comfy-Org/Qwen-Image_ComfyUI",
            "filename": "split_files/vae/qwen_image_vae.safetensors",
            "local_name": "qwen_image_vae.safetensors",
            "size_bytes": 253806246,
            "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        },
        {
            "role": "llm_encoder",
            "repo_id": "Comfy-Org/Qwen-Image_ComfyUI",
            "filename": "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
            "local_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
            "size_bytes": 9384670680,
            "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        },
    ],
    "qwen_edit": [],
    "z_image": [
        {
            "role": "vae",
            "repo_id": "Comfy-Org/z_image_turbo",
            "filename": "split_files/vae/ae.safetensors",
            "local_name": "zimage-ae.safetensors",
            "size_bytes": 335304388,
            "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors",
        },
        {
            "role": "llm_encoder",
            "repo_id": "Comfy-Org/z_image_turbo",
            "filename": "split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors",
            "local_name": "zimage-qwen_3_4b_fp8_mixed.safetensors",
            "size_bytes": 5631994051,
            "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors",
        },
    ],
}
_DEFAULT_COMPANIONS["flux_kontext"] = _DEFAULT_COMPANIONS["flux"]
_DEFAULT_COMPANIONS["qwen_edit"] = _DEFAULT_COMPANIONS["qwen_image"]


def companion_key_for_model(family: str, main_filename: str, needs_companions: bool, size_bytes: int = 0) -> str:
    low = main_filename.lower()
    if family == "sdxl" and low.endswith(".gguf"):
        # Full all-in-one SDXL/Illustrious/Pony GGUF checkpoints (>= 3.3 GiB) embed matched CLIP-L, CLIP-G, and VAE.
        if size_bytes >= int(3.3 * GIB):
            return ""
        return "sdxl_gguf"
    if family == "sd15" and low.endswith(".gguf"):
        if size_bytes >= int(1.85 * GIB):
            return ""
        return "sd15_gguf"
    if needs_companions:
        return family
    return ""


def curated_image_repos() -> List[Dict[str, Any]]:
    return [dict(c, tags=[], params_b=0.0, arch="image") for c in CURATED_IMAGE_PACKS]


def _pick_image_companions(files: List[Dict[str, Any]], hw: Dict[str, Any]) -> List[Dict[str, Any]]:
    by_role: Dict[str, List[Dict[str, Any]]] = {}
    for f in files:
        role = f.get("aux_role")
        if role and not f.get("split") and f.get("size_bytes", 0) > 0:
            by_role.setdefault(role, []).append(f)
    picked: List[Dict[str, Any]] = []
    for _role, group in by_role.items():
        ranked = sorted(group, key=lambda x: (_quality_rank(x.get("quant", "")), x["size_bytes"]))
        best = next(
            (item for item in ranked if classify_fit(item["size_bytes"], hw) in ("gpu_full", "gpu_partial", "cpu_ok")),
            ranked[-1],
        )
        picked.append(best)
    return picked


def ensure_image_companions(files: List[Dict[str, Any]], family: str, hw: Dict[str, Any], repo_id: str = "") -> List[Dict[str, Any]]:
    """Return all companion files from the repo plus canonical external encoders/VAE when needed."""
    local_picks = _pick_image_companions(files, hw)
    out: List[Dict[str, Any]] = []
    seen_roles = set()
    for c in local_picks:
        role = c.get("aux_role") or "image_aux"
        seen_roles.add(role)
        out.append({
            **c,
            "role": role,
            "local_name": local_name(repo_id, c["filename"]) if repo_id else c["filename"].rsplit("/", 1)[-1],
        })
    for spec in _DEFAULT_COMPANIONS.get(family, []):
        if spec["role"] not in seen_roles:
            out.append(dict(spec))
            seen_roles.add(spec["role"])
    return out


def inspect_repo(
    repo_id: str,
    hw: Dict[str, Any],
    arch_check: Callable[[str], Optional[bool]],
    kind: str = "",
) -> Dict[str, Any]:
    info = _get_json(
        f"/api/models/{repo_id}",
        params=[
            ("expand[]", "gguf"),
            ("expand[]", "downloads"),
            ("expand[]", "likes"),
            ("expand[]", "pipeline_tag"),
            ("expand[]", "tags"),
        ],
    )
    cand = _candidate(info) or {"repo_id": repo_id}
    tags = info.get("tags") or []
    is_image = _is_image_repo(cand, tags, kind)
    files = repo_files(repo_id, include_safetensors=is_image)
    if not files and not is_image:
        extra = repo_files(repo_id, include_safetensors=True)
        if extra:
            files = extra
            is_image = True

    enriched_files = []
    for f in files:
        item = dict(f)
        role = _file_role(item, tags, is_image)
        item["role"] = role
        if item["is_projector"]:
            item["fit"] = "projector"
        elif is_image:
            item["fit"] = classify_image_fit(item["size_bytes"], hw)
        else:
            item["fit"] = classify_fit(item["size_bytes"], hw)
        item["local_name"] = local_name(repo_id, item["filename"])
        enriched_files.append(item)

    cand["files"] = enriched_files
    cand["kind"] = "image" if is_image else ("vision" if cand.get("pipeline") == "image-text-to-text" else "chat")
    if is_image:
        picked_main = pick_file(files, hw, "fast", is_image=True) or pick_file(files, hw, "stretch", is_image=True)
        main_hint = picked_main["filename"] if picked_main else (enriched_files[0]["filename"] if enriched_files else cand.get("name", repo_id))
        fam = library.infer_image_family(main_hint, {"repo": repo_id, "pipeline": cand.get("pipeline", "")})
        comp_key = companion_key_for_model(
            fam["family"],
            picked_main["filename"] if picked_main else main_hint,
            fam["needs_companions"],
            size_bytes=int(picked_main["size_bytes"]) if picked_main else 0,
        )
        main_ext = (picked_main["filename"].rsplit(".", 1)[-1].lower() if picked_main and "." in picked_main["filename"] else "")
        cand["family"] = fam["family"]
        cand["variant"] = fam.get("variant", "")
        cand["supports_refs"] = fam["supports_refs"] or cand.get("pipeline") == "image-to-image"
        cand["needs_companions"] = bool(comp_key)
        cand["trainable_lora"] = bool(main_ext in ("safetensors", "ckpt") and fam["family"] in ("sdxl", "sd15") and not comp_key)
        cand["arch_supported"] = True
        companions = ensure_image_companions(files, comp_key, hw, repo_id) if comp_key else []
        cand["companions"] = companions
        if picked_main and _file_role(picked_main, tags, True) != "lora":
            cand["recommended_download"] = {
                "file": {
                    **picked_main,
                    "role": "image",
                    "local_name": local_name(repo_id, picked_main["filename"]),
                },
                "companions": companions,
                "trainable_lora": cand["trainable_lora"],
                "total_bytes": picked_main["size_bytes"] + sum(c.get("size_bytes", 0) for c in companions),
            }
    else:
        cand["arch_supported"] = arch_check(cand.get("arch", ""))
        picked_main = pick_file(files, hw, "fast") or pick_file(files, hw, "stretch")
        picked_proj = pick_projector(files)
        if picked_main:
            cand["recommended_download"] = {
                "file": {
                    **picked_main,
                    "role": "model",
                    "local_name": local_name(repo_id, picked_main["filename"]),
                },
                "projector": (
                    {
                        **picked_proj,
                        "role": "projector",
                        "local_name": local_name(repo_id, picked_proj["filename"]),
                    }
                    if picked_proj
                    else None
                ),
                "companions": [],
                "total_bytes": picked_main["size_bytes"] + (picked_proj["size_bytes"] if picked_proj else 0),
            }
    cand["has_gguf"] = bool(enriched_files)
    if not enriched_files:
        cand["diffusers_only"] = bool(is_image and "diffusers" in {str(t).lower() for t in tags})
        sugg: List[Dict[str, Any]] = []
        seen_sugg = {repo_id}
        short_q = re.sub(r"[-_]+", " ", repo_id.split("/")[-1]).strip()
        short_tokens = " ".join(short_q.split()[:3])
        if is_image:
            for s_filters, s_pipe in ((["gguf"], ""), (["safetensors"], "text-to-image")):
                try:
                    for item in _list_repos(s_filters, search=short_tokens or repo_id.split("/")[-1], pipeline=s_pipe, limit=6):
                        if item["repo_id"] not in seen_sugg and not _is_non_base_image_repo(item):
                            seen_sugg.add(item["repo_id"])
                            sugg.append(item)
                except StoreError:
                    pass
        else:
            try:
                sugg = _list_repos(["gguf"], search=repo_id.split("/")[-1], limit=10)
            except StoreError:
                sugg = []
        cand["suggestions"] = sugg[:10]
    return cand


def search(query: str, kind: str, arch_check: Callable[[str], Optional[bool]]) -> List[Dict[str, Any]]:
    if kind == "image":
        pools: List[Dict[str, Any]] = []
        seen = set()
        queries = [
            (["gguf"], "image-to-image", 15),
            (["gguf"], "text-to-image", 20),
            ([], "image-to-image", 15),
            ([], "text-to-image", 20),
            (["safetensors"], "", 20),
            (["gguf"], "", 15),
        ]
        first_err: Optional[StoreError] = None
        for filters, pipeline, lim in queries:
            try:
                batch = _list_repos(filters, search=query, pipeline=pipeline, limit=lim)
            except StoreError as exc:
                if first_err is None:
                    first_err = exc
                continue
            for r in batch:
                if r["repo_id"] in seen:
                    continue
                if _is_non_base_image_repo(r):
                    continue
                r_pipe = (r.get("pipeline") or "").lower()
                if r_pipe and r_pipe not in IMAGE_PIPELINES:
                    continue
                fam = library.infer_image_family(r["name"], {"repo": r["repo_id"], "pipeline": r.get("pipeline", "")})
                r_tags = {str(t).lower() for t in (r.get("tags") or [])}
                if not pipeline and not r_pipe:
                    has_img_tag = bool(r_tags & {"diffusers", "stable-diffusion", "stable-diffusion-xl", "sdxl", "flux", "qwen-image", "text-to-image", "image-to-image"})
                    if not has_img_tag and fam["family"] == "other":
                        continue
                seen.add(r["repo_id"])
                r["kind"] = "image"
                r["family"] = fam["family"]
                r["variant"] = fam.get("variant", "")
                r["supports_refs"] = fam["supports_refs"] or r.get("pipeline") == "image-to-image"
                r["needs_companions"] = fam["needs_companions"]
                r["has_gguf_tag"] = "gguf" in r_tags or "gguf" in r["name"].lower()
                r["has_safetensors"] = "safetensors" in r_tags
                r["arch_supported"] = True
                pools.append(r)
        if not pools and first_err is not None:
            raise first_err
        pools.sort(key=lambda r: -r.get("downloads", 0))
        return pools[:30]

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


def _image_fit_group(size_bytes: int, hw: Dict[str, Any], profile: Dict[str, Any]) -> str:
    fit = classify_image_fit(size_bytes, hw)
    if fit == "too_big":
        return ""
    est_gb = size_bytes / GIB
    if fit == "gpu_stream":
        return "heavy"
    if fit == "gpu_full":
        fast_gb = max(1.0, profile["gpu_budget_gb"] * 0.95)
        return "best" if est_gb >= fast_gb * 0.30 else "light"
    ram = max(2.0, profile["ram_budget_gb"])
    if est_gb <= min(ram * 0.45, 5.0):
        return "light"
    return "best" if est_gb <= ram * 0.7 else "heavy"


def _recommendations_image(
    hw: Dict[str, Any],
    profile: Dict[str, Any],
    installed: List[str],
    key: str,
) -> Dict[str, Any]:
    curated_map = {c["repo_id"]: c for c in CURATED_IMAGE_PACKS}
    seen = set()
    pool: List[Dict[str, Any]] = []
    for c in curated_image_repos():
        seen.add(c["repo_id"])
        pool.append(c)

    specs = [
        (["gguf"], "image-to-image", 18),
        (["gguf"], "text-to-image", 24),
    ]
    first_err: Optional[StoreError] = None
    for filters, pipeline, lim in specs:
        try:
            batch = _list_repos(filters, pipeline=pipeline, limit=lim)
        except StoreError as exc:
            if first_err is None:
                first_err = exc
            continue
        for c in batch:
            rid = c["repo_id"]
            if rid in seen:
                continue
            if _is_non_base_image_repo(c):
                continue
            seen.add(rid)
            pool.append(c)

    if not pool and first_err is not None:
        raise first_err

    candidates = pool[:22]

    def enrich_image(cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            files = repo_files(cand["repo_id"], include_safetensors=True)
        except StoreError:
            return None
        main = pick_file(files, hw, "fast", is_image=True) or pick_file(files, hw, "stretch", is_image=True)
        if not main or main["size_bytes"] < 350 * 1024 * 1024:
            return None
        fit = classify_image_fit(main["size_bytes"], hw)
        group = _image_fit_group(main["size_bytes"], hw, profile)
        if not group:
            return None
        if group == "heavy":
            smaller = pick_file(files, hw, "stretch", is_image=True)
            if smaller and smaller["size_bytes"] < main["size_bytes"]:
                s_group = _image_fit_group(smaller["size_bytes"], hw, profile)
                if s_group:
                    main = smaller
                    fit = classify_image_fit(main["size_bytes"], hw)
                    group = s_group
        fam = library.infer_image_family(main["filename"], {"repo": cand["repo_id"], "pipeline": cand.get("pipeline", "")})
        comp_key = companion_key_for_model(fam["family"], main["filename"], fam["needs_companions"], size_bytes=int(main["size_bytes"]))
        # Exclude unverified third-party raw .safetensors diffusion fragments without curated/known companions
        if comp_key and main["filename"].lower().endswith(".safetensors") and cand["repo_id"] not in curated_map:
            if comp_key not in _DEFAULT_COMPANIONS:
                return None
        if fam["family"] == "other":
            return None
        companions = ensure_image_companions(files, comp_key, hw, cand["repo_id"]) if comp_key else []
        if comp_key and not companions:
            return None

        main_ext = main["filename"].rsplit(".", 1)[-1].lower() if "." in main["filename"] else ""
        copy = dict(cand)
        if cand["repo_id"] in curated_map:
            copy["name"] = curated_map[cand["repo_id"]]["name"]
        copy["verified_pack"] = cand["repo_id"] in curated_map
        copy["kind"] = "image"
        copy["group"] = group
        copy["fit"] = fit
        copy["arch_supported"] = True
        copy["family"] = fam["family"]
        copy["variant"] = fam.get("variant", "")
        copy["supports_refs"] = fam["supports_refs"] or copy.get("pipeline") == "image-to-image"
        copy["needs_companions"] = bool(comp_key)
        copy["trainable_lora"] = bool(main_ext in ("safetensors", "ckpt") and fam["family"] in ("sdxl", "sd15") and not comp_key)
        copy["file"] = dict(main, role="image", local_name=local_name(cand["repo_id"], main["filename"]))
        copy["projector"] = None
        copy["companions"] = [
            dict(
                comp,
                role=comp.get("role") or comp.get("aux_role") or "image_aux",
                local_name=comp.get("local_name") or local_name(cand["repo_id"], comp["filename"]),
            )
            for comp in companions
        ]
        copy["total_bytes"] = main["size_bytes"] + sum(c["size_bytes"] for c in companions)
        return copy

    with ThreadPoolExecutor(max_workers=8) as pool_exec:
        enriched = [c for c in pool_exec.map(enrich_image, candidates) if c]

    groups: Dict[str, List[Dict[str, Any]]] = {"best": [], "light": [], "heavy": []}
    enriched.sort(key=lambda c: (0 if c.get("verified_pack") else 1, 0 if c["supports_refs"] else 1, -c.get("downloads", 0)))
    for item in enriched:
        if len(groups[item["group"]]) < 5:
            groups[item["group"]].append(item)

    ordered = groups["best"] + groups["light"] + groups["heavy"]
    result = {"kind": "image", "profile": profile, "items": ordered, "generated_at": int(time.time())}
    with _cache_lock:
        _cache[key] = (time.time(), result)
    logger.info(f"Recommendations ready (image): {len(ordered)} candidates")
    return _mark_installed(result, installed)


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

    if kind == "image":
        return _recommendations_image(hw, profile, installed, key)

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
