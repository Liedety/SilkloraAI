"""AI Model-Finder Assistant for SilkloraAI Local Hub.

Helps the user find the exact right Text, Vision, or Image model for their PC hardware
and creative needs using either:
- Cloud API (OpenRouter / OpenAI / Gemini / DeepSeek / Groq / Custom OpenAI-compatible)
- Currently loaded Local LLM inside the Hub

Every suggested repository is verified live against Hugging Face (`store.search` and
`store.inspect_repo`) with exact hardware fit calculation before being returned.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import requests

from . import archs, hardware, planner, settings as settings_mod, store
from .coordinator import coordinator
from .engine import engine
from .log import logger

PROVIDER_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "openai": "https://api.openai.com/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}

PROVIDER_DEFAULT_MODELS = {
    "openrouter": "openai/gpt-4o-mini",
    "openai": "gpt-4o-mini",
    "deepseek": "deepseek-chat",
    "groq": "llama-3.3-70b-versatile",
    "gemini": "gemini-2.5-flash",
}

IMAGE_INTENT_TOKENS = (
    "image", "scene", "picture", "photo", "art", "anime", "realistic", "illustration",
    "flux", "qwen-image", "sdxl", "illustrious", "pony", "animagine", "chroma", "kroma",
    "furry", "anthro", "fantasy", "cyberpunk", "lora", "portrait", "character", "draw", "render",
    "сцен", "картин", "фото", "изображ", "рису", "арт", "портрет", "персонаж", "аниме", "лора",
    "фурри", "антро", "фэнтези", "стил",
)
VISION_INTENT_TOKENS = ("vision", "vlm", "mmproj", "see image", "describe photo", "вижен", "зрен", "распозна")


def public_config() -> Dict[str, Any]:
    cfg = settings_mod.get_all()
    raw_key = str(cfg.get("assistant_api_key") or "")
    masked = ""
    if raw_key:
        masked = f"{raw_key[:4]}...{raw_key[-4:]}" if len(raw_key) > 10 else "***"
    return {
        "mode": str(cfg.get("assistant_mode") or "local"),
        "provider": str(cfg.get("assistant_provider") or "openrouter"),
        "api_url": str(cfg.get("assistant_base_url") or ""),
        "api_model": str(cfg.get("assistant_model") or ""),
        "has_api_key": bool(raw_key),
        "api_key_preview": masked,
    }


def save_config(patch: Dict[str, Any]) -> Dict[str, Any]:
    allowed: Dict[str, Any] = {}
    if "mode" in patch and patch["mode"] in ("api", "local"):
        allowed["assistant_mode"] = patch["mode"]
    if "provider" in patch:
        allowed["assistant_provider"] = str(patch["provider"]).strip().lower()
    if "api_url" in patch:
        allowed["assistant_base_url"] = str(patch["api_url"]).strip()
    if "api_model" in patch:
        allowed["assistant_model"] = str(patch["api_model"]).strip()
    if "api_key" in patch:
        key_val = str(patch["api_key"]).strip()
        # Preserve stored secret if caller submitted masked preview unchanged
        if key_val and "..." not in key_val and key_val != "***":
            allowed["assistant_api_key"] = key_val
        elif key_val == "":
            allowed["assistant_api_key"] = ""
    settings_mod.update(allowed)
    return public_config()


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    raw = (text or "").strip()
    raw = re.sub(r"<thought>[\s\S]*?</thought>", "", raw, flags=re.IGNORECASE).strip()
    m = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _call_chat_ai(messages: List[Dict[str, str]], max_tokens: int = 700, mode_override: str = "", lang: str = "ru") -> str:
    cfg = settings_mod.get_all()
    mode = (mode_override or str(cfg.get("assistant_mode") or "local")).lower()

    if mode == "local":
        if engine.llama is None:
            res = coordinator.ensure_llm_for_chat(is_background=False)
            if res != "ok":
                raise RuntimeError("No local LLM is loaded. Load a chat model in Models first or switch AI Finder to API mode.")
        out = engine.llama.create_chat_completion(
            messages=messages,
            temperature=0.25,
            max_tokens=max_tokens,
            stream=False,
        )
        raw = str((out.get("choices") or [{}])[0].get("message", {}).get("content") or "")
        return re.sub(r"<thought>[\s\S]*?</thought>", "", raw, flags=re.IGNORECASE).strip()

    # API mode
    provider = str(cfg.get("assistant_provider") or "openrouter").lower()
    api_key = str(cfg.get("assistant_api_key") or "").strip()
    base_url = str(cfg.get("assistant_base_url") or PROVIDER_URLS.get(provider, "")).strip().rstrip("/")
    model = str(cfg.get("assistant_model") or PROVIDER_DEFAULT_MODELS.get(provider, "gpt-4o-mini")).strip()

    if not base_url:
        raise RuntimeError(
            "Укажите Base URL облачного API или переключите режим на «Локальная ИИ»."
            if lang == "ru"
            else "API Base URL is required for API mode, or switch AI Finder to Local AI."
        )
    if not api_key and "127.0.0.1" not in base_url and "localhost" not in base_url:
        raise RuntimeError(
            "Введите API-ключ и нажмите «Сохранить ключ API», либо переключите тумблер сверху на «Локальная ИИ»."
            if lang == "ru"
            else "API Key is required for API mode. Save your API key above or switch AI Finder to Local AI."
        )

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "openrouter":
        headers["HTTP-Referer"] = "https://github.com/Silklora/silklora-ai"
        headers["X-Title"] = "SilkloraAI Local Hub"

    endpoint = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
    res = requests.post(
        endpoint,
        headers=headers,
        json={"model": model, "messages": messages, "temperature": 0.25, "max_tokens": max_tokens},
        timeout=45,
    )
    if not res.ok:
        raise RuntimeError(f"Assistant API error {res.status_code}: {res.text[:240]}")
    data = res.json()
    raw = str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    return re.sub(r"<thought>[\s\S]*?</thought>", "", raw, flags=re.IGNORECASE).strip()


def _fallback_search_plan(query: str, kind_hint: str) -> Dict[str, Any]:
    low = query.lower()
    if kind_hint in ("chat", "vision", "image"):
        kind = kind_hint
    elif any(tok in low for tok in IMAGE_INTENT_TOKENS):
        kind = "image"
    elif any(tok in low for tok in VISION_INTENT_TOKENS):
        kind = "vision"
    else:
        kind = "chat"

    words = [w for w in re.findall(r"[a-zA-Z0-9._-]+", query) if len(w) >= 3]
    terms: List[str] = []
    if words:
        terms.append(" ".join(words[:3]))
    if kind == "image":
        if any(t in low for t in ("furry", "anthro", "chroma", "kroma", "pony", "фурри", "антро", "необыч")):
            terms += ["Chroma-GGUF", "illustrious gguf", "animagine-xl-3.1"]
        elif any(t in low for t in ("похож", "ref", "consist", "kontext", "edit", "сцен", "scene", "character", "персонаж")):
            terms += ["FLUX.1-Kontext-dev-GGUF", "Qwen-Image-Edit-2509-GGUF"]
        elif any(t in low for t in ("fast", "quick", "быстр", "слаб", "low", "8gb", "turbo")):
            terms += ["Z-Image-Turbo-GGUF", "dreamshaper-xl-v2-turbo", "sdxl-turbo"]
        elif any(t in low for t in ("anime", "аниме", "2d", "арт", "illustrious")):
            terms += ["animagine-xl-3.1", "illustrious gguf", "dreamshaper-xl-v2-turbo"]
        elif any(t in low for t in ("real", "photo", "реал", "фото")):
            terms += ["Juggernaut-XL-v9", "Z-Image-Turbo-GGUF"]
        else:
            terms += ["FLUX.1-Kontext-dev-GGUF", "Chroma-GGUF", "dreamshaper-xl-v2-turbo"]
    elif kind == "vision":
        terms += ["Qwen2.5-VL-7B-Instruct-GGUF", "qwen vl gguf"]
    else:
        terms += ["roleplay gguf", "mistral nemo gguf", "qwen instruct gguf"]
    return {"kind": kind, "search_terms": list(dict.fromkeys(terms))[:4], "needs_refs": any(t in low for t in ("ref", "consist", "kontext", "edit", "персонаж", "похож"))}


def recommend(query: str, hw: Optional[Dict[str, Any]] = None, kind_hint: str = "auto", mode_override: str = "", lang: str = "ru") -> Dict[str, Any]:
    clean_q = (query or "").strip()
    if not clean_q:
        raise RuntimeError("Enter a description of what model you want to find.")

    machine_hw = hw or hardware.analyze_hardware(fresh_gpu=False)
    profile = hardware.build_profile(machine_hw)
    gpu = machine_hw.get("gpu") or {}
    vram_gb = round((gpu.get("vram_total") or 0) / hardware.GIB, 1)
    ram_gb = round((machine_hw.get("ram_total") or 0) / hardware.GIB, 1)

    hw_summary = (
        f"CPU: {machine_hw.get('cpu', {}).get('cores', 0)} cores, "
        f"RAM: {ram_gb} GB (budget {profile['ram_budget_gb']} GB), "
        f"GPU: {gpu.get('name', 'None')} ({gpu.get('kind', 'none')}, VRAM {vram_gb} GB, budget {profile['gpu_budget_gb']} GB), "
        f"Tier: {profile['tier']}"
    )

    plan_prompt = (
        "You are a Hugging Face model search planner for SilkloraAI Local Hub.\n"
        f"User hardware: {hw_summary}\n"
        f"Requested category hint: {kind_hint}\n"
        "Convert the user's request into Hugging Face Hub search terms.\n"
        "Output ONLY compact JSON with NO markdown or commentary:\n"
        '{"kind": "image"|"chat"|"vision", "search_terms": ["2-4 English keywords"], "needs_refs": true|false}'
    )

    search_plan = None
    ai_planner_used = False
    ai_note = ""
    try:
        raw_plan = _call_chat_ai(
            [{"role": "system", "content": plan_prompt}, {"role": "user", "content": clean_q}],
            max_tokens=220,
            mode_override=mode_override,
            lang=lang,
        )
        parsed = _extract_json(raw_plan)
        if parsed and isinstance(parsed.get("search_terms"), list) and parsed["search_terms"]:
            search_plan = parsed
            ai_planner_used = True
        else:
            # Extract any repo ids / keywords even if conversational LLM answered with prose
            repo_mentions = re.findall(r"([a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+)", raw_plan or "")
            if repo_mentions:
                fallback = _fallback_search_plan(clean_q, kind_hint)
                fallback["search_terms"] = list(dict.fromkeys(repo_mentions + fallback["search_terms"]))[:4]
                search_plan = fallback
                ai_planner_used = True
    except Exception as exc:
        msg = str(exc)
        if any(tok in msg for tok in ("API Key", "API Base URL", "API-ключ", "Base URL облачного")):
            raise RuntimeError(msg)
        ai_note = msg

    fallback_plan = _fallback_search_plan(clean_q, kind_hint)
    if not search_plan:
        search_plan = fallback_plan

    kind = str(search_plan.get("kind") or fallback_plan["kind"] or "image")
    if kind not in ("chat", "vision", "image"):
        kind = "image"
    terms = [str(t).strip() for t in (search_plan.get("search_terms") or []) if str(t).strip()]
    for fb_t in fallback_plan["search_terms"]:
        if fb_t not in terms:
            terms.append(fb_t)
    terms = terms[:4]

    found_map: Dict[str, Dict[str, Any]] = {}
    if kind == "image":
        for cur_repo in store.curated_image_repos():
            found_map[cur_repo["repo_id"]] = dict(cur_repo)

    for term in terms:
        try:
            hits = store.search(term, kind, archs.supports_architecture)
        except store.StoreError as exc:
            logger.warning(f"Assistant HF search '{term}' error: {exc}")
            continue
        for item in hits[:8]:
            rid = item.get("repo_id")
            if rid and rid not in found_map:
                found_map[rid] = item

    curated_ids = {c["repo_id"] for c in store.curated_image_repos()} if kind == "image" else set()
    need_refs_pref = bool(search_plan.get("needs_refs") or fallback_plan.get("needs_refs"))
    q_low = clean_q.lower()

    def repo_sort_key(x: Dict[str, Any]):
        rid = str(x.get("repo_id") or "")
        low = rid.lower()
        name_hit = any(tok in low for tok in re.findall(r"[a-z0-9]{4,}", " ".join(terms).lower()))
        is_curated = rid in curated_ids
        is_ref_repo = "kontext" in low or "edit" in low
        want_anime = any(t in q_low for t in ("anime", "аниме", "2d", "illustrious", "pony", "furry", "фурри", "антро"))
        is_anime = any(t in low for t in ("animagine", "illustrious", "pony", "chroma"))
        return (
            0 if (want_anime and is_anime) else (0 if (need_refs_pref and is_ref_repo) else 1),
            0 if name_hit else 1,
            0 if is_curated else 1,
            -int(x.get("downloads", 0)),
        )

    top_repos = sorted(found_map.values(), key=repo_sort_key)[:10]

    def check_one(cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        try:
            detail = store.inspect_repo(cand["repo_id"], machine_hw, archs.supports_architecture, kind=kind)
        except store.StoreError:
            return None
        files = detail.get("files") or []
        is_img = kind == "image"
        main = store.pick_file(files, machine_hw, "fast", is_image=is_img) or store.pick_file(files, machine_hw, "stretch", is_image=is_img)
        if not main:
            return None
        if is_img and main["size_bytes"] < 300 * 1024 * 1024:
            return None
        if not is_img and detail.get("arch_supported") is False:
            return None
        fit = planner.classify_image_fit(main["size_bytes"], machine_hw) if is_img else planner.classify_fit(main["size_bytes"], machine_hw)
        if fit == "too_big":
            return None
        companions = []
        family = detail.get("family", "")
        needs_comp = bool(detail.get("needs_companions"))
        if is_img:
            comp_key = store.companion_key_for_model(family, main["filename"], needs_comp, size_bytes=int(main.get("size_bytes") or 0))
            needs_comp = bool(comp_key)
            picked_comp = store.ensure_image_companions(files, comp_key, machine_hw, cand["repo_id"]) if comp_key else []
            for c in picked_comp:
                companions.append({
                    "filename": c["filename"],
                    "repo_id": c.get("repo_id") or cand["repo_id"],
                    "local_name": c.get("local_name") or store.local_name(cand["repo_id"], c["filename"]),
                    "size_bytes": c["size_bytes"],
                    "role": c.get("role") or c.get("aux_role") or "image_aux",
                    **({"url": c["url"]} if c.get("url") else {}),
                })
            if needs_comp and not companions:
                return None
        projector = store.pick_projector(files) if kind == "vision" else None
        return {
            "repo_id": cand["repo_id"],
            "name": detail.get("name") or cand["repo_id"].split("/")[-1],
            "kind": kind,
            "pipeline": detail.get("pipeline") or cand.get("pipeline") or "",
            "downloads": detail.get("downloads", 0),
            "likes": detail.get("likes", 0),
            "family": family,
            "supports_refs": bool(detail.get("supports_refs")),
            "needs_companions": needs_comp,
            "arch_supported": detail.get("arch_supported"),
            "fit": fit,
            "file": {
                "filename": main["filename"],
                "local_name": store.local_name(cand["repo_id"], main["filename"]),
                "size_bytes": main["size_bytes"],
                "quant": main.get("quant", ""),
                "role": "image" if kind == "image" else "model",
            },
            "projector": {
                "filename": projector["filename"],
                "local_name": store.local_name(cand["repo_id"], projector["filename"]),
                "size_bytes": projector["size_bytes"],
                "role": "projector",
            } if projector else None,
            "companions": companions,
            "total_bytes": main["size_bytes"] + sum(c["size_bytes"] for c in companions) + (projector["size_bytes"] if projector else 0),
        }

    with ThreadPoolExecutor(max_workers=6) as pool:
        verified = [r for r in pool.map(check_one, top_repos) if r]

    fit_rank = {"gpu_full": 0, "gpu_stream": 1, "cpu_ok": 1, "gpu_partial": 2, "too_big": 3}
    verified.sort(
        key=lambda r: (
            0 if (need_refs_pref and r.get("supports_refs")) else 1,
            fit_rank.get(r["fit"], 4),
            0 if r["repo_id"] in curated_ids else 1,
            -r.get("downloads", 0),
        )
    )
    verified = verified[:5]

    if not verified:
        msg_ru = "На Hugging Face не найдено готовых к запуску весов под ваше железо. Попробуйте запрос проще (например: сцены с персонажами, аниме SDXL или лёгкий ролевой чат)."
        msg_en = "No runnable Hugging Face weights matched your hardware and query. Try simpler keywords (e.g. character scenes, anime sdxl, or lightweight roleplay chat)."
        return {
            "query": clean_q,
            "kind": kind,
            "search_terms": terms,
            "hardware": hw_summary,
            "ai_planner_used": ai_planner_used,
            "answer": msg_ru if lang == "ru" else msg_en,
            "candidates": [],
        }

    digest_lines = []
    for idx, c in enumerate(verified, 1):
        size_gb = round(c.get("total_bytes", c["file"]["size_bytes"]) / hardware.GIB, 2)
        digest_lines.append(
            f"{idx}. {c['repo_id']} | total={size_gb} GB | fit={c['fit']} | family={c.get('family') or '-'} | multi_ref={c.get('supports_refs')}"
        )

    lang_instr = (
        "Answer in Russian in 2-4 concise sentences. Plain text only, zero emojis, NO numbered markdown list of models and NO URLs (interactive Download buttons for each model are shown right below your reply)."
        if lang == "ru"
        else "Answer in English in 2-4 concise sentences. Plain text only, zero emojis, NO numbered markdown list of models and NO URLs (interactive Download buttons for each model are shown right below your reply)."
    )
    synth_prompt = (
        f"You are the SilkloraAI Local Hub advisor. {lang_instr}\n"
        f"User hardware: {hw_summary}\n"
        "Explain briefly why the top matched card below fits the user's request and VRAM/RAM budget."
    )
    user_msg = f"User request: {clean_q}\nTop verified matches:\n" + "\n".join(digest_lines)

    try:
        answer = _call_chat_ai(
            [{"role": "system", "content": synth_prompt}, {"role": "user", "content": user_msg}],
            max_tokens=320,
            mode_override=mode_override,
            lang=lang,
        )
    except Exception:
        answer = (
            f"Подобрали {len(verified)} проверенных вариантов под ваше железо ({vram_gb} ГБ VRAM / {ram_gb} ГБ RAM). Нажмите «Скачать» на нужной карточке ниже."
            if lang == "ru"
            else f"Matched {len(verified)} verified runnable packages for your hardware ({vram_gb} GB VRAM / {ram_gb} GB RAM). Click Download on any card below."
        )
    if ai_note and not answer:
        answer = ai_note

    return {
        "query": clean_q,
        "kind": kind,
        "search_terms": terms,
        "hardware": hw_summary,
        "ai_planner_used": ai_planner_used,
        "answer": answer,
        "candidates": verified,
    }
