import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub import context, gguf, hardware, planner, sanitize, store  # noqa: E402
from hub import engine as engine_mod  # noqa: E402
from hub.hardware import GIB, build_profile  # noqa: E402


def make_hw(vram_gb=0.0, ram_gb=16.0, kind="cuda"):
    has_gpu = vram_gb > 0
    return {
        "ram_total": int(ram_gb * GIB),
        "ram_available": int(ram_gb * GIB),
        "cpu": {"cores": 8, "threads": 16, "arch": "x86_64", "name": "test"},
        "gpu": {
            "has_gpu": has_gpu,
            "kind": kind if has_gpu else "none",
            "name": "Test GPU",
            "count": 1,
            "vram_total": int(vram_gb * GIB),
            "vram_free": int(vram_gb * GIB),
            "compute_cap": "8.9",
            "driver": "560",
        },
    }


def llama_info(size_gb, n_layer=32, n_head_kv=8, head_dim=128, ctx_train=131072):
    return {
        "size_bytes": int(size_gb * GIB),
        "arch": "llama",
        "n_layer": n_layer,
        "n_ctx_train": ctx_train,
        "n_embd": 4096,
        "n_head": 32,
        "n_head_kv": n_head_kv,
        "key_len": head_dim,
        "val_len": head_dim,
    }


def write_gguf(path, kv):
    def s(text):
        raw = text.encode()
        return struct.pack("<Q", len(raw)) + raw

    blob = b"GGUF" + struct.pack("<I", 3) + struct.pack("<QQ", 0, len(kv))
    for key, value in kv:
        blob += s(key)
        if isinstance(value, str):
            blob += struct.pack("<I", 8) + s(value)
        elif isinstance(value, list):
            blob += struct.pack("<I", 9) + struct.pack("<I", 4) + struct.pack("<Q", len(value))
            blob += b"".join(struct.pack("<I", v) for v in value)
        else:
            blob += struct.pack("<I", 4) + struct.pack("<I", value)
    Path(path).write_bytes(blob)


class PlannerTests(unittest.TestCase):
    def test_small_model_on_big_gpu_gets_large_context_fully_offloaded(self):
        plan = planner.plan_load(llama_info(4.9), make_hw(vram_gb=16))
        self.assertEqual(plan["offload"], "full")
        self.assertEqual(plan["n_gpu_layers"], -1)
        self.assertGreaterEqual(plan["n_ctx"], 16384)
        self.assertEqual(plan["kv_type"], "q8_0")
        self.assertTrue(plan["flash_attn"])

    def test_8gb_gpu_with_8b_model_keeps_comfortable_context(self):
        plan = planner.plan_load(llama_info(4.9), make_hw(vram_gb=8))
        self.assertEqual(plan["offload"], "full")
        self.assertGreaterEqual(plan["n_ctx"], 8192)
        self.assertLessEqual(plan["est_gpu_gb"], 8.0)

    def test_model_larger_than_vram_uses_partial_offload(self):
        plan = planner.plan_load(llama_info(7.5, n_layer=40), make_hw(vram_gb=8, ram_gb=32))
        self.assertEqual(plan["offload"], "partial")
        self.assertGreater(plan["layers_gpu"], 0)
        self.assertLess(plan["layers_gpu"], 40)
        self.assertGreaterEqual(plan["n_ctx"], 4096)

    def test_cpu_only_has_no_gpu_flags(self):
        plan = planner.plan_load(llama_info(2.0), make_hw(vram_gb=0, ram_gb=16))
        self.assertEqual(plan["offload"], "none")
        self.assertEqual(plan["n_gpu_layers"], 0)
        self.assertFalse(plan["flash_attn"])
        self.assertEqual(plan["kv_type"], "f16")
        self.assertLessEqual(plan["n_ctx"], 8192)

    def test_context_never_exceeds_training_length(self):
        plan = planner.plan_load(llama_info(1.0, ctx_train=4096), make_hw(vram_gb=24))
        self.assertLessEqual(plan["n_ctx"], 4096)

    def test_user_context_override_is_respected(self):
        plan = planner.plan_load(llama_info(4.9), make_hw(vram_gb=16), ctx_request=12288)
        self.assertEqual(plan["n_ctx"], 12288)

    def test_kv_quant_halves_cache_estimate(self):
        info = llama_info(4.9)
        self.assertLess(planner.kv_bytes_per_token(info, "q8_0"), planner.kv_bytes_per_token(info, "f16") * 0.6)

    def test_fit_classification(self):
        hw = make_hw(vram_gb=8, ram_gb=32)
        self.assertEqual(planner.classify_fit(int(4.5 * GIB), hw), "gpu_full")
        self.assertEqual(planner.classify_fit(int(12 * GIB), hw), "gpu_partial")
        self.assertEqual(planner.classify_fit(int(60 * GIB), hw), "too_big")
        self.assertEqual(planner.classify_fit(int(4 * GIB), make_hw(vram_gb=0, ram_gb=16)), "cpu_ok")


class ContextTests(unittest.TestCase):
    @staticmethod
    def count(text):
        return len(text) // 4 + 1

    def conversation(self, turns, size=400):
        msgs = [{"role": "system", "content": "You are a character. " * 20}]
        for i in range(turns):
            msgs.append({"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i} " + "x" * size})
        msgs.append({"role": "user", "content": "latest question"})
        return msgs

    def test_short_conversation_is_untouched(self):
        msgs = self.conversation(4, size=50)
        fitted, report = context.fit_messages(msgs, 4096, 512, self.count)
        self.assertEqual(len(fitted), len(msgs))
        self.assertEqual(report["dropped"], 0)

    def test_long_conversation_fits_and_keeps_latest_turn(self):
        msgs = self.conversation(80)
        fitted, report = context.fit_messages(msgs, 2048, 512, self.count)
        total = sum(context.message_tokens(m, self.count) for m in fitted)
        self.assertLessEqual(total, 2048 - 256)
        self.assertEqual(fitted[-1]["content"], "latest question")
        self.assertGreater(report["dropped"], 0)
        self.assertEqual(fitted[0]["role"], "system")
        self.assertIn(context.DIGEST_HEADER, fitted[0]["content"])

    def test_history_starts_with_user_turn_after_pruning(self):
        fitted, _ = context.fit_messages(self.conversation(80), 2048, 512, self.count)
        first_dialogue = next(m for m in fitted if m["role"] != "system")
        self.assertEqual(first_dialogue["role"], "user")

    def test_window_moves_in_blocks_so_the_prompt_prefix_stays_stable(self):
        changes = 0
        previous = None
        for turns in range(90, 120):
            fitted, _ = context.fit_messages(self.conversation(turns, size=60), 2048, 512, self.count)
            prefix = fitted[0]["content"]
            if previous is not None and prefix != previous:
                changes += 1
            previous = prefix
        self.assertLessEqual(changes, 30 // context.BLOCK_MESSAGES + 2)

    def test_oversized_system_prompt_is_trimmed_not_dropped(self):
        msgs = [{"role": "system", "content": "RULES " + "lore " * 4000 + " END"}, {"role": "user", "content": "hi"}]
        fitted, report = context.fit_messages(msgs, 2048, 512, self.count)
        self.assertTrue(report["system_trimmed"])
        self.assertTrue(fitted[0]["content"].startswith("RULES"))
        self.assertTrue(fitted[0]["content"].endswith("END"))

    def test_images_count_against_budget(self):
        image = {"role": "user", "content": [{"type": "text", "text": "look"}, {"type": "image_url", "image_url": {"url": "data:"}}]}
        self.assertGreaterEqual(context.message_tokens(image, self.count), context.IMAGE_TOKENS)


class GgufTests(unittest.TestCase):
    def test_reads_architecture_and_layout(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "m.gguf"
            write_gguf(path, [
                ("general.architecture", "llama"),
                ("general.name", "Test"),
                ("llama.block_count", 32),
                ("llama.context_length", 8192),
                ("llama.embedding_length", 4096),
                ("llama.attention.head_count", 32),
                ("llama.attention.head_count_kv", 8),
                ("tokenizer.ggml.model", "gpt2"),
            ])
            info = gguf.inspect_model(path)
            self.assertTrue(info["valid"])
            self.assertEqual(info["arch"], "llama")
            self.assertEqual(info["n_layer"], 32)
            self.assertEqual(info["n_head_kv"], 8)
            self.assertEqual(info["key_len"], 128)
            self.assertFalse(info["is_projector"])

    def test_detects_projector(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.gguf"
            write_gguf(path, [("general.architecture", "clip"), ("clip.projector_type", "mlp")])
            info = gguf.inspect_model(path)
            self.assertTrue(info["is_projector"])
            self.assertEqual(info["projector_type"], "mlp")

    def test_rejects_non_gguf(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.gguf"
            path.write_bytes(b"not a model at all")
            info = gguf.inspect_model(path)
            self.assertFalse(info["valid"])


class StoreTests(unittest.TestCase):
    def files(self):
        def f(name, gb, proj=False):
            return {"filename": name, "size_bytes": int(gb * GIB), "quant": store.quant_of(name), "is_projector": proj, "split": False}
        return [f("m-Q8_0.gguf", 8.5), f("m-Q6_K.gguf", 6.6), f("m-Q4_K_M.gguf", 4.9), f("m-Q3_K_M.gguf", 3.9),
                f("m-Q2_K.gguf", 3.0), f("mmproj-f16.gguf", 0.9, True)]

    def test_fast_pick_takes_best_quality_that_fits_gpu(self):
        picked = store.pick_file(self.files(), make_hw(vram_gb=12), "fast")
        self.assertEqual(picked["quant"], "Q6_K")
        picked = store.pick_file(self.files(), make_hw(vram_gb=8), "fast")
        self.assertEqual(picked["quant"], "Q4_K_M")

    def test_small_gpu_prefers_smaller_quant(self):
        picked = store.pick_file(self.files(), make_hw(vram_gb=6), "fast")
        self.assertIn(picked["quant"], ("Q4_K_M", "Q3_K_M"))

    def test_stretch_pick_defaults_to_q4(self):
        self.assertEqual(store.pick_file(self.files(), make_hw(vram_gb=8), "stretch")["quant"], "Q4_K_M")

    def test_never_picks_projector_as_model(self):
        picked = store.pick_file(self.files(), make_hw(vram_gb=24), "fast")
        self.assertFalse(picked["is_projector"])
        self.assertEqual(store.pick_projector(self.files())["filename"], "mmproj-f16.gguf")

    def test_repo_id_parsing(self):
        self.assertEqual(store.parse_repo_id("https://huggingface.co/a/b/tree/main"), "a/b")
        self.assertEqual(store.parse_repo_id("a/b"), "a/b")

    def test_generic_file_names_get_repo_prefix(self):
        self.assertEqual(store.local_name("x/Great-Model-GGUF", "Great-Model-Q4_K_M.gguf"), "Great-Model-Q4_K_M.gguf")
        self.assertTrue(store.local_name("x/Great-Model-GGUF", "model-q4.gguf").startswith("Great-Model-"))


class ProfileTests(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(build_profile(make_hw(vram_gb=24))["tier"], "ultra")
        self.assertEqual(build_profile(make_hw(vram_gb=12))["tier"], "high")
        self.assertEqual(build_profile(make_hw(vram_gb=8))["tier"], "mid")
        self.assertEqual(build_profile(make_hw(vram_gb=0))["tier"], "cpu")


class SanitizeTests(unittest.TestCase):
    def test_extracts_gemma4_channel_thought_and_turn_tokens(self):
        raw = "<|turn>model\n<|channel>thought\nLet me plan the scene.\n<channel|><emotion>smirk</emotion> *She lights a cigarette.* Ready?<turn|>"
        content, reasoning = sanitize.extract_reasoning_and_content(raw)
        self.assertEqual(content, "<emotion>smirk</emotion> *She lights a cigarette.* Ready?")
        self.assertEqual(reasoning, "Let me plan the scene.")

    def test_extracts_think_tags_and_strips_leaked_scene_note(self):
        raw = "<think>Check inventory</think>\n*Hands over the keycard.*\n\n[Заметка сцены (не цитируй):\nФакт 1]"
        content, reasoning = sanitize.extract_reasoning_and_content(raw)
        self.assertEqual(content, "*Hands over the keycard.*")
        self.assertEqual(reasoning, "Check inventory")

    def test_stream_sanitizer_buffers_split_control_tokens_without_damaging_emotion(self):
        s = sanitize.StreamSanitizer()
        chunks = [
            "<|tu", "rn>m", "odel\n",
            "<|chan", "nel>thought\n", "Internal ", "plan", "<chan", "nel|>",
            "<emo", "tion>smirk</emotion> *Nods.*",
            "<|im_end|>",
        ]
        out_c, out_r = [], []
        for ch in chunks:
            c, r = s.feed(ch)
            out_c.append(c)
            out_r.append(r)
        tc, tr = s.finish()
        out_c.append(tc)
        out_r.append(tr)
        self.assertEqual("".join(out_c), "<emotion>smirk</emotion> *Nods.*")
        self.assertEqual("".join(out_r).strip(), "Internal plan")

    def test_stream_sanitizer_stops_on_leaked_scene_note(self):
        s = sanitize.StreamSanitizer()
        c1, _ = s.feed("Hello!\n[Замет")
        c2, _ = s.feed("ка сцены:\nSecret]")
        tc, _ = s.finish()
        self.assertEqual(c1 + c2 + tc, "Hello!\n")

    def test_strips_simulated_multi_turn_delimiters_and_empty_brackets(self):
        raw = "<> *She laughs softly.* That is not true.\n>fuser\nHey wait!\n[Собеседник: Алекс]\n[Реплика собеседника:] Stop."
        content, _ = sanitize.extract_reasoning_and_content(raw)
        self.assertEqual(content, "*She laughs softly.* That is not true.")

        s = sanitize.StreamSanitizer()
        out = []
        for ch in ("*Waves.*", "\n[Собесед", "ник: Max]\nHello"):
            c, _ = s.feed(ch)
            out.append(c)
        tail_c, _ = s.finish()
        out.append(tail_c)
        self.assertEqual("".join(out).strip(), "*Waves.*")


class HardwareAndEngineWarningTests(unittest.TestCase):
    def test_parse_mib_handles_units_and_invalid_values(self):
        self.assertEqual(hardware._parse_mib("8192 MiB"), 8192 * 1024 * 1024)
        self.assertEqual(hardware._parse_mib("12288"), 12288 * 1024 * 1024)
        self.assertEqual(hardware._parse_mib(""), 0)
        self.assertEqual(hardware._parse_mib("N/A"), 0)

    def test_detect_windows_wmi_nvidia_parses_card_and_driver(self):
        payload = '[{"Name":"Intel(R) UHD Graphics","AdapterRAM":1073741824,"DriverVersion":"31.0"},' \
                  '{"Name":"NVIDIA GeForce RTX 4060","AdapterRAM":4293918720,"DriverVersion":"32.0.15.6070"}]'
        with mock.patch.object(hardware.os, "name", "nt"), \
             mock.patch.object(hardware.subprocess, "check_output", return_value=payload):
            gpu = hardware._detect_windows_wmi_nvidia()
        self.assertIsNotNone(gpu)
        self.assertEqual(gpu["name"], "NVIDIA GeForce RTX 4060")
        self.assertEqual(gpu["vram_total"], 8 * GIB)
        self.assertEqual(gpu["driver"], "32.0.15.6070")

    def test_build_plan_emits_engine_cpu_only_warning_when_cuda_present_without_offload(self):
        mgr = engine_mod.Engine()
        with mock.patch.object(engine_mod, "inspect_model", return_value=llama_info(4.9)), \
             mock.patch.object(engine_mod, "analyze_hardware", return_value=make_hw(vram_gb=12, kind="cuda")), \
             mock.patch.object(engine_mod, "engine_info", return_value={"available": True, "gpu_offload": False}):
            plan = mgr.build_plan("dummy.gguf", None, {})
        self.assertEqual(plan["offload"], "none")
        self.assertEqual(plan["n_gpu_layers"], 0)
        self.assertIn("engine_cpu_only", plan.get("warnings", []))


if __name__ == "__main__":
    unittest.main()
