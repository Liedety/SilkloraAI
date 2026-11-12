"""Automatic load planning: context length, GPU layers and KV cache type from real model metadata."""

from typing import Any, Dict, Optional

from .hardware import GIB, memory_budgets

CTX_STEPS = [2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536]
MIN_COMFORT_CTX = 8192
KV_BYTES = {"f16": 2.0, "q8_0": 34.0 / 32.0}
GGML_TYPE_Q8_0 = 8
GGML_TYPE_F16 = 1


def kv_bytes_per_token(info: Dict[str, Any], kv_type: str) -> float:
    n_layer = info.get("n_layer") or 0
    n_head_kv = info.get("n_head_kv") or 0
    key_len = info.get("key_len") or 0
    val_len = info.get("val_len") or 0
    if not (n_layer and n_head_kv and key_len and val_len):
        # Unknown layout: a typical GQA transformer needs about 3e-5 bytes of f16 cache per weight byte per token.
        return info.get("size_bytes", 0) * 3.0e-5 * KV_BYTES[kv_type] / KV_BYTES["f16"]
    return n_layer * n_head_kv * (key_len + val_len) * KV_BYTES[kv_type]


def _compute_buffer(ctx: int) -> float:
    return 0.35 * GIB + ctx * 10 * 1024


def _memory_use(info, mmproj_bytes, kv_tok, ctx, layers_gpu):
    n_layer = max(1, info["n_layer"])
    layer_w = info["size_bytes"] / (n_layer + 1)
    out_w = layer_w
    per_layer = layer_w + kv_tok * ctx / n_layer
    on_gpu_full = layers_gpu >= n_layer
    gpu = 0.0
    if layers_gpu > 0:
        gpu = layers_gpu * per_layer + (out_w if on_gpu_full else 0) + mmproj_bytes * 1.15 + _compute_buffer(ctx)
    ram = (n_layer - min(layers_gpu, n_layer)) * per_layer + (0 if on_gpu_full else out_w)
    if layers_gpu == 0:
        ram += mmproj_bytes * 1.15 + _compute_buffer(ctx)
    return gpu, ram


def _max_gpu_layers(info, mmproj_bytes, kv_tok, ctx, gpu_budget, ram_budget) -> Optional[int]:
    n_layer = max(1, info["n_layer"])
    for layers in range(n_layer, -1, -1):
        gpu, ram = _memory_use(info, mmproj_bytes, kv_tok, ctx, layers)
        if gpu <= gpu_budget and ram <= ram_budget:
            return layers
    return None


def plan_load(
    info: Dict[str, Any],
    hw: Dict[str, Any],
    mmproj_bytes: int = 0,
    ctx_request: Optional[int] = None,
    layers_request: Optional[int] = None,
    kv_quant: bool = True,
    ctx_cap: int = 32768,
    vision: bool = False,
) -> Dict[str, Any]:
    """Choose context length, GPU offload and KV cache type for the given model and machine."""
    budgets = memory_budgets(hw)
    gpu_budget = float(budgets["gpu"])
    ram_budget = float(budgets["ram"])

    n_layer = info.get("n_layer") or 0
    ctx_train = info.get("n_ctx_train") or 0
    warnings = []

    use_flash = bool(hw["gpu"]["has_gpu"] and gpu_budget > 0)
    kv_type = "q8_0" if (kv_quant and use_flash) else "f16"
    kv_tok = kv_bytes_per_token(info, kv_type)

    hard_cap = min(ctx_cap, ctx_train) if ctx_train else ctx_cap
    steps = [c for c in CTX_STEPS if c <= max(hard_cap, CTX_STEPS[0])]
    if ctx_train and ctx_train < CTX_STEPS[0]:
        steps = [ctx_train]
    comfort_floor = min(MIN_COMFORT_CTX, steps[-1])
    lowest = 4096 if vision else 2048

    if not n_layer:
        warnings.append("layout_unknown")
        n_layer = 32
        info = dict(info, n_layer=n_layer)

    # Explicit user choices take priority over automatic planning.
    if ctx_request:
        ctx = int(ctx_request)
        if ctx_train and ctx > ctx_train:
            warnings.append("ctx_above_training")
        layers = layers_request if layers_request is not None else None
        if layers is None:
            layers = _max_gpu_layers(info, mmproj_bytes, kv_tok, ctx, gpu_budget, ram_budget)
            if layers is None:
                layers = 0
                warnings.append("memory_tight")
        return _finish(info, ctx, layers, kv_type, use_flash, hw, mmproj_bytes, kv_tok, warnings, ctx_train)

    if layers_request is not None:
        layers = int(layers_request) if layers_request >= 0 else n_layer
        chosen = None
        for ctx in reversed(steps):
            gpu, ram = _memory_use(info, mmproj_bytes, kv_tok, ctx, min(layers, n_layer))
            if (gpu <= gpu_budget or layers == 0) and ram <= ram_budget:
                chosen = ctx
                break
        if chosen is None:
            chosen = steps[0]
            warnings.append("memory_tight")
        return _finish(info, chosen, layers, kv_type, use_flash, hw, mmproj_bytes, kv_tok, warnings, ctx_train)

    # Pass 1: everything on the GPU, largest context that still fits.
    if gpu_budget > 0:
        for ctx in reversed(steps):
            if ctx < comfort_floor:
                break
            gpu, ram = _memory_use(info, mmproj_bytes, kv_tok, ctx, n_layer)
            if gpu <= gpu_budget and ram <= ram_budget + 1:
                return _finish(info, ctx, n_layer, kv_type, use_flash, hw, mmproj_bytes, kv_tok, warnings, ctx_train)

        # Pass 2: partial offload, keep a comfortable context and push as many layers as fit.
        for ctx in (16384, 12288, 8192, 6144, 4096, 3072, 2048):
            if ctx > steps[-1] or ctx < lowest:
                continue
            layers = _max_gpu_layers(info, mmproj_bytes, kv_tok, ctx, gpu_budget, ram_budget)
            if layers is not None and layers > 0:
                if ctx > 8192 and layers < n_layer * 0.6:
                    continue
                return _finish(info, ctx, layers, kv_type, use_flash, hw, mmproj_bytes, kv_tok, warnings, ctx_train)

    # Pass 3: CPU only.
    cpu_kv = kv_bytes_per_token(info, "f16")
    for ctx in (8192, 6144, 4096, 3072, 2048):
        if (ctx > steps[-1] and ctx != 2048) or ctx < lowest:
            continue
        gpu, ram = _memory_use(info, mmproj_bytes, cpu_kv, ctx, 0)
        if ram <= ram_budget:
            return _finish(info, ctx, 0, "f16", False, hw, mmproj_bytes, cpu_kv, warnings, ctx_train)

    warnings.append("memory_tight")
    return _finish(info, 2048, 0, "f16", False, hw, mmproj_bytes, cpu_kv, warnings, ctx_train)


def _finish(info, ctx, layers, kv_type, flash, hw, mmproj_bytes, kv_tok, warnings, ctx_train):
    n_layer = max(1, info["n_layer"])
    layers = n_layer if layers < 0 else min(layers, n_layer)
    if layers == 0:
        flash = False
        kv_type = "f16"
        kv_tok = kv_bytes_per_token(info, "f16")
    gpu, ram = _memory_use(info, mmproj_bytes, kv_tok, ctx, layers)
    if layers >= n_layer:
        offload = "full"
    elif layers > 0:
        offload = "partial"
    else:
        offload = "none"
    if offload == "none" and hw["gpu"]["has_gpu"]:
        warnings.append("cpu_only_with_gpu")
    if offload == "partial":
        warnings.append("partial_offload")
    return {
        "n_ctx": int(ctx),
        "n_gpu_layers": -1 if offload == "full" else int(layers),
        "layers_gpu": int(layers),
        "n_layer": int(n_layer),
        "offload": offload,
        "flash_attn": bool(flash),
        "kv_type": kv_type,
        "type_k": GGML_TYPE_Q8_0 if kv_type == "q8_0" else GGML_TYPE_F16,
        "type_v": GGML_TYPE_Q8_0 if kv_type == "q8_0" else GGML_TYPE_F16,
        "n_threads": max(1, hw["cpu"]["cores"]),
        "est_gpu_gb": round(gpu / GIB, 2),
        "est_ram_gb": round(ram / GIB, 2),
        "ctx_train": int(ctx_train or 0),
        "warnings": warnings,
    }


def classify_fit(size_bytes: int, hw: Dict[str, Any]) -> str:
    """Rate a model file against the machine without reading its header.

    Returns one of: gpu_full, gpu_partial, cpu_ok, too_big.
    """
    budgets = memory_budgets(hw)
    need = size_bytes * 1.18 + 0.5 * GIB
    if budgets["gpu"] and need <= budgets["gpu"]:
        return "gpu_full"
    if budgets["gpu"] and need <= budgets["gpu"] + budgets["ram"]:
        return "gpu_partial"
    if need <= budgets["ram"]:
        return "cpu_ok"
    return "too_big"
