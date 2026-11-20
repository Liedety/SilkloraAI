import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub import assistant, coordinator as coord_mod, image_engine as img_mod, library, lora_trainer, paths, planner, settings, store  # noqa: E402
from hub.hardware import GIB  # noqa: E402


def _write_fake_safetensors(path: Path, keys: list[str]) -> None:
    header = {k: {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]} for k in keys}
    raw = json.dumps(header).encode("utf-8")
    path.write_bytes(len(raw).to_bytes(8, "little") + raw + b"\x00\x00")


def make_hw(vram_gb=8.0, ram_gb=16.0, kind="cuda"):
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


class ImageLibraryAndStoreTests(unittest.TestCase):
    def test_infer_image_family_and_ref_support(self):
        self.assertTrue(library.infer_image_family("flux-kontext-dev-Q4_K_M.gguf")["supports_refs"])
        self.assertTrue(library.infer_image_family("Qwen-Image-Edit-2511-Q4_K_M.gguf")["supports_refs"])
        sdxl = library.infer_image_family("illustriousXL_v20.safetensors")
        self.assertEqual(sdxl["family"], "sdxl")
        self.assertFalse(sdxl["needs_companions"])

    def test_pick_file_skips_image_aux_files(self):
        files = [
            {"filename": "ae.safetensors", "size_bytes": int(0.3 * GIB), "quant": "", "is_projector": False, "aux_role": "vae", "split": False},
            {"filename": "t5xxl_fp8_e4m3fn.safetensors", "size_bytes": int(4.6 * GIB), "quant": "FP8", "is_projector": False, "aux_role": "t5xxl", "split": False},
            {"filename": "flux-kontext-Q4_K_M.gguf", "size_bytes": int(5.2 * GIB), "quant": "Q4_K_M", "is_projector": False, "aux_role": None, "split": False},
        ]
        picked = store.pick_file(files, make_hw(vram_gb=12), "fast")
        self.assertIsNotNone(picked)
        self.assertEqual(picked["filename"], "flux-kontext-Q4_K_M.gguf")

    def test_image_asset_selection_windows_and_linux(self):
        assets = [
            {"name": "sd-master-123-bin-win-cuda12-x64.zip", "size": 50000000},
            {"name": "cudart-sd-bin-win-cu12-x64.zip", "size": 120000000},
            {"name": "sd-master-123-bin-win-vulkan-x64.zip", "size": 40000000},
            {"name": "sd-master-123-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip", "size": 307000000},
            {"name": "sd-master-123-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip", "size": 45000000},
            {"name": "sd-master-123-bin-Linux-Ubuntu-26.04-x86_64.zip", "size": 28000000},
        ]
        with mock.patch("platform.system", return_value="Windows"), mock.patch("platform.machine", return_value="AMD64"):
            main_a, extra_a, tag = img_mod._select_sdcpp_assets(assets, make_hw(vram_gb=8, kind="cuda"))
            self.assertIn("win-cuda", main_a["name"])
            self.assertIn("cudart", extra_a["name"])
            self.assertEqual(tag, "cuda12")
        with mock.patch("platform.system", return_value="Linux"), mock.patch("platform.machine", return_value="x86_64"):
            main_l, extra_l, tag_l = img_mod._select_sdcpp_assets(assets, make_hw(vram_gb=8, kind="cuda"))
            self.assertIn("vulkan", main_l["name"])
            self.assertIsNone(extra_l)
            self.assertEqual(tag_l, "vulkan")
            main_cpu, _, tag_cpu = img_mod._select_sdcpp_assets(assets, make_hw(vram_gb=0))
            self.assertEqual(main_cpu["name"], "sd-master-123-bin-Linux-Ubuntu-26.04-x86_64.zip")
            self.assertEqual(tag_cpu, "cpu")

    def test_extract_zip_preserving_symlinks(self):
        import os
        import stat
        import zipfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            zpath = root / "test.zip"
            out_dir = root / "out"
            out_dir.mkdir()
            with zipfile.ZipFile(zpath, "w") as zf:
                real_info = zipfile.ZipInfo("bin/libdemo.so.1.0")
                real_info.external_attr = (stat.S_IFREG | 0o755) << 16
                zf.writestr(real_info, b"REAL_LIB_DATA")

                link_info = zipfile.ZipInfo("bin/libdemo.so.1")
                link_info.create_system = 3
                link_info.external_attr = (stat.S_IFLNK | 0o777) << 16
                zf.writestr(link_info, b"libdemo.so.1.0")

                evil_info = zipfile.ZipInfo("../escaped.txt")
                zf.writestr(evil_info, b"nope")

            img_mod._extract_zip_preserving_symlinks(zpath, out_dir)
            self.assertEqual((out_dir / "bin/libdemo.so.1.0").read_bytes(), b"REAL_LIB_DATA")
            self.assertFalse((root / "escaped.txt").exists())
            if os.name != "nt":
                self.assertTrue((out_dir / "bin/libdemo.so.1").is_symlink())
                self.assertEqual(os.readlink(out_dir / "bin/libdemo.so.1"), "libdemo.so.1.0")

    def test_scan_image_library_reads_models_aux_and_loras(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            img_dir.mkdir()
            aux_dir.mkdir()
            lora_dir.mkdir()
            (img_dir / "qwen-image-edit-Q4_K_M.gguf").write_bytes(b"0" * 1024)
            (aux_dir / "ae.safetensors").write_bytes(b"0" * 512)
            (lora_dir / "hero_lora.safetensors").write_bytes(b"0" * 256)

            with mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", side_effect=lambda k: {"trigger_word": "slx_hero"} if k.startswith("loras/") else {}):
                lib = library.scan_image_library("qwen-image-edit-Q4_K_M.gguf")
                self.assertEqual(len(lib["models"]), 1)
                self.assertTrue(lib["models"][0]["is_active"])
                self.assertTrue(lib["models"][0]["supports_refs"])
                self.assertEqual(lib["aux_files"][0]["role"], "vae")
                self.assertEqual(lib["loras"][0]["trigger_word"], "slx_hero")

    def test_search_and_file_role_filter_hf_lora_tags(self):
        fake_items = [
            {
                "id": "furproxy/krea2-kroma-furryplus-general-nsfw-and-aesthetics",
                "downloads": 9000,
                "likes": 120,
                "pipeline_tag": "text-to-image",
                "tags": ["diffusers", "text-to-image", "lora", "template:diffusion-lora"],
            },
            {
                "id": "Lykon/dreamshaper-xl-v2-turbo",
                "downloads": 8000,
                "likes": 250,
                "pipeline_tag": "text-to-image",
                "tags": ["diffusers", "text-to-image", "sdxl"],
            },
        ]
        with mock.patch.object(store, "_get_json", return_value=fake_items):
            hits = store.search("kroma", "image", lambda _: True)
            ids = [h["repo_id"] for h in hits]
            self.assertEqual(ids, ["Lykon/dreamshaper-xl-v2-turbo"])

        self.assertEqual(
            store._file_role(
                {"filename": "krea2-kroma-furryplus_v2_r768.safetensors", "size_bytes": 1_500_000_000, "is_projector": False, "aux_role": None},
                ["template:diffusion-lora", "lora"],
                True,
            ),
            "lora",
        )

    def test_move_image_to_lora_relocates_file_and_meta(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            lora_dir = root / "loras"
            meta_file = root / "models_meta.json"
            img_dir.mkdir()
            lora_dir.mkdir()
            _write_fake_safetensors(img_dir / "char_style_r768.safetensors", ["lora_unet_down_blocks.lora_down.weight"])
            with mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, LORAS_DIR=lora_dir, META_FILE=meta_file):
                library.set_meta("image/char_style_r768.safetensors", {"repo": "test/char-lora", "weight_role": "lora"})
                res = library.move_image_to_lora("char_style_r768.safetensors")
                self.assertTrue(res["ok"])
                self.assertFalse((img_dir / "char_style_r768.safetensors").exists())
                self.assertTrue((lora_dir / "char_style_r768.safetensors").is_file())
                self.assertEqual(library.get_meta("image/char_style_r768.safetensors"), {})
                self.assertEqual(library.get_meta("loras/char_style_r768.safetensors")["weight_role"], "lora")


class CoordinatorTests(unittest.TestCase):
    def test_prepare_for_image_unloads_llm_and_defers_background_chat(self):
        coord = coord_mod.Coordinator()
        fake_engine = mock.MagicMock()
        fake_engine.llama = object()
        fake_engine.is_loading = False
        fake_engine.model_name = "rp-model-Q4_K_M.gguf"
        fake_engine.projector_name = ""
        fake_engine.status.return_value = {"model": "rp-model-Q4_K_M.gguf", "projector": "", "n_ctx": 8192}

        with mock.patch.object(coord_mod, "engine", fake_engine), \
             mock.patch.object(coord_mod, "image_engine", mock.MagicMock()), \
             mock.patch.object(coord, "can_coexist", return_value=False):
            prep = coord.prepare_for_image("flux.gguf")
            self.assertTrue(prep["unloaded_llm"])
            self.assertEqual(coord.mode, "image")
            self.assertEqual(coord.saved_llm["model"], "rp-model-Q4_K_M.gguf")
            fake_engine.unload.assert_called_once()

            # Simulate LLM now unloaded cleanly
            fake_engine.llama = None
            # Background memory/summary request must NOT evict image mode!
            self.assertEqual(coord.ensure_llm_for_chat(is_background=True), "deferred")
            self.assertEqual(coord.mode, "image")
            fake_engine.load_async.assert_not_called()

    def test_non_background_chat_restores_saved_llm(self):
        coord = coord_mod.Coordinator()
        coord.mode = "image"
        coord.saved_llm = {"model": "rp-model-Q4_K_M.gguf", "projector": "mmproj.gguf", "ctx": 8192}

        with tempfile.TemporaryDirectory() as tmp:
            models_dir = Path(tmp)
            (models_dir / "rp-model-Q4_K_M.gguf").write_bytes(b"m")
            (models_dir / "mmproj.gguf").write_bytes(b"p")

            fake_engine = mock.MagicMock()
            fake_engine.llama = None
            fake_engine.is_loading = False

            def fake_load(model, proj, opts):
                fake_engine.llama = object()

            fake_engine.load_async.side_effect = fake_load
            fake_img = mock.MagicMock()

            with mock.patch.object(coord_mod, "engine", fake_engine), \
                 mock.patch.object(coord_mod, "image_engine", fake_img), \
                 mock.patch.object(coord_mod.paths, "MODELS_DIR", models_dir):
                res = coord.ensure_llm_for_chat(is_background=False)
                self.assertEqual(res, "ok")
                self.assertEqual(coord.mode, "llm")
                self.assertIsNone(coord.saved_llm)
                fake_img.unload.assert_called_once()
                fake_engine.load_async.assert_called_once_with("rp-model-Q4_K_M.gguf", "mmproj.gguf", {"n_ctx": 8192})


class ImageEngineCommandTests(unittest.TestCase):
    def test_sdcpp_builds_refs_and_lora_command_and_parses_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            (img_dir / "flux-kontext-Q4_K_M.gguf").write_bytes(b"x" * 100)
            (aux_dir / "ae.safetensors").write_bytes(b"x" * 100)
            (aux_dir / "clip_l.safetensors").write_bytes(b"x" * 100)
            (aux_dir / "t5xxl_fp8_e4m3fn.safetensors").write_bytes(b"x" * 100)
            (lora_dir / "hero.safetensors").write_bytes(b"x" * 100)

            eng = img_mod.ImageEngine()
            captured_cmd = []

            class FakeProc:
                def __init__(self, cmd):
                    captured_cmd.extend(cmd)
                    self.stdout = iter(["step 1/4\n", "step 4/4\n"])
                    out_idx = cmd.index("-o") + 1
                    Path(cmd[out_idx]).write_bytes(b"\x89PNG\r\n\x1a\nFAKEPNG")

                def poll(self):
                    return 0

                def wait(self):
                    return 0

            dummy_ref = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/"

            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=None), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=Path("/usr/bin/sd-cli")), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "flux-kontext-Q4_K_M.gguf"}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=lambda cmd, **kw: FakeProc(cmd)):
                job = eng.submit_job({
                    "prompt": "cafe at dusk, low angle shot",
                    "references": [dummy_ref],
                    "loras": [{"filename": "hero.safetensors", "weight": 0.8, "trigger_word": "slx_hero"}],
                    "width": 768,
                    "height": 1024,
                    "steps": 4,
                    "seed": 42,
                }, wait=True)

            self.assertEqual(job["status"], "done")
            self.assertIn("--diffusion-model", captured_cmd)
            self.assertIn("--vae", captured_cmd)
            self.assertIn("--clip_l", captured_cmd)
            self.assertIn("--t5xxl", captured_cmd)
            self.assertIn("-r", captured_cmd)
            self.assertIn("--lora-model-dir", captured_cmd)
            self.assertIn("--offload-to-cpu", captured_cmd)
            p_val = captured_cmd[captured_cmd.index("-p") + 1]
            self.assertIn("<lora:hero:0.80>", p_val)
            self.assertIn("slx_hero", p_val)
            self.assertTrue(job["result"]["image_base64"].startswith("data:image/png;base64,"))

    def test_sdcpp_rejects_missing_companions_and_lora_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            (img_dir / "flux-kontext-Q4_K_M.gguf").write_bytes(b"x" * 100)
            (aux_dir / "ae.safetensors").write_bytes(b"x" * 100)
            _write_fake_safetensors(img_dir / "style_only.safetensors", ["lora_unet_down_blocks.lora_down.weight"])

            eng = img_mod.ImageEngine()
            with mock.patch.object(img_mod, "find_sd_binary", return_value=Path("/usr/bin/sd-cli")), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "flux-kontext-Q4_K_M.gguf"}):
                bad_comp = eng.submit_job({"prompt": "test portrait", "steps": 4}, wait=True)
                self.assertEqual(bad_comp["status"], "error")
                self.assertIn("missing required companion", bad_comp["error"].lower())

            with mock.patch.object(img_mod, "find_sd_binary", return_value=Path("/usr/bin/sd-cli")), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "style_only.safetensors"}):
                bad_lora = eng.submit_job({"prompt": "test portrait", "steps": 4}, wait=True)
                self.assertEqual(bad_lora["status"], "error")
                self.assertIn("lora", bad_lora["error"].lower())

    def test_inspect_safetensors_header_classifies_weights_and_non_blocking_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ckpt = root / "sdxl_ckpt.safetensors"
            chroma = root / "krea2-kroma.safetensors"
            lora = root / "char_lora.safetensors"
            _write_fake_safetensors(ckpt, ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"])
            _write_fake_safetensors(chroma, ["double_blocks.0.img_attn.weight", "single_blocks.0.linear1.weight", "distilled_guidance_layer.in_layer.weight"])
            _write_fake_safetensors(lora, ["lora_te1_text_model.lora_down.weight"])

            self.assertEqual(library.inspect_safetensors_header(ckpt)["weight_role"], "checkpoint")
            self.assertEqual(library.inspect_safetensors_header(chroma)["weight_role"], "diffusion_model")
            self.assertEqual(library.inspect_safetensors_header(chroma)["arch_hint"], "chroma")
            self.assertEqual(library.inspect_safetensors_header(lora)["weight_role"], "lora")
            self.assertEqual(library.infer_image_family("krea2-kroma-furryplus.safetensors")["family"], "chroma")

            gguf_ckpt = root / "sdxs-512-Q8_0.gguf"
            gguf_ckpt.write_bytes(b"GGUF\x03\x00\x00\x00" + b"model.diffusion_model.input_blocks.0.weight\x00first_stage_model.decoder.conv_in.weight\x00cond_stage_model.transformer.weight\x00")
            gguf_hdr = library.inspect_image_gguf_header(gguf_ckpt)
            self.assertEqual(gguf_hdr["weight_role"], "checkpoint")
            self.assertEqual(gguf_hdr["arch_hint"], "sd15")

        t0 = time.monotonic()
        st = img_mod.image_engine.engine_status()
        lt = lora_trainer.lora_trainer.status()
        elapsed = time.monotonic() - t0
        self.assertIn("sdcpp", st)
        self.assertIn("installed", lt)
        self.assertLess(elapsed, 0.25)


class AssistantTests(unittest.TestCase):
    def test_save_config_preserves_masked_api_key_and_recommend_grounds_candidates(self):
        stored = {**settings.DEFAULTS, "assistant_api_key": "sk-secret-value-1234"}

        def fake_get_all():
            return dict(stored)

        def fake_update(patch):
            stored.update(patch)
            return dict(stored)

        with mock.patch.multiple(assistant.settings_mod, get_all=fake_get_all, update=fake_update):
            cfg = assistant.public_config()
            self.assertEqual(cfg["api_key_preview"], "sk-s...1234")
            # Submitting masked value should NOT overwrite stored secret
            assistant.save_config({"api_key": cfg["api_key_preview"], "mode": "api"})
            self.assertEqual(stored["assistant_api_key"], "sk-secret-value-1234")

            fake_detail = {
                "repo_id": "test/Qwen-Image-Edit-GGUF",
                "name": "Qwen-Image-Edit-GGUF",
                "downloads": 5000,
                "likes": 200,
                "pipeline": "image-to-image",
                "family": "qwen_edit",
                "supports_refs": True,
                "needs_companions": True,
                "arch_supported": True,
                "files": [{"filename": "model-Q4_K_M.gguf", "size_bytes": int(4.8 * GIB), "quant": "Q4_K_M", "is_projector": False, "aux_role": None, "split": False}],
            }
            with mock.patch.object(assistant, "_call_chat_ai", side_effect=[
                '{"kind": "image", "search_terms": ["qwen image edit gguf"], "needs_refs": true}',
                "Recommended test/Qwen-Image-Edit-GGUF for consistent character scene generation on 8 GB VRAM.",
            ]), \
                 mock.patch.object(assistant.store, "curated_image_repos", return_value=[]), \
                 mock.patch.object(assistant.store, "search", return_value=[{"repo_id": "test/Qwen-Image-Edit-GGUF", "name": "Qwen-Image-Edit-GGUF", "downloads": 5000, "pipeline": "image-to-image"}]), \
                 mock.patch.object(assistant.store, "inspect_repo", return_value=fake_detail):
                rec = assistant.recommend("model that keeps my character face consistent", hw=make_hw(vram_gb=8))
                self.assertEqual(len(rec["candidates"]), 1)
                c = rec["candidates"][0]
                self.assertEqual(c["repo_id"], "test/Qwen-Image-Edit-GGUF")
                self.assertEqual(c["fit"], "gpu_full")
                self.assertTrue(c["supports_refs"])
                self.assertGreaterEqual(len(c["companions"]), 1)

    def test_recommend_local_chat_returns_downloadable_cards_for_prose_reply(self):
        fake_detail = {
            "repo_id": "Lykon/dreamshaper-xl-v2-turbo",
            "name": "dreamshaper-xl-v2-turbo",
            "downloads": 12000,
            "likes": 300,
            "pipeline": "text-to-image",
            "family": "sdxl",
            "supports_refs": False,
            "needs_companions": False,
            "arch_supported": True,
            "files": [{"filename": "DreamShaperXL_Turbo_v2.safetensors", "size_bytes": int(6.4 * GIB), "quant": "FP16", "is_projector": False, "aux_role": None, "split": False}],
        }
        with mock.patch.object(assistant.settings_mod, "get_all", return_value={**settings.DEFAULTS, "assistant_mode": "local"}), \
             mock.patch.object(assistant, "_call_chat_ai", side_effect=[
                 "<thought>Thinking...</thought> For fast scenes you can try Lykon/dreamshaper-xl-v2-turbo.",
                 "Great fast SDXL checkpoint with crisp lighting and portraits.",
             ]), \
             mock.patch.object(assistant.store, "curated_image_repos", return_value=[]), \
             mock.patch.object(assistant.store, "search", return_value=[{"repo_id": "Lykon/dreamshaper-xl-v2-turbo", "name": "dreamshaper-xl-v2-turbo", "downloads": 12000, "pipeline": "text-to-image"}]), \
             mock.patch.object(assistant.store, "inspect_repo", return_value=fake_detail):
            rec = assistant.recommend("хочу быструю модель для красивых сцен на 8 ГБ", hw=make_hw(vram_gb=8))
            self.assertNotIn("<thought>", rec["answer"])
            self.assertGreaterEqual(len(rec["candidates"]), 1)
            self.assertEqual(rec["candidates"][0]["file"]["filename"], "DreamShaperXL_Turbo_v2.safetensors")
            self.assertGreater(rec["candidates"][0]["total_bytes"], 0)


class ArchitectureRegressionTests(unittest.TestCase):
    def test_active_vram_load_never_flips_profile_or_plan_to_cpu(self):
        from hub import hardware, planner

        hw = make_hw(vram_gb=8, ram_gb=32)
        # Simulate active model occupying 7.8 GB of 8.0 GB VRAM
        hw["gpu"]["vram_free"] = int(0.2 * GIB)

        profile = hardware.build_profile(hw)
        self.assertEqual(profile["mode"], "gpu")
        self.assertNotEqual(profile["tier"], "cpu")
        self.assertGreater(profile["gpu_budget_gb"], 6.0)

        plan = planner.plan_load(
            {
                "size_bytes": int(4.8 * GIB),
                "arch": "llama",
                "n_layer": 32,
                "n_ctx_train": 32768,
                "n_embd": 4096,
                "n_head": 32,
                "n_head_kv": 8,
                "key_len": 128,
                "val_len": 128,
            },
            hw,
        )
        self.assertEqual(plan["offload"], "full")
        self.assertNotIn("cpu_only_with_gpu", plan["warnings"])

        self.assertEqual(planner.classify_image_fit(int(4.8 * GIB), hw), "gpu_full")
        self.assertEqual(planner.classify_image_fit(int(11.0 * GIB), hw), "gpu_stream")

    def test_sanitize_image_bytes_rejects_svg_and_normalizes_webp_rgba(self):
        import base64
        import io

        svg_url = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>"
        self.assertIsNone(img_mod._sanitize_image_bytes(svg_url))

        svg_b64 = "data:image/png;base64," + base64.b64encode(b"<svg width='32'></svg>").decode("ascii")
        self.assertIsNone(img_mod._sanitize_image_bytes(svg_b64))

        # Raw PNG header works even without PIL fallback
        raw_png_url = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nRAWPNGDATA").decode("ascii")
        self.assertIsNotNone(img_mod._sanitize_image_bytes(raw_png_url))

        try:
            from PIL import Image
        except ImportError:
            return

        rgba = Image.new("RGBA", (1400, 900), (80, 120, 200, 180))
        buf = io.BytesIO()
        rgba.save(buf, format="WEBP")
        webp_data_url = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")

        sanitized = img_mod._sanitize_image_bytes(webp_data_url, max_dim=768)
        self.assertIsNotNone(sanitized)
        normalized, ext, durl = sanitized
        self.assertEqual(ext, "jpg")
        self.assertTrue(durl.startswith("data:image/jpeg;base64,"))
        parsed = Image.open(io.BytesIO(normalized))
        self.assertEqual(parsed.mode, "RGB")
        self.assertLessEqual(max(parsed.size), 768)

    def test_sd_server_persistent_daemon_keeps_model_warm_across_regenerations_and_unloads(self):
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            fake_srv = root / "sd-server"
            fake_srv.write_bytes(b"bin")
            _write_fake_safetensors(
                img_dir / "sdxl_turbo.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )

            eng = img_mod.ImageEngine()
            spawn_count = 0
            fake_png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nWARMPNG").decode("ascii")

            class FakeDaemonProc:
                def __init__(self, cmd, **kw):
                    nonlocal spawn_count
                    spawn_count += 1
                    self.cmd = cmd
                    self.stdout = iter([])
                    self.terminated = False

                def poll(self):
                    return 0 if self.terminated else None

                def terminate(self):
                    self.terminated = True

                def wait(self, timeout=None):
                    self.terminated = True
                    return 0

                def kill(self):
                    self.terminated = True

            class FakeResp:
                def __init__(self, status_code, data):
                    self.status_code = status_code
                    self.ok = 200 <= status_code < 300
                    self._data = data
                    self.text = str(data)

                def json(self):
                    return self._data

            def fake_get(url, timeout=None):
                if url.endswith("/v1/models"):
                    return FakeResp(200, {"data": [{"id": "sdxl_turbo"}]})
                if "/sdcpp/v1/jobs/" in url:
                    return FakeResp(200, {"id": "srv_1", "status": "completed", "result": {"images": [{"b64_json": fake_png_b64}]}})
                return FakeResp(404, {})

            def fake_post(url, json=None, timeout=None):
                if url.endswith("/sdcpp/v1/img_gen"):
                    return FakeResp(200, {"id": "srv_1"})
                if url.endswith("/sdcpp/v1/models/unload"):
                    return FakeResp(200, {"ok": True})
                return FakeResp(200, {"ok": True})

            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=fake_srv), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=None), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "sdxl_turbo.safetensors"}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=FakeDaemonProc), \
                 mock.patch("requests.get", side_effect=fake_get), \
                 mock.patch("requests.post", side_effect=fake_post):
                j1 = eng.submit_job({"prompt": "rainy street, wide shot", "steps": 8}, wait=True)
                j2 = eng.submit_job({"prompt": "rainy street, close-up portrait", "steps": 8}, wait=True)
                self.assertEqual(j1["status"], "done")
                self.assertEqual(j2["status"], "done")
                # Persistent sd-server must be spawned ONCE across multiple scene generations/angles!
                self.assertEqual(spawn_count, 1)
                self.assertTrue(eng.engine_status()["sdcpp"]["daemon_running"])

                eng.unload()
                self.assertFalse(eng.engine_status()["sdcpp"]["daemon_running"])

    def test_sd_server_passes_vae_on_cpu_for_8gb_dit_or_reference_runs(self):
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            fake_srv = root / "sd-server"
            fake_srv.write_bytes(b"bin")
            (img_dir / "flux-kontext-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            (aux_dir / "ae.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "clip_l.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "t5xxl_q4_k_m.gguf").write_bytes(b"GGUF" + b"\x00" * 32)

            eng = img_mod.ImageEngine()
            spawned_cmds = []
            fake_png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nREFPNG").decode("ascii")

            class FakeDaemonProc:
                def __init__(self, cmd, **kw):
                    spawned_cmds.append(list(cmd))
                    self.cmd = cmd
                    self.stdout = iter([])
                    self.terminated = False

                def poll(self):
                    return 0 if self.terminated else None

                def terminate(self):
                    self.terminated = True

                def wait(self, timeout=None):
                    self.terminated = True
                    return 0

                def kill(self):
                    self.terminated = True

            class FakeResp:
                def __init__(self, status_code, data):
                    self.status_code = status_code
                    self.ok = 200 <= status_code < 300
                    self._data = data
                    self.text = str(data)

                def json(self):
                    return self._data

            def fake_get(url, timeout=None):
                if url.endswith("/v1/models"):
                    return FakeResp(200, {"data": [{"id": "flux_kontext"}]})
                if "/sdcpp/v1/jobs/" in url:
                    return FakeResp(200, {"id": "srv_ref", "status": "completed", "result": {"images": [{"b64_json": fake_png_b64}]}})
                return FakeResp(404, {})

            def fake_post(url, json=None, timeout=None):
                if url.endswith("/sdcpp/v1/img_gen"):
                    return FakeResp(200, {"id": "srv_ref"})
                return FakeResp(200, {"ok": True})

            ref_img = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nREFDATA").decode("ascii")
            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=fake_srv), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=None), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "flux-kontext-Q4_K_M.gguf"}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=FakeDaemonProc), \
                 mock.patch("requests.get", side_effect=fake_get), \
                 mock.patch("requests.post", side_effect=fake_post):
                res = eng.submit_job({"prompt": "portrait", "references": [ref_img], "steps": 6}, wait=True)
                self.assertEqual(res["status"], "done")
                self.assertEqual(len(spawned_cmds), 1)
                self.assertIn("--vae-on-cpu", spawned_cmds[0], "8 GB reference runs must pass --vae-on-cpu on first pass to prevent 25%/96% VAE OOM")
                eng.unload()

    def test_actual_load_plan_respects_external_vram_pressure_and_steps_down_gpu_layers_before_cpu(self):
        from hub import engine as eng_mod, planner

        hw = make_hw(vram_gb=8, ram_gb=32)
        # Simulate Windows DWM + browser holding 2.6 GiB on an 8 GiB GPU after model unload (5.4 GiB free)
        hw["gpu"]["vram_free"] = int(5.4 * GIB)
        meta = {
            "size_bytes": int(5.6 * GIB),
            "arch": "llama",
            "n_layer": 32,
            "n_ctx_train": 32768,
            "n_embd": 4096,
            "n_head": 32,
            "n_head_kv": 8,
            "key_len": 128,
            "val_len": 128,
        }

        catalog_plan = planner.plan_load(meta, hw, ignore_active_load=True)
        actual_plan = planner.plan_load(meta, hw, ignore_active_load=False)
        self.assertEqual(catalog_plan["offload"], "full")
        # Actual load after unload must respect real free VRAM and use partial GPU offload rather than crashing into CPU
        self.assertEqual(actual_plan["offload"], "partial")
        self.assertGreater(actual_plan["n_gpu_layers"], 0)
        self.assertLess(actual_plan["n_gpu_layers"], 32)
        self.assertNotIn("cpu_only_with_gpu", actual_plan["warnings"])

        attempts = eng_mod.Engine()._attempts(catalog_plan)
        # Before ever dropping to 0 GPU layers, Engine._attempts must step down GPU layers with Flash Attention intact
        zero_idx = next(i for i, (cfg, _off, _kv) in enumerate(attempts) if cfg.get("n_gpu_layers") == 0)
        partial_before_zero = [
            cfg for (cfg, _off, _kv) in attempts[:zero_idx]
            if 0 < cfg.get("n_gpu_layers", 0) < catalog_plan["n_layer"] and cfg.get("flash_attn") is True
        ]
        self.assertGreaterEqual(len(partial_before_zero), 2)

    def test_legacy_empty_api_assistant_mode_normalizes_to_local_on_load(self):
        import json

        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = Path(tmp) / "settings.json"
            cfg_file.write_text(
                json.dumps({"assistant_mode": "api", "assistant_api_key": "", "assistant_base_url": ""}),
                encoding="utf-8",
            )
            with mock.patch.object(settings, "SETTINGS_FILE", cfg_file), \
                 mock.patch.dict(settings._cache, {}, clear=True):
                loaded = settings.get_all()
                self.assertEqual(loaded["assistant_mode"], "local")

    def test_progress_parser_ignores_tensor_counts_and_tracks_sampling_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            _write_fake_safetensors(
                img_dir / "sdxl_model.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )
            eng = img_mod.ImageEngine()
            observed_states = []

            class FakeCliProc:
                def __init__(self, cmd, **kw):
                    out_idx = cmd.index("-o") + 1
                    Path(cmd[out_idx]).write_bytes(b"\x89PNG\r\n\x1a\nCLIPNG")

                    def _lines():
                        yield "[INFO] loaded 196/196 tensors from disk\n"
                        observed_states.append(dict(list(eng._jobs.values())[0]))
                        yield "  |==========          | 10/20 - 6.50s/it\n"
                        observed_states.append(dict(list(eng._jobs.values())[0]))
                        yield "  |====================| 20/20 - 6.50s/it\n"
                        yield "[INFO] vae tile 35/35\n"
                        observed_states.append(dict(list(eng._jobs.values())[0]))

                    self.stdout = _lines()

                def poll(self):
                    return 0

                def wait(self):
                    return 0

            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=None), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=Path("/usr/bin/sd-cli")), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "sdxl_model.safetensors"}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=FakeCliProc):
                res = eng.submit_job({"prompt": "portrait", "steps": 20}, wait=True)
                self.assertEqual(res["status"], "done")
                # After 196/196 tensors line: step must remain 0, progress still ~20% (not 98%)
                self.assertEqual(observed_states[0]["step"], 0)
                self.assertLessEqual(observed_states[0]["progress"], 21.0)
                # After 10/20 step line: step == 10
                self.assertEqual(observed_states[1]["step"], 10)
                # After 20/20 + 35/35 VAE tile line: stage == decoding
                self.assertEqual(observed_states[2]["stage"], "decoding")

    def test_web_i18n_parity_and_clean_ui_rules(self):
        import re

        web_dir = Path(__file__).resolve().parent.parent / "web"
        i18n_text = (web_dir / "i18n.js").read_text(encoding="utf-8")
        app_text = (web_dir / "app.js").read_text(encoding="utf-8")
        html_text = (web_dir / "index.html").read_text(encoding="utf-8")

        ru_part = i18n_text.split("en: {")[0]
        en_part = "en: {" + i18n_text.split("en: {")[1]
        ru_keys = set(re.findall(r"^\s{4}([a-zA-Z0-9_]+):", ru_part, re.MULTILINE))
        en_keys = set(re.findall(r"^\s{4}([a-zA-Z0-9_]+):", en_part, re.MULTILINE))
        self.assertEqual(ru_keys, en_keys)

        emoji_re = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]")
        for name, content in (("i18n.js", i18n_text), ("app.js", app_text), ("index.html", html_text)):
            self.assertIsNone(emoji_re.search(content), f"Emoji found in {name}")
            self.assertIsNone(re.search(r"\bbeta\b", content, re.IGNORECASE), f"'beta' word found in {name}")

        # Component installation belongs strictly in start-server.bat / start-server.sh, not web buttons
        self.assertNotIn("installSdBtn", app_text)
        self.assertNotIn("installLoraBtn", app_text)

    def test_distilled_flow_families_enforce_cfg_one_and_empty_negative_prompt_even_with_legacy_settings(self):
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()
            fake_srv = root / "sd-server"
            fake_srv.write_bytes(b"bin")
            (img_dir / "flux-kontext-dev-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            (img_dir / "z-image-turbo-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            _write_fake_safetensors(
                img_dir / "sdxl_base.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )
            (aux_dir / "ae.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "clip_l.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "t5xxl_q4_k_m.gguf").write_bytes(b"GGUF" + b"\x00" * 32)
            (aux_dir / "qwen3_4b_text_encoder.gguf").write_bytes(b"GGUF" + b"\x00" * 32)

            eng = img_mod.ImageEngine()
            submitted_payloads = []
            fake_png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nCLEANPNG").decode("ascii")

            class FakeDaemonProc:
                def __init__(self, cmd, **kw):
                    self.cmd = cmd
                    self.stdout = iter([])
                    self.terminated = False

                def poll(self):
                    return 0 if self.terminated else None

                def terminate(self):
                    self.terminated = True

                def wait(self, timeout=None):
                    self.terminated = True
                    return 0

                def kill(self):
                    self.terminated = True

            class FakeResp:
                def __init__(self, status_code, data):
                    self.status_code = status_code
                    self.ok = 200 <= status_code < 300
                    self._data = data
                    self.text = str(data)

                def json(self):
                    return self._data

            def fake_get(url, timeout=None):
                if url.endswith("/v1/models"):
                    return FakeResp(200, {"data": [{"id": "loaded"}]})
                if "/sdcpp/v1/jobs/" in url:
                    return FakeResp(200, {"id": "srv_clean", "status": "completed", "result": {"images": [{"b64_json": fake_png_b64}]}})
                return FakeResp(404, {})

            def fake_post(url, json=None, timeout=None):
                if url.endswith("/sdcpp/v1/img_gen"):
                    submitted_payloads.append(dict(json or {}))
                    return FakeResp(200, {"id": "srv_clean"})
                return FakeResp(200, {"ok": True})

            stale_cfg = {
                **settings.DEFAULTS,
                "image_model": "flux-kontext-dev-Q4_K_M.gguf",
                "image_cfg": 5.0,
                "image_steps": 4,
            }

            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=fake_srv), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=None), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value=stale_cfg), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=FakeDaemonProc), \
                 mock.patch("requests.get", side_effect=fake_get), \
                 mock.patch("requests.post", side_effect=fake_post):
                # 1) flux_kontext via sd-server: must clamp txt_cfg=1.0, clear negative_prompt, and floor global steps>=12
                res_fk = eng.submit_job(
                    {
                        "prompt": "cinematic evening cafe portrait",
                        "negative_prompt": "lowres, blurry, deformed hands",
                    },
                    wait=True,
                )
                self.assertEqual(res_fk["status"], "done")
                fk_payload = submitted_payloads[-1]
                self.assertEqual(fk_payload["negative_prompt"], "")
                self.assertEqual(fk_payload["sample_params"]["guidance"]["txt_cfg"], 1.0)
                self.assertEqual(fk_payload["sample_params"]["guidance"]["distilled_guidance"], 3.5)
                self.assertGreaterEqual(fk_payload["sample_params"]["sample_steps"], 12)
                self.assertTrue(res_fk["result"]["image_url"].startswith("/v1/images/files/"))

                # 2) z_image via sd-server: must also force txt_cfg=1.0 and empty negative_prompt
                res_z = eng.submit_job(
                    {
                        "model": "z-image-turbo-Q4_K_M.gguf",
                        "prompt": "sunlit courtyard",
                        "negative_prompt": "watermark, text",
                        "cfg_scale": 6.0,
                    },
                    wait=True,
                )
                self.assertEqual(res_z["status"], "done")
                z_payload = submitted_payloads[-1]
                self.assertEqual(z_payload["negative_prompt"], "")
                self.assertEqual(z_payload["sample_params"]["guidance"]["txt_cfg"], 1.0)

                # 3) Non-distilled SDXL still honors negative_prompt and cfg_scale
                res_sdxl = eng.submit_job(
                    {
                        "model": "sdxl_base.safetensors",
                        "prompt": "lantern street",
                        "negative_prompt": "lowres, blurry",
                    },
                    wait=True,
                )
                self.assertEqual(res_sdxl["status"], "done")
                sdxl_payload = submitted_payloads[-1]
                self.assertEqual(sdxl_payload["negative_prompt"], "lowres, blurry")
                self.assertEqual(sdxl_payload["sample_params"]["guidance"]["txt_cfg"], 5.0)
                eng.unload()

            # 4) sd-cli fallback also omits -n and passes --cfg-scale 1.00 for distilled models
            cli_cmds = []

            class FakeCliProc:
                def __init__(self, cmd, **kw):
                    cli_cmds.append(list(cmd))
                    out_idx = cmd.index("-o") + 1
                    Path(cmd[out_idx]).write_bytes(b"\x89PNG\r\n\x1a\nCLIPNG")
                    self.stdout = iter(["step 14/14\n"])

                def poll(self):
                    return 0

                def wait(self):
                    return 0

            with mock.patch.object(img_mod, "find_sd_server_binary", return_value=None), \
                 mock.patch.object(img_mod, "find_sd_binary", return_value=Path("/usr/bin/sd-cli")), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value=stale_cfg), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)), \
                 mock.patch("subprocess.Popen", side_effect=FakeCliProc):
                res_cli = eng.submit_job(
                    {"prompt": "portrait", "negative_prompt": "bad hands", "steps": 14},
                    wait=True,
                )
                self.assertEqual(res_cli["status"], "done")
                cmd = cli_cmds[-1]
                self.assertNotIn("-n", cmd)
                cfg_idx = cmd.index("--cfg-scale") + 1
                self.assertEqual(cmd[cfg_idx], "1.00")
                self.assertTrue(res_cli["result"]["image_url"].startswith("/v1/images/files/"))

    def test_legacy_settings_migrate_stale_image_cfg_and_steps_and_cancel_job_returns_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_file = Path(tmp) / "settings.json"
            # Pre-v2 settings without settings_version must reset global image_cfg / image_steps
            cfg_file.write_text(
                json.dumps({"image_cfg": 5.0, "image_steps": 6, "image_low_vram": True}),
                encoding="utf-8",
            )
            with mock.patch.object(settings, "SETTINGS_FILE", cfg_file), \
                 mock.patch.dict(settings._cache, {}, clear=True):
                loaded = settings.get_all()
                self.assertEqual(loaded["settings_version"], 2)
                self.assertEqual(loaded["image_cfg"], 0.0)
                self.assertEqual(loaded["image_steps"], 0)
                self.assertEqual(loaded["image_low_vram"], "auto")
                persisted = json.loads(cfg_file.read_text(encoding="utf-8"))
                self.assertEqual(persisted["settings_version"], 2)
                self.assertEqual(persisted["image_cfg"], 0.0)

            # Schema v2 settings preserve explicit overrides for non-distilled models
            cfg_file.write_text(
                json.dumps({"settings_version": 2, "image_cfg": 6.0, "image_steps": 24}),
                encoding="utf-8",
            )
            with mock.patch.object(settings, "SETTINGS_FILE", cfg_file), \
                 mock.patch.dict(settings._cache, {}, clear=True):
                v2_loaded = settings.get_all()
                self.assertEqual(v2_loaded["image_cfg"], 6.0)
                self.assertEqual(v2_loaded["image_steps"], 24)

        # Verify cancel_job contract for /v1/images/jobs/{id}/cancel and zero /api/images/files URLs
        eng = img_mod.ImageEngine()
        missing = eng.cancel_job("img_nonexistent")
        self.assertFalse(missing["ok"])
        self.assertNotIn("img_nonexistent", eng._cancelled_jobs)

        eng._jobs["img_q1"] = {
            "job_id": "img_q1",
            "status": "queued",
            "stage": "queued",
            "created_at": 1,
        }
        cancelled = eng.cancel_job("img_q1")
        self.assertTrue(cancelled["ok"])
        self.assertEqual(cancelled["status"], "cancelled")

        img_engine_src = Path(img_mod.__file__).read_text(encoding="utf-8")
        self.assertNotIn("/api/images/files/", img_engine_src)
        self.assertGreaterEqual(img_engine_src.count("/v1/images/files/"), 4)

    def test_companion_overrides_external_distilled_cfg_and_malformed_settings_version(self):
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aux_dir = root / "custom_aux"
            scenes_dir = root / "scenes"
            aux_dir.mkdir()
            scenes_dir.mkdir()
            (aux_dir / "default_vae.safetensors").write_bytes(b"v1")
            (aux_dir / "preferred_vae.safetensors").write_bytes(b"v2")

            resolved = img_mod._resolve_companion_paths(
                {"family": "sdxl", "companions": {"vae": "default_vae.safetensors"}},
                aux_dir,
                {"image_vae": "preferred_vae.safetensors"},
            )
            self.assertEqual(resolved["vae"].name, "preferred_vae.safetensors")

            # Malformed settings_version string still migrates legacy image_cfg while preserving image_model
            cfg_file = root / "settings.json"
            cfg_file.write_text(
                json.dumps({"settings_version": "legacy", "image_cfg": 5.0, "image_steps": 8, "image_model": "my_scene.gguf"}),
                encoding="utf-8",
            )
            with mock.patch.object(settings, "SETTINGS_FILE", cfg_file), \
                 mock.patch.dict(settings._cache, {}, clear=True):
                migrated = settings.get_all()
                self.assertEqual(migrated["settings_version"], 2)
                self.assertEqual(migrated["image_cfg"], 0.0)
                self.assertEqual(migrated["image_steps"], 0)
                self.assertEqual(migrated["image_model"], "my_scene.gguf")

            # External A1111/Forge adapter must also clamp cfg_scale=1.0 and empty negative_prompt on Flux/Kontext
            eng = img_mod.ImageEngine()
            captured_a1111 = []
            fake_png = base64.b64encode(b"\x89PNG\r\n\x1a\nEXTPNG").decode("ascii")

            class FakeResp:
                def __init__(self, data):
                    self.status_code = 200
                    self.ok = True
                    self._data = data

                def raise_for_status(self):
                    return None

                def json(self):
                    return self._data

            def fake_post(url, json=None, timeout=None):
                captured_a1111.append(dict(json or {}))
                return FakeResp({"images": [fake_png]})

            with mock.patch.object(settings, "get_all", return_value={
                **settings.DEFAULTS,
                "image_backend": "a1111",
                "a1111_url": "http://127.0.0.1:7860",
                "image_model": "flux-kontext-dev.safetensors",
                "image_cfg": 5.0,
            }), \
                 mock.patch.object(img_mod.paths, "SCENES_DIR", scenes_dir), \
                 mock.patch("requests.post", side_effect=fake_post):
                job = eng.submit_job({"prompt": "cinematic harbor", "negative_prompt": "blurry, ugly"}, wait=True)
                self.assertEqual(job["status"], "done")
                self.assertEqual(captured_a1111[-1]["cfg_scale"], 1.0)
                self.assertEqual(captured_a1111[-1]["negative_prompt"], "")
                self.assertTrue(job["result"]["image_url"].startswith("/v1/images/files/"))

    def test_multi_family_parameters_companion_isolation_and_large_checkpoint_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            scenes_dir = root / "scenes"
            for d in (img_dir, aux_dir, lora_dir, scenes_dir):
                d.mkdir()

            # Simulate leftover Flux companions in models/image_aux/
            (aux_dir / "flux-ae.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "flux-clip_l.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
            (aux_dir / "flux-t5xxl_fp8_e4m3fn.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")

            # 1) Large SDXL / Illustrious checkpoint with >1600 UNet keys BEFORE VAE/CLIP keys must NOT truncate at 600 keys!
            many_unet_keys = [f"model.diffusion_model.input_blocks.{i}.weight" for i in range(750)] + [
                "conditioner.embedders.0.transformer.text_model.embeddings.weight",
                "first_stage_model.decoder.conv_in.weight",
                "first_stage_model.encoder.conv_in.weight",
            ]
            _write_fake_safetensors(img_dir / "waiNSFWIllustrious_v120.safetensors", many_unet_keys)
            _write_fake_safetensors(img_dir / "ponyDiffusionV6.safetensors", many_unet_keys)
            _write_fake_safetensors(img_dir / "animagine-xl-3.1.safetensors", many_unet_keys)
            _write_fake_safetensors(
                img_dir / "fluffyrock_sd15.safetensors",
                [
                    "model.diffusion_model.input_blocks.0.weight",
                    "cond_stage_model.transformer.text_model.embeddings.weight",
                    "first_stage_model.decoder.conv_in.weight",
                    "first_stage_model.encoder.conv_in.weight",
                ],
            )
            (img_dir / "chroma-unlocked-v50-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            (img_dir / "chroma-v46-flash-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            (img_dir / "illustrious-xl-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            (img_dir / "qwen-image-Q4_K_M.gguf").write_bytes(b"GGUF" + b"\x00" * 64)

            # Word-boundary guard: "Chromatic-8b-sce-GGUF" must NOT be misclassified as Chroma image family
            self.assertEqual(library.infer_image_family("Chromatic-8b-sce-GGUF.gguf")["family"], "other")

            with mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, SCENES_DIR=scenes_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(vram_gb=8)):
                eng = img_mod.ImageEngine()

                # Illustrious checkpoint: NO foreign flux-ae VAE injected, uses -m, euler_a, CFG 5.5, preserves negative_prompt
                sp_ill = eng._prepare_sdcpp_spec({
                    "model": "waiNSFWIllustrious_v120.safetensors",
                    "prompt": "anthropomorphic arctic wolf knight, silver fur, amber eyes",
                    "negative_prompt": "lowres, blurry",
                })
                self.assertEqual(sp_ill["family"], "sdxl")
                self.assertEqual(sp_ill["variant"], "illustrious")
                self.assertFalse(sp_ill["use_diffusion_flag"])
                self.assertEqual(sp_ill["companions"], {}, "Checkpoints must NOT auto-attach leftover Flux VAE")
                self.assertEqual(sp_ill["cfg_scale"], 5.5)
                self.assertEqual(sp_ill["sampler"], "euler_a")
                self.assertEqual(sp_ill["negative_prompt"], "lowres, blurry")

                # Pony checkpoint: auto-prepends score_9 tags when absent, preserves negative_prompt with score_4/5
                sp_pony = eng._prepare_sdcpp_spec({
                    "model": "ponyDiffusionV6.safetensors",
                    "prompt": "dragonborn mage casting spell",
                    "negative_prompt": "lowres, bad hands",
                })
                self.assertEqual(sp_pony["variant"], "pony")
                self.assertEqual(sp_pony["sampler"], "euler_a")
                self.assertTrue(sp_pony["clean_prompt"].startswith("score_9, score_8_up, score_7_up, "))
                self.assertIn("score_4, score_5", sp_pony["negative_prompt"])

                # Standard Chroma / Kroma: CFG 4.0, preserves negative_prompt, uses flux-ae + t5xxl without needing clip_l
                sp_chroma = eng._prepare_sdcpp_spec({
                    "model": "chroma-unlocked-v50-Q4_K_M.gguf",
                    "prompt": "cyberpunk feline mercenary in neon alley",
                    "negative_prompt": "blurry, watermark",
                })
                self.assertEqual(sp_chroma["family"], "chroma")
                self.assertTrue(sp_chroma["use_diffusion_flag"])
                self.assertEqual(sp_chroma["cfg_scale"], 4.0)
                self.assertEqual(sp_chroma["sampler"], "euler")
                self.assertEqual(sp_chroma["negative_prompt"], "blurry, watermark")
                self.assertIn("vae", sp_chroma["companions"])
                self.assertIn("t5xxl", sp_chroma["companions"])

                # Chroma-Flash variant: distilled 8-step mode -> CFG 1.0 & empty negative_prompt
                sp_cflash = eng._prepare_sdcpp_spec({
                    "model": "chroma-v46-flash-Q4_K_M.gguf",
                    "prompt": "portrait",
                    "negative_prompt": "blurry",
                })
                self.assertEqual(sp_cflash["cfg_scale"], 1.0)
                self.assertEqual(sp_cflash["negative_prompt"], "")
                self.assertEqual(sp_cflash["steps"], 8)

                # SD 1.5 checkpoint: CFG 7.0, euler_a, auto-scales 768x1024 down to 576x768 to avoid double-body artifacts
                sp_sd15 = eng._prepare_sdcpp_spec({
                    "model": "fluffyrock_sd15.safetensors",
                    "prompt": "fantasy kitsune spirit",
                    "negative_prompt": "lowres",
                    "width": 768,
                    "height": 1024,
                })
                self.assertEqual(sp_sd15["family"], "sd15")
                self.assertFalse(sp_sd15["use_diffusion_flag"])
                self.assertEqual(sp_sd15["companions"], {})
                self.assertEqual(sp_sd15["cfg_scale"], 7.0)
                self.assertEqual(sp_sd15["sampler"], "euler_a")
                self.assertEqual((sp_sd15["width"], sp_sd15["height"]), (576, 768))

                # Qwen-Image must reject Flux's ae.safetensors and report missing qwen vae + llm_encoder cleanly
                with self.assertRaisesRegex(RuntimeError, "missing required companion"):
                    eng._prepare_sdcpp_spec({"model": "qwen-image-Q4_K_M.gguf", "prompt": "scene"})

                # Standalone SDXL GGUF requires sdxl_vae + clip_l + clip_g (rejecting flux-ae)
                self.assertEqual(store.companion_key_for_model("sdxl", "illustrious-xl-Q4_K_M.gguf", False), "sdxl_gguf")
                self.assertEqual(store.companion_key_for_model("sdxl", "illustriousXL.safetensors", False), "")
                (aux_dir / "sdxl_vae.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
                (aux_dir / "sdxl-clip_g.safetensors").write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")
                sp_sdxl_gguf = eng._prepare_sdcpp_spec({
                    "model": "illustrious-xl-Q4_K_M.gguf",
                    "prompt": "anime elf archer",
                })
                self.assertTrue(sp_sdxl_gguf["use_diffusion_flag"])
                self.assertEqual(sp_sdxl_gguf["companions"]["vae"].name, "sdxl_vae.safetensors")
                self.assertEqual(sp_sdxl_gguf["companions"]["clip_l"].name, "flux-clip_l.safetensors")
                self.assertEqual(sp_sdxl_gguf["companions"]["clip_g"].name, "sdxl-clip_g.safetensors")

    def test_lora_header_inspection_uppercase_peft_keys_and_specialized_trainer_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            ds_root = root / "datasets"
            for d in (img_dir, aux_dir, lora_dir, ds_root):
                d.mkdir()

            # 1) Uppercase PEFT/Diffusers .lora_A.weight / .lora_B.weight keys must classify as weight_role='lora'
            flux_peft_lora = lora_dir / "custom_style.safetensors"
            _write_fake_safetensors(
                flux_peft_lora,
                [
                    "diffusion_model.double_blocks.0.img_attn.proj.lora_A.weight",
                    "diffusion_model.double_blocks.0.img_attn.proj.lora_B.weight",
                    "diffusion_model.single_blocks.0.linear1.lora_A.weight",
                ],
            )
            self.assertEqual(library.inspect_safetensors_header(flux_peft_lora)["weight_role"], "lora")
            self.assertEqual(library.inspect_lora_header(flux_peft_lora)["base_arch"], "flux")

            # 2) Kohya metadata + te1/te2 keys detect sdxl & trigger phrase automatically
            sdxl_lora = lora_dir / "wolf_char.safetensors"
            hdr_obj = {
                "__metadata__": {
                    "ss_base_model_version": "sdxl_base_v1-0",
                    "modelspec.trigger_phrase": "slx_fenrir",
                },
                "lora_te1_text_model_encoder_layers_0_self_attn_q_proj.lora_down.weight": {
                    "dtype": "F16",
                    "shape": [1],
                    "data_offsets": [0, 2],
                },
            }
            raw_hdr = json.dumps(hdr_obj).encode("utf-8")
            sdxl_lora.write_bytes(len(raw_hdr).to_bytes(8, "little") + raw_hdr + b"\x00\x00")
            inspected = library.inspect_lora_header(sdxl_lora)
            self.assertEqual(inspected["base_arch"], "sdxl")
            self.assertEqual(inspected["trigger_word"], "slx_fenrir")

            # 3) Kohya key conversion preserves `.lora_down.weight` / `.lora_up.weight` dots
            converted = lora_trainer._convert_peft_unet_to_kohya_keys({
                "down_blocks.0.attentions.0.transformer_blocks.0.attn1.to_q.lora_A.weight": "T_A",
                "down_blocks.0.attentions.0.transformer_blocks.0.attn1.to_q.lora_B.weight": "T_B",
            })
            self.assertIn(
                "lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn1_to_q.lora_down.weight",
                converted,
            )
            self.assertIn(
                "lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn1_to_q.lora_up.weight",
                converted,
            )

            # 4) Specialized SDXL checkpoints without "xl" in filename (Illustrious / Pony) detect as sdxl & active model wins
            _write_fake_safetensors(
                img_dir / "a_dreamshaper_sd15.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "cond_stage_model.transformer.weight"],
            )
            _write_fake_safetensors(
                img_dir / "waiNSFWIllustrious_v120.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )
            self.assertEqual(lora_trainer._detect_training_arch(str(img_dir / "waiNSFWIllustrious_v120.safetensors")), "sdxl")
            self.assertEqual(lora_trainer._detect_training_arch("ponyDiffusionV6.safetensors"), "sdxl")

            trainer = lora_trainer.LoraTrainer()
            captured_cfg = {}

            def fake_worker(py_exe, job_cfg):
                captured_cfg.update(job_cfg)

            import base64
            import struct
            import zlib

            def _make_valid_png_b64(w: int = 16, h: int = 16) -> str:
                raw_rows = b"".join(
                    b"\x00" + b"".join(bytes(((x * 17 + y * 31) & 0xFF, (x * 9) & 0xFF, (y * 13) & 0xFF)) for x in range(w))
                    for y in range(h)
                )
                # Ensure compressed payload exceeds 128 bytes cleanly using store/uncompressed level 0
                compressed = zlib.compress(raw_rows, level=0)
                def _chunk(tag: bytes, data: bytes) -> bytes:
                    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
                ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
                png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", compressed) + _chunk(b"IEND", b"")
                return "data:image/png;base64," + base64.b64encode(png).decode("ascii")

            sample_img = _make_valid_png_b64()
            with mock.patch.multiple(lora_trainer.paths, IMAGE_MODELS_DIR=img_dir, LORAS_DIR=lora_dir, LORA_DATASETS_DIR=ds_root), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "waiNSFWIllustrious_v120.safetensors"}), \
                 mock.patch.object(lora_trainer, "_has_trainer_packages", return_value=True), \
                 mock.patch.object(trainer, "_run_worker", side_effect=fake_worker):
                job = trainer.start_training({
                    "character_name": "Fenrir",
                    "trigger_word": "slx_fenrir",
                    "images": [{"dataUrl": sample_img, "caption": "anthropomorphic silver wolf"}],
                })
                time.sleep(0.05)
                self.assertEqual(job["base_arch"], "sdxl")
                self.assertTrue(captured_cfg["base_model"].endswith("waiNSFWIllustrious_v120.safetensors"))
                self.assertEqual(captured_cfg["resolution"], 1024)
                st = trainer.status()
                self.assertIn("stage", st["job"])
                self.assertIn("elapsed_sec", st["job"])

    def test_lora_cross_family_compatibility_skip_and_progress_telemetry(self):
        # 1) Family compatibility matrix
        self.assertTrue(library.is_lora_compatible_with_family("sdxl", "sdxl"))
        self.assertTrue(library.is_lora_compatible_with_family("illustrious", "sdxl"))
        self.assertTrue(library.is_lora_compatible_with_family("pony", "illustrious"))
        self.assertFalse(library.is_lora_compatible_with_family("sdxl", "flux_kontext"))
        self.assertFalse(library.is_lora_compatible_with_family("chroma", "flux_kontext"))
        self.assertTrue(library.is_lora_compatible_with_family("chroma", "chroma"))
        self.assertTrue(library.is_lora_compatible_with_family("flux", "flux_kontext"))
        self.assertFalse(library.is_lora_compatible_with_family("sd15", "sdxl"))
        self.assertTrue(library.is_lora_compatible_with_family("sd15", "sd15"))

        # 2) Standalone SD 1.5 GGUF companion resolution
        self.assertEqual(store.companion_key_for_model("sd15", "dreamshaper-8-Q8_0.gguf", False), "sd15_gguf")
        self.assertEqual(store.companion_key_for_model("sd15", "dreamshaper_8.safetensors", False), "")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            gen_dir = root / "generated"
            for d in (img_dir, aux_dir, lora_dir, gen_dir):
                d.mkdir()

            (img_dir / "flux-kontext-Q4_K_M.gguf").write_bytes(b"GGUF\x03\x00\x00\x00" + b"\x00" * 64)
            (img_dir / "chroma-unlocked-Q4_K_M.gguf").write_bytes(b"GGUF\x03\x00\x00\x00" + b"\x00" * 64)
            _write_fake_safetensors(
                img_dir / "illustrious_v12.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )
            for aux_name in ("flux-ae.safetensors", "flux-clip_l.safetensors", "flux-t5xxl-Q4_K_M.gguf"):
                (aux_dir / aux_name).write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")

            # Large (>5 MB JSON header) Chroma LoRA in loras/
            big_keys = {
                f"diffusion_model.distilled_guidance_layer.layers.{i % 8}.lora_up.weight_{i}": {
                    "dtype": "F16",
                    "shape": [768, 768],
                    "data_offsets": [0, 2],
                }
                for i in range(42000)
            }
            raw_big = json.dumps(big_keys).encode("utf-8")
            self.assertGreater(len(raw_big), 4 * 1024 * 1024)
            chroma_lora = lora_dir / "anthro_style_r768.safetensors"
            chroma_lora.write_bytes(len(raw_big).to_bytes(8, "little") + raw_big + b"\x00\x00")
            self.assertEqual(library.inspect_lora_header(chroma_lora)["base_arch"], "chroma")

            # Misplaced full base checkpoint inside loras/
            misplaced_ckpt = lora_dir / "full_sdxl_base.safetensors"
            _write_fake_safetensors(
                misplaced_ckpt,
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )

            with mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(library, "set_meta"), \
                 mock.patch.object(library, "drop_meta"), \
                 mock.patch.multiple(img_mod.paths, SCENES_DIR=gen_dir, LORAS_DIR=lora_dir, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "flux-kontext-Q4_K_M.gguf"}), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(8.0, 16.0)):
                lib_scan = library.scan_image_library(active_model="flux-kontext-Q4_K_M.gguf")
                lora_by_name = {item["filename"]: item for item in lib_scan["loras"]}
                self.assertFalse(lora_by_name["anthro_style_r768.safetensors"]["compatible_with_active"])
                self.assertTrue(lora_by_name["full_sdxl_base.safetensors"]["is_full_model"])

                eng = img_mod.ImageEngine()
                # Incompatible Chroma LoRA + misplaced checkpoint are skipped cleanly when Flux Kontext is active
                spec_flux = eng._prepare_sdcpp_spec({
                    "model": "flux-kontext-Q4_K_M.gguf",
                    "prompt": "silver elf ranger in misty forest",
                    "loras": [
                        {"filename": "anthro_style_r768.safetensors", "strength": 0.8},
                        {"filename": "full_sdxl_base.safetensors", "strength": 0.7},
                    ],
                })
                self.assertEqual(spec_flux["resolved_loras"], [])
                self.assertEqual(len(spec_flux["skipped_loras"]), 2)
                self.assertNotIn("<lora:", spec_flux["clean_prompt"])

                # Switching to Chroma keeps the Chroma LoRA active
                spec_chroma = eng._prepare_sdcpp_spec({
                    "model": "chroma-unlocked-Q4_K_M.gguf",
                    "prompt": "anthropomorphic wolf alchemist",
                    "loras": [{"filename": "anthro_style_r768.safetensors", "strength": 0.85}],
                })
                self.assertEqual(spec_chroma["skipped_loras"], [])
                self.assertEqual(len(spec_chroma["resolved_loras"]), 1)
                self.assertEqual(spec_chroma["resolved_loras"][0]["filename"], "anthro_style_r768.safetensors")
                self.assertAlmostEqual(spec_chroma["resolved_loras"][0]["weight"], 0.85)

                # Illustrious positive quality tags added automatically without mutating negative_prompt;
                # without heavy LoRAs or refs on 8 GB GPU, SDXL keeps VAE on GPU (`needs_vae_on_cpu=False`)
                spec_ill = eng._prepare_sdcpp_spec({
                    "model": "illustrious_v12.safetensors",
                    "prompt": "tiefling bard playing lute",
                    "negative_prompt": "lowres, bad anatomy",
                })
                self.assertTrue(spec_ill["clean_prompt"].startswith("masterpiece, best quality, newest, "))
                self.assertEqual(spec_ill["negative_prompt"], "lowres, bad anatomy")
                self.assertFalse(spec_ill["needs_vae_on_cpu"])

                # A >=1 GiB high-rank SDXL LoRA on an 8 GB GPU enables `needs_vae_on_cpu=True` + `needs_cpu_offload=True`
                heavy_sdxl_lora = lora_dir / "sdxl_highrank_char.safetensors"
                _write_fake_safetensors(
                    heavy_sdxl_lora,
                    ["lora_te1_text_model_encoder_layers_0.lora_down.weight"],
                )
                import os as _os
                orig_stat = Path.stat

                def fake_stat(p: Path, *args, **kwargs):
                    st_res = orig_stat(p, *args, **kwargs)
                    if p.name == "sdxl_highrank_char.safetensors":
                        return _os.stat_result((
                            st_res.st_mode, st_res.st_ino, st_res.st_dev, st_res.st_nlink,
                            st_res.st_uid, st_res.st_gid, 2 * 1024**3,
                            st_res.st_atime, st_res.st_mtime, st_res.st_ctime,
                        ))
                    return st_res

                with mock.patch.object(Path, "stat", fake_stat):
                    spec_ill_heavy = eng._prepare_sdcpp_spec({
                        "model": "illustrious_v12.safetensors",
                        "prompt": "tiefling bard playing lute",
                        "loras": [{"filename": "sdxl_highrank_char.safetensors", "strength": 0.8}],
                    })
                self.assertTrue(spec_ill_heavy["needs_cpu_offload"])
                self.assertTrue(spec_ill_heavy["needs_vae_on_cpu"])

                # Relocate misplaced full model from loras/ back to image/
                moved_res = library.move_lora_to_image("full_sdxl_base.safetensors")
                self.assertTrue(moved_res["ok"])
                self.assertTrue((img_dir / "full_sdxl_base.safetensors").exists())
                self.assertFalse((lora_dir / "full_sdxl_base.safetensors").exists())

                # Live active_job summary in engine_status()
                job_dict = {
                    "job_id": "img_testlive01",
                    "status": "generating",
                    "stage": "sampling",
                    "progress": 55,
                    "step": 11,
                    "total_steps": 20,
                    "model": "chroma-unlocked-Q4_K_M.gguf",
                    "started_at": int(time.time()) - 3,
                }
                eng._active_job_id = "img_testlive01"
                eng._jobs["img_testlive01"] = job_dict
                st_live = eng.engine_status()
                self.assertIsNotNone(st_live["active_job"])
                self.assertEqual(st_live["active_job"]["progress"], 55)
                self.assertEqual(st_live["active_job"]["step"], 11)
                self.assertGreaterEqual(st_live["active_job"]["elapsed_sec"], 2)

    def test_checkpoint_companion_isolation_chroma_flags_ckpt_training_and_diffusers_shard_filter(self):
        # 1) Full-size SDXL GGUF checkpoint (>= 3.3 GiB) needs zero external companions, while small UNet GGUF uses SDXL base CLIP
        self.assertEqual(
            store.companion_key_for_model("sdxl", "illustrious-xl-v2.0-Q8_0.gguf", False, size_bytes=int(4.18 * 1024**3)),
            "",
        )
        self.assertEqual(
            store.companion_key_for_model("sdxl", "sdxl-unet-only-Q4_K_S.gguf", False, size_bytes=int(1.6 * 1024**3)),
            "sdxl_gguf",
        )
        sdxl_comp_urls = [c["url"] for c in store._DEFAULT_COMPANIONS["sdxl_gguf"]]
        self.assertTrue(any("stable-diffusion-xl-base-1.0" in u for u in sdxl_comp_urls))
        self.assertFalse(any("stable-diffusion-3.5" in u for u in sdxl_comp_urls))

        # 2) All-in-one checkpoint ignores stale foreign companions in models_meta.json
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            for d in (img_dir, aux_dir, lora_dir):
                d.mkdir()
            for aux_name in ("sdxl_vae.safetensors", "flux-clip_l.safetensors", "sdxl-clip_g.safetensors", "flux-ae.safetensors", "flux-t5xxl_fp8_e4m3fn.safetensors"):
                (aux_dir / aux_name).write_bytes(b"\x08\x00\x00\x00\x00\x00\x00\x00{}")

            # Simulate GGUF checkpoint header containing embeddeddiffusion + conditioner + first_stage_model tensors
            gguf_ckpt = img_dir / "illustrious-xl-v2.0-Q8_0.gguf"
            gguf_ckpt.write_bytes(
                b"GGUF\x03\x00\x00\x00"
                b" model.diffusion_model.input_blocks.0.0.weight "
                b" conditioner.embedders.0.transformer.text_model.embeddings.weight "
                b" first_stage_model.decoder.conv_in.weight "
            )
            chroma_gguf = img_dir / "chroma-unlocked-v29.5-Q4_K_M.gguf"
            chroma_gguf.write_bytes(b"GGUF\x03\x00\x00\x00" + b"\x00" * 64)

            # Simulate legacy PyTorch .ckpt zip archive (furrydiffusion.ckpt)
            import zipfile
            ckpt_file = img_dir / "furrydiffusion.ckpt"
            with zipfile.ZipFile(ckpt_file, "w") as zf:
                zf.writestr(
                    "archive/data.pkl",
                    b"model.diffusion_model.input_blocks.11.0.weight cond_stage_model.transformer.text_model.embeddings.weight first_stage_model.decoder.conv_in.weight",
                )

            stale_meta = {
                "image/illustrious-xl-v2.0-Q8_0.gguf": {
                    "repo": "off-grid-ai/illustrious-xl-v2.0-GGUF",
                    "needs_companions": True,
                    "companions": {
                        "vae": "sdxl_vae.safetensors",
                        "clip_l": "flux-clip_l.safetensors",
                        "clip_g": "sdxl-clip_g.safetensors",
                    },
                }
            }
            with mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", side_effect=lambda k: dict(stale_meta.get(k, {}))), \
                 mock.patch.multiple(img_mod.paths, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(settings, "get_all", return_value=dict(settings.DEFAULTS)), \
                 mock.patch.object(img_mod.hardware, "analyze_hardware", return_value=make_hw(8.0, 16.0)):
                lib_scan = library.scan_image_library()
                by_name = {m["filename"]: m for m in lib_scan["models"]}

                ill_entry = by_name["illustrious-xl-v2.0-Q8_0.gguf"]
                self.assertEqual(ill_entry["weight_role"], "checkpoint")
                self.assertFalse(ill_entry["needs_companions"])
                self.assertEqual(ill_entry["companions"], {})
                self.assertFalse(ill_entry["trainable_lora"])

                furry_entry = by_name["furrydiffusion.ckpt"]
                self.assertEqual(furry_entry["family"], "sd15")
                self.assertEqual(furry_entry["weight_role"], "checkpoint")
                self.assertTrue(furry_entry["trainable_lora"])
                self.assertEqual(lora_trainer._detect_training_arch(str(ckpt_file)), "sd15")

                eng = img_mod.ImageEngine()
                spec_ill = eng._prepare_sdcpp_spec({
                    "model": "illustrious-xl-v2.0-Q8_0.gguf",
                    "prompt": "1girl, silver hair",
                })
                self.assertEqual(spec_ill["companions"], {})
                self.assertFalse(spec_ill["use_diffusion_flag"])
                self.assertIn("bad anatomy", spec_ill["negative_prompt"])

                spec_chroma = eng._prepare_sdcpp_spec({
                    "model": "chroma-unlocked-v29.5-Q4_K_M.gguf",
                    "prompt": "anthro fox mage",
                })
                self.assertEqual(spec_chroma["guidance"], 0.0)
                self.assertEqual(spec_chroma["cfg_scale"], 4.0)
                self.assertIn("bad anatomy", spec_chroma["negative_prompt"])

        # 3) Diffusers multi-folder shards excluded from repo_files, while Pony XL 6.94 GB .safetensors with 'lora' tag stays 'image'
        fake_tree = [
            {"type": "file", "path": "unet/diffusion_pytorch_model.safetensors", "size": 5_135_149_760},
            {"type": "file", "path": "text_encoder/model.safetensors", "size": 246_144_152},
            {"type": "file", "path": "vae/diffusion_pytorch_model.safetensors", "size": 167_335_342},
        ]
        with store._cache_lock:
            store._cache.clear()
        with mock.patch.object(store, "_get_json", return_value=fake_tree):
            self.assertEqual(store.repo_files("John6666/nova-furry-xl-il-v120-sdxl", include_safetensors=True), [])

        self.assertFalse(
            store._is_non_base_image_repo({
                "repo_id": "LyliaEngine/Pony_Diffusion_V6_XL",
                "tags": ["diffusers", "text-to-image", "lora"],
            })
        )
        self.assertEqual(
            store._file_role(
                {"filename": "ponyDiffusionV6XL_v6StartWithThisOne.safetensors", "size_bytes": 6_938_041_050, "is_projector": False, "aux_role": None},
                ["diffusers", "text-to-image", "lora"],
                True,
            ),
            "image",
        )

    def test_aux_family_isolation_cuda_trainer_repair_and_smart_auto_ckpt_priority(self):
        # 1) SDXL/NoobAI/Indigo VAEs and CLIP-L never falsely satisfy Chroma / Flux Kontext requirements
        self.assertTrue(library.is_aux_compatible_with_family("indigoFurryMixXL_noobaiEPS6_VAE.safetensors", "vae", "sdxl"))
        self.assertFalse(library.is_aux_compatible_with_family("indigoFurryMixXL_noobaiEPS6_VAE.safetensors", "vae", "chroma"))
        self.assertFalse(library.is_aux_compatible_with_family("indigoFurryMixXL_noobaiEPS6_VAE.safetensors", "vae", "flux_kontext"))
        self.assertFalse(library.is_aux_compatible_with_family("indigoFurryMixXL_noobaiEPS6_clip_l.safetensors", "clip_l", "flux_kontext"))
        self.assertTrue(library.is_aux_compatible_with_family("flux-ae.safetensors", "vae", "chroma"))
        self.assertTrue(library.is_aux_compatible_with_family("flux-ae.safetensors", "vae", "flux_kontext"))
        self.assertFalse(library.is_aux_compatible_with_family("flux-ae.safetensors", "vae", "sdxl"))

        # 2) ensure_trainer_sync repairs CPU-only torch when an NVIDIA CUDA GPU is present
        trainer = lora_trainer.LoraTrainer()
        fake_py = Path("/tmp/fake_venv_trainer/python")
        with mock.patch.object(lora_trainer, "_trainer_python", return_value=fake_py), \
             mock.patch.object(lora_trainer.hardware, "analyze_hardware", return_value=make_hw(8.0, 16.0)), \
             mock.patch.object(lora_trainer, "_has_trainer_packages", return_value=True), \
             mock.patch.object(lora_trainer, "_trainer_has_cuda", return_value=False), \
             mock.patch.object(lora_trainer, "_install_cuda_torch", return_value=True) as mock_cuda_fix:
            res = trainer.ensure_trainer_sync(force=False)
            self.assertTrue(res["ok"])
            mock_cuda_fix.assert_called_once()

        # 3) Smart Auto checkpoint selection prefers SDXL .safetensors over alphabetical SD1.5 .ckpt
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            ds_root = root / "datasets"
            for d in (img_dir, aux_dir, lora_dir, ds_root):
                d.mkdir()

            import base64, struct, zipfile, zlib
            with zipfile.ZipFile(img_dir / "furrydiffusion.ckpt", "w") as zf:
                zf.writestr("archive/data.pkl", b"model.diffusion_model.input_blocks.11.0.weight cond_stage_model.weight")
            _write_fake_safetensors(
                img_dir / "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
                ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"],
            )
            (img_dir / "chroma-unlocked-v29.5-Q4_K_M.gguf").write_bytes(b"GGUF\x03\x00\x00\x00" + b"\x00" * 64)

            raw_rows = b"".join(b"\x00" + b"\x7f\x40\x20" * 16 for _ in range(16))
            compressed = zlib.compress(raw_rows, level=0)
            def _chunk(tag: bytes, data: bytes) -> bytes:
                return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            png = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 2, 0, 0, 0)) + _chunk(b"IDAT", compressed) + _chunk(b"IEND", b"")
            sample_img = "data:image/png;base64," + base64.b64encode(png).decode("ascii")

            captured: Dict[str, Any] = {}
            def _fake_worker(_py, cfg):
                captured.update(cfg)

            with mock.patch.multiple(lora_trainer.paths, IMAGE_MODELS_DIR=img_dir, LORAS_DIR=lora_dir, LORA_DATASETS_DIR=ds_root), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.object(library, "get_meta", return_value={}), \
                 mock.patch.object(settings, "get_all", return_value={**settings.DEFAULTS, "image_model": "chroma-unlocked-v29.5-Q4_K_M.gguf"}), \
                 mock.patch.object(lora_trainer.hardware, "analyze_hardware", return_value=make_hw(8.0, 16.0)), \
                 mock.patch.object(lora_trainer, "_has_trainer_packages", return_value=True), \
                 mock.patch.object(trainer, "_run_worker", side_effect=_fake_worker):
                job = trainer.start_training({
                    "character_name": "Kiko",
                    "trigger_word": "slx_kiko",
                    "images": [{"dataUrl": sample_img}],
                })
                time.sleep(0.05)
                self.assertEqual(job["base_arch"], "sdxl")
                self.assertTrue(captured["base_model"].endswith("ponyDiffusionV6XL_v6StartWithThisOne.safetensors"))
                self.assertEqual(captured["resolution"], 768)
                self.assertTrue(captured["require_cuda"])


if __name__ == "__main__":
    unittest.main()





