"""Server-side context guard.

The client already keeps its prompt inside a token budget. This module is the safety net that
guarantees a request always fits the loaded context window, without losing the beginning of the
story: dropped turns are condensed into a short digest instead of being discarded.
"""

from typing import Any, Callable, Dict, List, Tuple

PER_MESSAGE_OVERHEAD = 10
IMAGE_TOKENS = 1024
SAFETY_MARGIN = 96
MIN_REPLY_RESERVE = 256
DIGEST_LINE_CHARS = 140
DIGEST_HEADER = "[Earlier conversation, condensed automatically]"

TokenCounter = Callable[[str], int]


def estimate_tokens(text: str) -> int:
    """Conservative token estimate used when no tokenizer is available."""
    if not text:
        return 0
    cyrillic = sum(1 for ch in text if "\u0400" <= ch <= "\u04ff")
    other = len(text) - cyrillic
    return int(cyrillic / 2.1 + other / 3.4) + 1


def _text_of(content: Any) -> Tuple[str, int]:
    """Return (text, image_count) for string or multimodal content."""
    if isinstance(content, str):
        return content, 0
    if isinstance(content, list):
        texts, images = [], 0
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                texts.append(str(part.get("text", "")))
            elif part.get("type") == "image_url":
                images += 1
        return "\n".join(texts), images
    return "", 0


def message_tokens(message: Dict[str, Any], count: TokenCounter) -> int:
    text, images = _text_of(message.get("content", ""))
    return count(text) + images * IMAGE_TOKENS + PER_MESSAGE_OVERHEAD


def reply_reserve(n_ctx: int, max_tokens: int) -> int:
    return max(MIN_REPLY_RESERVE, min(max_tokens, n_ctx // 3))


def _set_text(message: Dict[str, Any], text: str) -> Dict[str, Any]:
    copy = dict(message)
    content = message.get("content")
    if isinstance(content, list):
        parts = [dict(p) if isinstance(p, dict) else p for p in content]
        for part in parts:
            if isinstance(part, dict) and part.get("type") == "text":
                part["text"] = text
                break
        copy["content"] = parts
    else:
        copy["content"] = text
    return copy


def _shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 3].rstrip() + "..."


def _truncate_middle(text: str, max_tokens: int, count: TokenCounter) -> str:
    """Trim an oversized system prompt while keeping its opening rules and closing instructions."""
    total = max(1, count(text))
    if total <= max_tokens:
        return text
    keep_chars = max(200, int(len(text) * max_tokens / total * 0.95))
    head = int(keep_chars * 0.65)
    tail = keep_chars - head
    return text[:head].rstrip() + "\n[...]\n" + text[-tail:].lstrip()


def fit_messages(
    messages: List[Dict[str, Any]],
    n_ctx: int,
    max_tokens: int,
    count: TokenCounter,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Return messages that fit n_ctx together with a reply of at most max_tokens, plus a report."""
    reserve = reply_reserve(n_ctx, max_tokens)
    budget = max(256, n_ctx - reserve - SAFETY_MARGIN)

    msgs = [dict(m) for m in messages]
    sizes = [message_tokens(m, count) for m in msgs]
    total = sum(sizes)
    report = {
        "n_ctx": n_ctx,
        "reply_reserve": reserve,
        "prompt_tokens": total,
        "dropped": 0,
        "digest_tokens": 0,
        "system_trimmed": False,
    }
    if total <= budget:
        return msgs, report

    system_idx = [i for i, m in enumerate(msgs) if m.get("role") == "system"]
    system_tokens = sum(sizes[i] for i in system_idx)
    system_limit = int(budget * 0.6)
    if system_tokens > system_limit and system_idx:
        first = system_idx[0]
        text, _ = _text_of(msgs[first].get("content", ""))
        allowed = max(128, system_limit - sum(sizes[i] for i in system_idx[1:]) - PER_MESSAGE_OVERHEAD)
        msgs[first] = _set_text(msgs[first], _truncate_middle(text, allowed, count))
        sizes[first] = message_tokens(msgs[first], count)
        report["system_trimmed"] = True
        system_tokens = sum(sizes[i] for i in system_idx)

    dialogue = [i for i in range(len(msgs)) if i not in system_idx]
    digest_budget = min(700, int(budget * 0.12))
    dialogue_budget = budget - system_tokens - digest_budget

    kept: List[int] = []
    used = 0
    for i in reversed(dialogue):
        if kept and used + sizes[i] > dialogue_budget:
            break
        kept.append(i)
        used += sizes[i]
    kept.reverse()

    # The history must start with a user turn for most chat templates.
    while len(kept) > 1 and msgs[kept[0]].get("role") == "assistant":
        kept.pop(0)

    dropped = [i for i in dialogue if i not in kept]
    digest_lines: List[str] = []
    digest_tokens = 0
    for i in reversed(dropped):
        text, _ = _text_of(msgs[i].get("content", ""))
        text = _shorten(text, DIGEST_LINE_CHARS)
        if not text:
            continue
        label = "Player" if msgs[i].get("role") == "user" else "Character"
        line = f"- {label}: {text}"
        line_tokens = count(line) + 2
        if digest_tokens + line_tokens > digest_budget:
            break
        digest_lines.append(line)
        digest_tokens += line_tokens
    digest_lines.reverse()

    result: List[Dict[str, Any]] = []
    digest_text = (DIGEST_HEADER + "\n" + "\n".join(digest_lines)) if digest_lines else ""
    digest_attached = False
    for i, m in enumerate(msgs):
        if i in system_idx:
            if digest_text and not digest_attached:
                text, _ = _text_of(m.get("content", ""))
                result.append(_set_text(m, text.rstrip() + "\n\n" + digest_text))
                digest_attached = True
            else:
                result.append(m)
        elif i in kept:
            result.append(m)
    if digest_text and not digest_attached:
        result.insert(0, {"role": "system", "content": digest_text})

    report["dropped"] = len(dropped)
    report["digest_tokens"] = digest_tokens
    report["prompt_tokens"] = sum(message_tokens(m, count) for m in result)
    return result, report
