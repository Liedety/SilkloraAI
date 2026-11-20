"""Local model library: scan models/, classify files by GGUF header, pair vision projectors."""

import difflib
import json
import re
import shutil
import threading
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from .gguf import inspect_model
from .paths import DATA_DIR, IMAGE_AUX_DIR, IMAGE_MODELS_DIR, LORAS_DIR, MODELS_DIR

META_FILE = DATA_DIR / "models_meta.json"
_meta_lock = threading.Lock()
_GIB = 1024 ** 3

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


_IMAGE_WEIGHT_EXTS = {".gguf", ".safetensors", ".ckpt"}
_LORA_EXTS = {".safetensors", ".pt", ".ckpt"}


_CHROMA_RE = re.compile(r"(?:^|[/\-_.\s])(?:chroma|chromafur|chroma1|kroma)(?:$|[/\-_.\s\d]|v\d)", re.IGNORECASE)
_XL_TOKEN_RE = re.compile(r"(?:^|[/\-_.\s])xl(?:$|[/\-_.\s\d])", re.IGNORECASE)


def _infer_variant(low: str, family: str) -> str:
    if family == "chroma" and "flash" in low:
        return "chroma_flash"
    if family == "sdxl":
        if any(tok in low for tok in ("pony", "pdxl", "autismmix", "cyberrealisticpony", "furrytoon", "indigo_furry")):
            return "pony"
        if any(tok in low for tok in ("illustrious", "ilxl", "noobai", "noob-xl", "noob_xl", "noob", "wai-nsfw", "wainsfw", "hassaku", "nova-furry-xl-il")):
            return "illustrious"
        if any(tok in low for tok in ("animagine", "kohaku-xl", "kohakuxl", "aam-xl", "counterfeitxl")):
            return "animagine"
    return ""


def infer_image_family(filename: str, meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Classify an image generation model by filename/repo metadata into family, variant, and capabilities."""
    repo = str((meta or {}).get("repo") or "").lower()
    src = str((meta or {}).get("source_file") or "").lower()
    explicit = str((meta or {}).get("family") or "").lower()
    low = f"{filename} {repo} {src}".lower()
    low_no_xxl = re.sub(r"t5[-_]?xxl|umt5[-_]?xxl|xxl", "", low)

    if explicit in ("flux_kontext", "qwen_edit", "qwen_image", "z_image", "flux", "chroma", "sd3", "sdxl", "sd15"):
        return {
            "family": explicit,
            "variant": str((meta or {}).get("variant") or _infer_variant(low, explicit)),
            "supports_refs": explicit in ("flux_kontext", "qwen_edit"),
            "supports_lora": True,
            "needs_companions": explicit in ("flux_kontext", "qwen_edit", "qwen_image", "z_image", "flux", "chroma", "sd3"),
        }

    if "kontext" in low:
        return {"family": "flux_kontext", "variant": "", "supports_refs": True, "supports_lora": True, "needs_companions": True}
    if "qwen" in low and ("edit" in low or "2511" in low or "2509" in low):
        return {"family": "qwen_edit", "variant": "", "supports_refs": True, "supports_lora": True, "needs_companions": True}
    if "qwen" in low and ("image" in low or "qwenimage" in low):
        return {"family": "qwen_image", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": True}
    if "z-image" in low or "z_image" in low or "zimage" in low:
        return {"family": "z_image", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": True}
    if _CHROMA_RE.search(low) or "krea2-kroma" in low:
        return {"family": "chroma", "variant": _infer_variant(low, "chroma"), "supports_refs": False, "supports_lora": True, "needs_companions": True}
    if "flux" in low or "krea" in low:
        return {"family": "flux", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": True}
    if "sd3" in low or "sd3.5" in low or "sd-3" in low or "stable-diffusion-3" in low:
        return {"family": "sd3", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": True}
    if any(
        tok in low_no_xxl
        for tok in (
            "sdxl", "sd-xl", "sd_xl", "illustrious", "ilxl", "pony", "pdxl", "noob",
            "juggernautxl", "juggernaut-xl", "animagine", "dreamshaperxl", "dreamshaper-xl",
            "realvisxl", "realvis-xl", "wai-nsfw", "wainsfw", "autismmix", "cyberrealisticpony",
            "furrytoon", "indigo_furry", "indigofurry", "nova-furry", "novafurry", "kohakuxl",
            "kohaku-xl", "albedobase", "proteus", "playground-v2",
        )
    ) or bool(_XL_TOKEN_RE.search(low_no_xxl)):
        return {"family": "sdxl", "variant": _infer_variant(low, "sdxl"), "supports_refs": False, "supports_lora": True, "needs_companions": False}
    if any(
        tok in low
        for tok in (
            "sd15", "sd1.5", "sd-1-5", "sd_1_5", "v1-5", "stable-diffusion-v1",
            "dreamshaper", "realisticvision", "realistic_vision", "counterfeit",
            "revanimated", "rev_animated", "anything-v", "abyssorangemix", "meinamix",
            "epicrealism", "cyberrealistic", "fluffyrock", "yiffymix", "furrydiffusion",
            "furry_diffusion", "furry-diffusion", "deliberate", "majicmix", "toonify",
        )
    ):
        return {"family": "sd15", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": False}
    return {"family": "other", "variant": "", "supports_refs": False, "supports_lora": True, "needs_companions": False}


def _classify_tensor_names(keys: List[str]) -> Dict[str, Any]:
    """Classify image weights from tensor names (works for full safetensors & GGUF headers)."""
    result: Dict[str, Any] = {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    if not keys:
        return result

    low_keys = [k.lower() for k in keys]
    joined = " ".join(low_keys)
    has_lora = any(
        k.startswith("lora_")
        or ".lora_a." in k
        or ".lora_b." in k
        or "lora_down" in k
        or "lora_up" in k
        or ".hada_w1" in k
        or ".lokr_w1" in k
        for k in low_keys
    )
    has_vae = any(
        "first_stage_model." in k or k.startswith("vae.") or ("decoder.conv_in" in k and "encoder.conv_in" in k)
        for k in low_keys
    )
    has_clip = any(
        "cond_stage_model." in k or "conditioner.embedders." in k or "text_encoders." in k or "text_model.embeddings" in k
        for k in low_keys
    )
    has_unet = any(
        "diffusion_model." in k
        or k.startswith("unet.")
        or "double_blocks." in k
        or "single_blocks." in k
        or "joint_blocks." in k
        or "transformer_blocks." in k
        or "noise_refiner." in k
        for k in low_keys
    )

    result["has_vae"] = has_vae
    result["has_clip"] = has_clip

    if has_lora and not (has_vae or has_clip):
        # Note: LoRA keys often contain "diffusion_model." or "double_blocks." inside the adapted module path
        is_pure_lora = all(
            any(tok in k for tok in ("lora", "alpha", "hada_", "lokr_", "dora_scale"))
            for k in low_keys[:32]
        )
        if is_pure_lora or not has_unet:
            result["weight_role"] = "lora"
            result["arch_hint"] = "lora"
            return result

    if has_unet and (has_clip or has_vae):
        result["weight_role"] = "checkpoint"
        if "joint_blocks." in joined:
            result["arch_hint"] = "sd3"
        elif "conditioner.embedders." in joined:
            result["arch_hint"] = "sdxl"
        elif "cond_stage_model." in joined:
            result["arch_hint"] = "sd15"
        return result

    if has_unet:
        result["weight_role"] = "diffusion_model"
        if "double_blocks." in joined and "single_blocks." in joined:
            result["arch_hint"] = "chroma" if "distilled_guidance_layer" in joined or "mod_index" in joined else "flux"
        elif "noise_refiner." in joined or "cap_embedder." in joined:
            result["arch_hint"] = "z_image"
        elif "transformer_blocks." in joined and ("img_mod" in joined or "txt_mod" in joined):
            result["arch_hint"] = "qwen_image"
        elif "joint_blocks." in joined:
            result["arch_hint"] = "sd3"
        elif "label_emb." in joined or "input_blocks.8." in joined:
            # SDXL UNet goes up to input_blocks.8 (3 stages), SD1.5 goes up to input_blocks.11 (4 stages)
            result["arch_hint"] = "sd15" if "input_blocks.11." in joined else "sdxl"
        elif "input_blocks.11." in joined:
            result["arch_hint"] = "sd15"
        return result

    if has_vae and not has_unet:
        result["weight_role"] = "vae"
        return result

    return result


def inspect_safetensors_header(path: Any) -> Dict[str, Any]:
    """Read only the JSON header of a .safetensors file to classify checkpoint vs diffusion-only vs LoRA."""
    result: Dict[str, Any] = {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    try:
        with open(path, "rb") as fh:
            len_bytes = fh.read(8)
            if len(len_bytes) < 8:
                return result
            header_len = int.from_bytes(len_bytes, "little")
            if header_len <= 0 or header_len > 32 * 1024 * 1024:
                return result
            raw = fh.read(min(header_len, 16 * 1024 * 1024)).decode("utf-8", errors="replace")
            if len_bytes and header_len <= 16 * 1024 * 1024:
                header = json.loads(raw)
                keys = [k for k in header.keys() if k != "__metadata__"]
            else:
                keys = [k for k in re.findall(r'"([^"]+)"\s*:\s*\{', raw) if k != "__metadata__"]
    except Exception:
        return result
    return _classify_tensor_names(keys)


def is_lora_compatible_with_family(lora_arch: str, model_family: str) -> bool:
    """Return True if a LoRA's base architecture is compatible with the selected base model family."""
    la = (lora_arch or "").strip().lower()
    mf = (model_family or "").strip().lower()
    if not la or not mf or mf == "other":
        return True
    if la == mf:
        return True
    for group in (
        {"flux", "flux_kontext"},
        {"qwen", "qwen_image", "qwen_edit"},
        {"sdxl", "illustrious", "pony", "animagine", "noob"},
        {"chroma", "kroma"},
        {"sd3", "sd35"},
        {"sd15", "sd1.5"},
    ):
        if la in group and mf in group:
            return True
    return False


def inspect_lora_header(path: Any) -> Dict[str, Any]:
    """Inspect .safetensors LoRA header metadata & tensor keys to infer base_arch, trigger_word, and role."""
    p = Path(path)
    low_name = p.name.lower()
    meta_dict: Dict[str, Any] = {}
    keys: List[str] = []
    if p.suffix.lower() == ".safetensors":
        try:
            with open(p, "rb") as fh:
                len_bytes = fh.read(8)
                if len(len_bytes) == 8:
                    header_len = int.from_bytes(len_bytes, "little")
                    if 0 < header_len <= 32 * 1024 * 1024:
                        raw = fh.read(min(header_len, 16 * 1024 * 1024)).decode("utf-8", errors="replace")
                        if header_len <= 16 * 1024 * 1024:
                            parsed = json.loads(raw)
                            if isinstance(parsed.get("__metadata__"), dict):
                                meta_dict = parsed["__metadata__"]
                            keys = [k.lower() for k in parsed.keys() if k != "__metadata__"]
                        else:
                            keys = [k.lower() for k in re.findall(r'"([^"]+)"\s*:\s*\{', raw) if k != "__metadata__"]
        except Exception:
            pass

    role_check = _classify_tensor_names(keys) if keys else {"weight_role": "unknown"}
    is_full_model = role_check.get("weight_role") in ("checkpoint", "diffusion_model")

    meta_blob = " ".join(
        str(meta_dict.get(k) or "")
        for k in ("ss_base_model_version", "modelspec.architecture", "base_model", "ss_sd_model_name")
    ).lower()
    combined = f"{low_name} {meta_blob}"
    joined_keys = " ".join(keys)

    base_arch = ""
    if _CHROMA_RE.search(combined) or "krea2-kroma" in combined or "distilled_guidance_layer" in joined_keys or "mod_index" in joined_keys:
        base_arch = "chroma"
    elif "qwen" in combined or ("img_mod" in joined_keys and "transformer_blocks" in joined_keys):
        base_arch = "qwen"
    elif "z-image" in combined or "z_image" in combined or "zimage" in combined or "noise_refiner" in joined_keys:
        base_arch = "z_image"
    elif "flux" in combined or ("double_blocks" in joined_keys or "single_blocks" in joined_keys or "single_transformer_blocks" in joined_keys):
        base_arch = "flux"
    elif "sd3" in combined or "joint_blocks" in joined_keys:
        base_arch = "sd3"
    elif (
        any(tok in combined for tok in ("sdxl", "xl", "illustrious", "ilxl", "pony", "pdxl", "noob", "animagine"))
        or "lora_te1_" in joined_keys
        or "lora_te2_" in joined_keys
        or "text_encoder_2" in joined_keys
    ):
        base_arch = "sdxl"
    elif (
        any(tok in combined for tok in ("sd15", "sd_v1", "sd1.5", "v1-5"))
        or "lora_te_text_model" in joined_keys
        or "input_blocks_11" in joined_keys
        or "down_blocks_3" in joined_keys
    ):
        base_arch = "sd15"

    trigger = ""
    for tk in ("modelspec.trigger_phrase", "trigger_word", "activation text", "ss_activation_text"):
        val = str(meta_dict.get(tk) or "").strip().strip(",")
        if val and len(val) <= 64 and "\n" not in val and "{" not in val:
            trigger = val
            break

    return {"base_arch": base_arch, "trigger_word": trigger, "is_full_model": is_full_model}


def inspect_image_gguf_header(path: Any) -> Dict[str, Any]:
    """Inspect initial GGUF header bytes to distinguish all-in-one checkpoints from standalone diffusion models."""
    try:
        with open(path, "rb") as fh:
            buf = fh.read(2 * 1024 * 1024)
    except Exception:
        return {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    if buf[:4] != b"GGUF":
        return {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    tokens = re.findall(rb"[A-Za-z0-9_.\-]{6,96}", buf)
    keys = [t.decode("ascii", errors="ignore") for t in tokens if b"." in t]
    return _classify_tensor_names(keys)


def inspect_ckpt_header(path: Any) -> Dict[str, Any]:
    """Safely inspect PyTorch .ckpt tensor names without executing pickle."""
    raw = b""
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path, "r") as zf:
                pkl_names = [n for n in zf.namelist() if n.endswith("data.pkl") or n.endswith(".pkl")]
                if pkl_names:
                    with zf.open(pkl_names[0], "r") as fh:
                        raw = fh.read(512 * 1024)
        else:
            with open(path, "rb") as fh:
                raw = fh.read(512 * 1024)
    except Exception:
        return {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    if not raw:
        return {"weight_role": "unknown", "arch_hint": "", "has_vae": False, "has_clip": False}
    tokens = re.findall(rb"[A-Za-z0-9_.\-]{6,96}", raw)
    keys = [t.decode("ascii", errors="ignore") for t in tokens if b"." in t]
    return _classify_tensor_names(keys)


def _aux_role(filename: str) -> str:
    low = filename.lower()
    if "t5" in low or "umt5" in low:
        return "t5xxl"
    if "clip_g" in low or "clip-g" in low or "text_encoder_2" in low or "openclip" in low:
        return "clip_g"
    if "clip_l" in low or "clip-l" in low or ("clip" in low and "g" not in low):
        return "clip_l"
    if "qwen" in low or "vl" in low or "llm" in low:
        return "llm_encoder"
    if "vae" in low or low == "ae.safetensors" or low.endswith("/ae.safetensors") or low.endswith("-ae.safetensors") or low.endswith("_ae.safetensors"):
        return "vae"
    return "other"


def is_aux_compatible_with_family(aux_filename: str, role: str, family: str) -> bool:
    """Ensure foreign VAEs / CLIP / LLM encoders from other model families are not mismatched automatically."""
    low = aux_filename.lower()
    low_no_xxl = re.sub(r"t5[-_]?xxl|umt5[-_]?xxl|xxl", "", low)
    is_sdxl_named = (
        any(tok in low_no_xxl for tok in ("sdxl", "sd_xl", "sd-xl", "noob", "pony", "illustrious", "ilxl", "animagine", "indigo", "furry", "xl_", "_xl", "-xl"))
        or bool(_XL_TOKEN_RE.search(low_no_xxl))
    )
    if role == "vae":
        is_flux_ae = (
            low == "ae.safetensors"
            or low.endswith("-ae.safetensors")
            or low.endswith("_ae.safetensors")
            or "flux" in low
            or "chroma" in low
            or "zimage" in low
            or "z-image" in low
        )
        is_qwen_vae = "qwen" in low
        is_sd3_vae = "sd3" in low
        is_sd15_vae = "sd15" in low or "sd1.5" in low or "ft-mse" in low or "vae-ft" in low

        if family in ("flux", "flux_kontext", "chroma", "z_image"):
            return is_flux_ae and not (is_qwen_vae or is_sdxl_named or is_sd15_vae or is_sd3_vae)
        if family == "sd3":
            return (is_flux_ae or is_sd3_vae) and not (is_qwen_vae or is_sdxl_named or is_sd15_vae)
        if family in ("qwen_image", "qwen_edit"):
            return is_qwen_vae
        if family == "sdxl":
            return not (is_flux_ae or is_qwen_vae or is_sd15_vae or is_sd3_vae)
        if family == "sd15":
            return not (is_flux_ae or is_qwen_vae or is_sdxl_named or is_sd3_vae)
        return True

    if role == "clip_l":
        if family in ("flux", "flux_kontext", "sd3"):
            return not is_sdxl_named
        return True

    if role == "clip_g":
        if family == "sdxl":
            return "sd3" not in low
        return True

    if role == "llm_encoder":
        is_qwen3 = "qwen_3" in low or "qwen3" in low or "zimage" in low or "z-image" in low
        is_qwen25_vl = "qwen_2.5" in low or "qwen2.5" in low or "vl" in low or "qwen-image" in low or "qwen_image" in low
        if family == "z_image":
            return not is_qwen25_vl
        if family in ("qwen_image", "qwen_edit"):
            return not is_qwen3
        return True

    return True


def required_companion_roles(family: str, weight_role: str = "diffusion_model") -> List[str]:
    """Return required auxiliary companion roles for a standalone diffusion model."""
    if weight_role == "checkpoint":
        return []
    roles = ["vae"]
    if family in ("flux", "flux_kontext", "sd3"):
        roles += ["clip_l", "t5xxl"]
    elif family == "chroma":
        roles += ["t5xxl"]
    elif family in ("qwen_image", "qwen_edit", "z_image"):
        roles += ["llm_encoder"]
    elif family == "sdxl":
        roles += ["clip_l", "clip_g"]
    elif family == "sd15":
        roles += ["clip_l"]
    return roles


def _quant_tag(filename: str) -> str:
    m = re.search(r"(IQ\d_[A-Z]+|Q\d_K_[MSL]|Q\d_K|Q\d_\d|Q\d|FP16|F16|BF16|FP8|FP32)", filename, re.IGNORECASE)
    return m.group(1).upper() if m else ""


def scan_image_library(active_model: Optional[str] = None) -> Dict[str, Any]:
    """Scan local image models (models/image/), auxiliary encoders/VAE (models/image_aux/), and LoRAs (models/loras/)."""
    aux_files: List[Dict[str, Any]] = []
    if IMAGE_AUX_DIR.exists():
        for path in sorted(IMAGE_AUX_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not path.is_file() or path.suffix.lower() not in _IMAGE_WEIGHT_EXTS:
                continue
            meta = get_meta(f"image_aux/{path.name}")
            aux_files.append({
                "filename": path.name,
                "size_bytes": path.stat().st_size,
                "role": meta.get("aux_role") or _aux_role(path.name),
                "repo": meta.get("repo", ""),
            })

    models: List[Dict[str, Any]] = []
    if IMAGE_MODELS_DIR.exists():
        for path in sorted(IMAGE_MODELS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not path.is_file() or path.suffix.lower() not in _IMAGE_WEIGHT_EXTS:
                continue
            size_bytes = path.stat().st_size
            meta = get_meta(f"image/{path.name}")
            info = infer_image_family(path.name, meta)
            fmt = path.suffix.lower().lstrip(".")
            weight_role = meta.get("weight_role", "")
            if fmt == "safetensors" and (not weight_role or info["family"] == "other"):
                hdr = inspect_safetensors_header(path)
                if not weight_role:
                    weight_role = hdr["weight_role"]
                if hdr["arch_hint"] and info["family"] in ("other", "sdxl", "sd15"):
                    if hdr["arch_hint"] in ("flux", "chroma", "sd3", "qwen_image", "z_image", "sdxl", "sd15"):
                        info = infer_image_family(path.name, {**meta, "family": hdr["arch_hint"]})
            elif fmt == "gguf" and (not weight_role or info["family"] == "other"):
                hdr = inspect_image_gguf_header(path)
                if not weight_role:
                    weight_role = hdr["weight_role"] if hdr["weight_role"] in ("checkpoint", "diffusion_model", "lora") else "diffusion_model"
                if hdr["arch_hint"] and info["family"] in ("other", "sdxl", "sd15"):
                    if hdr["arch_hint"] in ("flux", "chroma", "sd3", "qwen_image", "z_image", "sdxl", "sd15"):
                        info = infer_image_family(path.name, {**meta, "family": hdr["arch_hint"]})
            elif fmt == "ckpt" and (not weight_role or info["family"] == "other"):
                hdr = inspect_ckpt_header(path)
                if not weight_role and hdr["weight_role"] != "unknown":
                    weight_role = hdr["weight_role"]
                if hdr["arch_hint"] and info["family"] in ("other", "sdxl", "sd15"):
                    if hdr["arch_hint"] in ("sdxl", "sd15"):
                        info = infer_image_family(path.name, {**meta, "family": hdr["arch_hint"]})

            family = info["family"]
            variant = info.get("variant", "")
            resolved_weight_role = weight_role if weight_role and weight_role != "unknown" else ("diffusion_model" if fmt == "gguf" else "checkpoint")
            if resolved_weight_role == "checkpoint" and family == "other":
                family = "sd15" if size_bytes < int(4.8 * _GIB) else "sdxl"

            needs_comp = bool(meta.get("needs_companions", info["needs_companions"]))
            if resolved_weight_role == "diffusion_model":
                needs_comp = True
            elif resolved_weight_role == "checkpoint":
                needs_comp = False

            missing_roles: List[str] = []
            if needs_comp and resolved_weight_role != "lora":
                rec_comp = meta.get("companions") or {}
                for r in required_companion_roles(family, resolved_weight_role):
                    mapped = rec_comp.get(r)
                    has_mapped = bool(mapped and (IMAGE_AUX_DIR / mapped).is_file())
                    has_compat = any(
                        a["role"] == r and is_aux_compatible_with_family(a["filename"], r, family)
                        for a in aux_files
                    )
                    if not has_mapped and not has_compat:
                        missing_roles.append(r)

            models.append({
                "filename": path.name,
                "size_bytes": size_bytes,
                "format": fmt,
                "quant": _quant_tag(path.name),
                "family": family,
                "variant": variant,
                "weight_role": resolved_weight_role,
                "trainable_lora": bool(
                    fmt in ("safetensors", "ckpt")
                    and family in ("sdxl", "sd15")
                    and resolved_weight_role == "checkpoint"
                ),
                "supports_refs": bool(meta.get("supports_refs", info["supports_refs"])),
                "supports_lora": bool(meta.get("supports_lora", info["supports_lora"])),
                "needs_companions": needs_comp,
                "missing_companions": missing_roles,
                "ready_to_run": resolved_weight_role != "lora" and len(missing_roles) == 0,
                "repo": meta.get("repo", ""),
                "companions": meta.get("companions", {}) if needs_comp else {},
                "is_active": bool(active_model and path.name == active_model),
            })

    active_entry = next((m for m in models if m.get("is_active")), None)
    active_family = str(active_entry["family"]) if active_entry else ""

    loras: List[Dict[str, Any]] = []
    if LORAS_DIR.exists():
        for path in sorted(LORAS_DIR.iterdir(), key=lambda p: p.name.lower()):
            if not path.is_file() or path.suffix.lower() not in _LORA_EXTS:
                continue
            meta = get_meta(f"loras/{path.name}")
            base_arch = str(meta.get("base_arch") or "").strip()
            trigger_word = str(meta.get("trigger_word") or "").strip()
            inspected = inspect_lora_header(path)
            if not base_arch and inspected.get("base_arch"):
                base_arch = str(inspected["base_arch"])
            if not trigger_word and inspected.get("trigger_word"):
                trigger_word = str(inspected["trigger_word"])
            is_full = bool(inspected.get("is_full_model"))
            loras.append({
                "filename": path.name,
                "stem": path.stem,
                "size_bytes": path.stat().st_size,
                "trigger_word": trigger_word,
                "base_arch": base_arch,
                "is_full_model": is_full,
                "compatible_with_active": (not is_full) and is_lora_compatible_with_family(base_arch, active_family),
                "trained_by": meta.get("trained_by", ""),
                "created_at": meta.get("created_at", int(path.stat().st_mtime)),
            })

    return {
        "models": models,
        "aux_files": aux_files,
        "loras": loras,
        "image_models_dir": str(IMAGE_MODELS_DIR),
        "image_aux_dir": str(IMAGE_AUX_DIR),
        "loras_dir": str(LORAS_DIR),
    }


def move_image_to_lora(filename: str) -> Dict[str, Any]:
    """Move a misplaced LoRA file from server/models/image/ into server/models/loras/."""
    name = filename.strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError("invalid filename")
    src = IMAGE_MODELS_DIR / name
    if not src.is_file():
        raise FileNotFoundError(name)
    LORAS_DIR.mkdir(parents=True, exist_ok=True)
    dst = LORAS_DIR / name
    shutil.move(str(src), str(dst))
    old_meta = get_meta(f"image/{name}")
    inspected = inspect_lora_header(dst)
    merged_meta = {
        **old_meta,
        "weight_role": "lora",
        **({"base_arch": inspected["base_arch"]} if not old_meta.get("base_arch") and inspected.get("base_arch") else {}),
        **({"trigger_word": inspected["trigger_word"]} if not old_meta.get("trigger_word") and inspected.get("trigger_word") else {}),
    }
    if old_meta:
        drop_meta(f"image/{name}")
    set_meta(f"loras/{name}", merged_meta)
    return {"ok": True, "filename": name, "destination": str(dst)}


def move_lora_to_image(filename: str) -> Dict[str, Any]:
    """Move a misplaced full base model from server/models/loras/ into server/models/image/."""
    name = filename.strip()
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError("invalid filename")
    src = LORAS_DIR / name
    if not src.is_file():
        raise FileNotFoundError(name)
    IMAGE_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    dst = IMAGE_MODELS_DIR / name
    shutil.move(str(src), str(dst))
    old_meta = get_meta(f"loras/{name}")
    hdr = inspect_safetensors_header(dst) if dst.suffix.lower() == ".safetensors" else {"weight_role": "diffusion_model", "arch_hint": ""}
    fam = infer_image_family(name, {**old_meta, **({"family": hdr["arch_hint"]} if hdr.get("arch_hint") else {})})
    merged_meta = {
        k: v for k, v in old_meta.items() if k not in ("weight_role", "base_arch")
    }
    merged_meta["weight_role"] = hdr.get("weight_role") if hdr.get("weight_role") in ("checkpoint", "diffusion_model") else "checkpoint"
    merged_meta["family"] = fam["family"]
    if old_meta:
        drop_meta(f"loras/{name}")
    set_meta(f"image/{name}", merged_meta)
    return {"ok": True, "filename": name, "destination": str(dst)}
