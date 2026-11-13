"""Utilities for stripping leaked model control tokens and routing reasoning blocks."""

import re
from typing import Tuple

# Ambiguous trailing/leading model control & chat-template markers that small models emit.
_CONTROL_TOKEN_RE = re.compile(
    r"(?:"
    r"<\s*\|\s*(?:turn|im_start|im_end|eot_id|endoftext|begin_of_sentence|end_of_sentence|start_header_id|end_header_id|pad|bos|eos)\s*\|?\s*>(?:system|user|assistant|model|thought)?[ \t]*\n?"
    r"|<\s*(?:turn|im_end|eot_id|endoftext)\s*\|>"
    r"|<\s*\|\s*channel\s*>"
    r"|<\s*channel\s*\|>"
    r"|<\s*\|\s*thought\s*>"
    r"|<\s*thought\s*\|>"
    r"|<\s*(?:start_of_turn|end_of_turn)\s*>(?:user|model|system)?[ \t]*\n?"
    r"|<\|\s*start_header_id\s*\|>[^<\n]{0,40}<\s*\|\s*end_header_id\s*\|>[ \t]*\n?"
    r"|</?s>"
    r"|\uFFFD"
    r"|[\u200B-\u200D\uFEFF]"
    r")",
    re.IGNORECASE,
)

# Reasoning envelopes used by Gemma 4, Qwen 3, DeepSeek-R1, and similar local models.
_REASONING_BLOCK_RES = (
    re.compile(r"<\|\s*channel\s*>\s*thought\b\s*([\s\S]*?)<\s*channel\s*\|>", re.IGNORECASE),
    re.compile(r"<\|\s*thought\s*>\s*([\s\S]*?)<\s*thought\s*\|>", re.IGNORECASE),
    re.compile(r"\[\|\s*thought\s*\|\]\s*([\s\S]*?)\[/\|\s*thought\s*\|\]", re.IGNORECASE),
    re.compile(r"<think>\s*([\s\S]*?)</think>", re.IGNORECASE),
)

# Open-ended reasoning tags when generation stops (e.g. max_tokens) before closing tag arrives.
_UNCLOSED_REASONING_RES = (
    re.compile(r"<\|\s*channel\s*>\s*thought\b\s*([\s\S]*)$", re.IGNORECASE),
    re.compile(r"<\|\s*thought\s*>\s*([\s\S]*)$", re.IGNORECASE),
    re.compile(r"<think>\s*([\s\S]*)$", re.IGNORECASE),
)

# Echoed Silklora prompt-wrapper blocks that should never leak to clients.
_LEAKED_NOTE_RE = re.compile(
    r"\n*\[\s*(?:Заметка сцены|Scene note|Контекст хода|Указание к ответу|УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ|USER TURN DIRECTIVE)[\s\S]*$",
    re.IGNORECASE,
)

_OPEN_TOKENS = (
    "<|channel>thought",
    "<|thought>",
    "[|thought|]",
    "<think>",
)

_CLOSE_TOKENS = (
    "<channel|>",
    "<thought|>",
    "[/|thought|]",
    "</think>",
)

_STRIP_TOKENS = (
    "<|turn>assistant",
    "<|turn>model",
    "<|turn>user",
    "<|turn>system",
    "<|turn>",
    "<turn|>",
    "<start_of_turn>model",
    "<start_of_turn>user",
    "<start_of_turn>system",
    "<start_of_turn>",
    "<end_of_turn>",
    "<|im_start|>assistant",
    "<|im_start|>user",
    "<|im_start|>system",
    "<|im_start|>",
    "<|im_end|>",
    "<|eot_id|>",
    "<|endoftext|>",
    "<|begin_of_sentence|>",
    "<|end_of_sentence|>",
    "</s>",
    "<s>",
    "\uFFFD",
)

_STOP_LEAK_PREFIXES = (
    "[Заметка сцены",
    "[Scene note",
    "[Контекст хода",
    "[Указание к ответу",
    "[УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ",
    "[USER TURN DIRECTIVE",
)

_ALL_LOOKAHEAD_PREFIXES = tuple(
    p.lower() for p in (_OPEN_TOKENS + _CLOSE_TOKENS + _STRIP_TOKENS + _STOP_LEAK_PREFIXES)
)


def strip_model_artifacts(text: str) -> str:
    """Remove leaked tokenizer control tokens and echoed prompt notes from text."""
    if not text:
        return ""
    out = _LEAKED_NOTE_RE.sub("", text)
    out = _CONTROL_TOKEN_RE.sub("", out)
    # Collapse leading blank whitespace introduced when leading turn tags are removed.
    return out.lstrip("\r\n")


def extract_reasoning_and_content(text: str) -> Tuple[str, str]:
    """Split native reasoning blocks (Gemma 4 channels, <think>) from visible reply text."""
    if not text:
        return ("", "")

    reasoning_parts = []
    work = text

    for pattern in _REASONING_BLOCK_RES:
        def _collect(match):
            chunk = match.group(1).strip()
            if chunk:
                reasoning_parts.append(chunk)
            return ""
        work = pattern.sub(_collect, work)

    for pattern in _UNCLOSED_REASONING_RES:
        match = pattern.search(work)
        if match:
            chunk = match.group(1).strip()
            if chunk:
                reasoning_parts.append(chunk)
            work = work[:match.start()]

    cleaned = strip_model_artifacts(work).strip()
    reasoning = strip_model_artifacts("\n\n".join(reasoning_parts)).strip()
    return (cleaned, reasoning)


class StreamSanitizer:
    """Incremental chunk sanitizer that routes reasoning deltas and strips control tokens."""

    def __init__(self) -> None:
        self._buf = ""
        self._in_reasoning = False
        self._stopped_on_leak = False
        self._seen_content = False

    def feed(self, chunk: str) -> Tuple[str, str]:
        """Consume a raw text delta and return (content_delta, reasoning_delta)."""
        if not chunk or self._stopped_on_leak:
            return ("", "")

        self._buf += chunk
        content_out = []
        reasoning_out = []

        while self._buf and not self._stopped_on_leak:
            lower = self._buf.lower()

            # Fast path when buffer contains no possible tag opener.
            lt_idx = self._buf.find("<")
            br_idx = self._buf.find("[")
            uff_idx = self._buf.find("\uFFFD")
            candidates = [i for i in (lt_idx, br_idx, uff_idx) if i != -1]
            if not candidates:
                self._emit(self._buf, content_out, reasoning_out)
                self._buf = ""
                break

            idx = min(candidates)
            if idx > 0:
                self._emit(self._buf[:idx], content_out, reasoning_out)
                self._buf = self._buf[idx:]
                continue

            # If buffer could still grow into a longer known token, hold it first.
            if self._has_longer_prefix(lower):
                break

            # Buffer starts at '<', '[', or '\uFFFD'. Check exact matches.
            matched_len = self._try_consume_exact(lower)
            if self._stopped_on_leak:
                break
            if matched_len > 0:
                self._buf = self._buf[matched_len:]
                continue

            # Normal prose character ('<' such as '<emotion>', '[' such as '[Action]', etc.)
            self._emit(self._buf[0], content_out, reasoning_out)
            self._buf = self._buf[1:]

        return ("".join(content_out), "".join(reasoning_out))

    def finish(self) -> Tuple[str, str]:
        """Flush any buffered tail at end-of-stream."""
        if not self._buf or self._stopped_on_leak:
            self._buf = ""
            return ("", "")
        tail = strip_model_artifacts(self._buf)
        self._buf = ""
        if self._in_reasoning:
            return ("", tail)
        return (tail, "")

    def _emit(self, text: str, content_out: list, reasoning_out: list) -> None:
        clean = text.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "").replace("\ufeff", "")
        if not clean:
            return
        if self._in_reasoning:
            reasoning_out.append(clean)
        else:
            if not self._seen_content:
                clean = clean.lstrip("\r\n")
                if not clean:
                    return
                self._seen_content = True
            content_out.append(clean)

    def _try_consume_exact(self, lower: str) -> int:
        # Stop immediately if model echoes an injected scene-note block.
        for prefix in _STOP_LEAK_PREFIXES:
            if lower.startswith(prefix.lower()):
                self._stopped_on_leak = True
                self._buf = ""
                return 0

        if not self._in_reasoning:
            for tok in _OPEN_TOKENS:
                if lower.startswith(tok):
                    self._in_reasoning = True
                    # Trim single immediate newline/space following the opening tag.
                    pos = len(tok)
                    while pos < len(lower) and lower[pos] in (" ", "\t", "\r", "\n"):
                        if lower[pos] == "\n":
                            pos += 1
                            break
                        pos += 1
                    return pos
        else:
            for tok in _CLOSE_TOKENS:
                if lower.startswith(tok):
                    self._in_reasoning = False
                    pos = len(tok)
                    while pos < len(lower) and lower[pos] in (" ", "\t", "\r", "\n"):
                        if lower[pos] == "\n":
                            pos += 1
                            break
                        pos += 1
                    return pos

        for tok in _STRIP_TOKENS:
            if lower.startswith(tok):
                pos = len(tok)
                if pos < len(lower) and lower[pos] == "\n":
                    pos += 1
                return pos

        # Handle <|start_header_id|>role<|end_header_id|>\n
        if lower.startswith("<|start_header_id|>"):
            end = lower.find("<|end_header_id|>")
            if end != -1:
                pos = end + len("<|end_header_id|>")
                if pos < len(lower) and lower[pos] == "\n":
                    pos += 1
                return pos

        return 0

    def _has_longer_prefix(self, lower: str) -> bool:
        if lower.startswith("<|start_header_id|>") and "<|end_header_id|>" not in lower and len(lower) < 64:
            return True
        return any(target.startswith(lower) and len(target) > len(lower) for target in _ALL_LOOKAHEAD_PREFIXES)
