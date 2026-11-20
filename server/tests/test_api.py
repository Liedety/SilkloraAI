import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from hub import api  # noqa: E402
from hub.engine import engine  # noqa: E402


class VisionGuardTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(api.create_app())
        self._llama, self._projector = engine.llama, engine.projector_name
        engine.llama = object()
        engine.projector_name = ""

    def tearDown(self):
        engine.llama, engine.projector_name = self._llama, self._projector

    def test_image_without_vision_model_is_rejected_with_clear_error(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "text", "text": "what is this?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ]}]}
        res = self.client.post("/v1/chat/completions", json=body)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"]["code"], "vision_unavailable")

    def test_text_only_request_is_not_affected(self):
        engine.llama = None
        res = self.client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 503)

    def test_dashboard_and_status_respond_quickly_without_hanging(self):
        import time

        # Remote hosts must be denied dashboard/management access (security check)
        self.assertEqual(self.client.get("/").status_code, 403)

        local_client = TestClient(api.create_app(), client=("127.0.0.1", 50000))
        html = local_client.get("/")
        self.assertEqual(html.status_code, 200)
        self.assertIn("SilkloraAI Hub", html.text)
        self.assertIn("navAssistant", html.text)

        t0 = time.monotonic()
        st = local_client.get("/api/status")
        elapsed = time.monotonic() - t0
        self.assertEqual(st.status_code, 200)
        data = st.json()
        self.assertEqual(data["version"], "2.1.0")
        self.assertIn("engine", data)
        self.assertIn("model", data)
        self.assertIn("image_engine", data)
        self.assertIn("settings", data)
        self.assertLess(elapsed, 1.0)

        lib = local_client.get("/api/images/models")
        self.assertEqual(lib.status_code, 200)
        self.assertIn("models", lib.json())

        static_js = local_client.get("/static/app.js")
        self.assertEqual(static_js.status_code, 200)
        self.assertEqual(static_js.headers.get("cache-control"), "no-store")

    def test_select_rejects_lora_and_move_lora_relocates_file(self):
        import json
        import tempfile
        from unittest import mock
        from hub import library, settings

        def _fake_safetensors(p: Path, keys: list[str]) -> None:
            raw = json.dumps({k: {"dtype": "F16", "shape": [1], "data_offsets": [0, 2]} for k in keys}).encode("utf-8")
            p.write_bytes(len(raw).to_bytes(8, "little") + raw + b"\x00\x00")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            img_dir = root / "image"
            aux_dir = root / "image_aux"
            lora_dir = root / "loras"
            meta_file = root / "models_meta.json"
            settings_file = root / "settings.json"
            for d in (img_dir, aux_dir, lora_dir):
                d.mkdir()
            _fake_safetensors(img_dir / "bad_lora.safetensors", ["lora_unet_down_blocks.lora_down.weight"])
            _fake_safetensors(img_dir / "base_sdxl.safetensors", ["model.diffusion_model.input_blocks.0.weight", "conditioner.embedders.0.weight"])

            with mock.patch.multiple(api, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir), \
                 mock.patch.multiple(library, IMAGE_MODELS_DIR=img_dir, IMAGE_AUX_DIR=aux_dir, LORAS_DIR=lora_dir, META_FILE=meta_file), \
                 mock.patch.multiple(settings, SETTINGS_FILE=settings_file, _cache={"image_model": "bad_lora.safetensors"}):
                local_client = TestClient(api.create_app(), client=("127.0.0.1", 50000))
                bad = local_client.post("/api/images/select", json={"model": "bad_lora.safetensors"})
                self.assertEqual(bad.status_code, 400)
                self.assertIn("lora", bad.json()["detail"].lower())

                moved = local_client.post("/api/images/move-lora", json={"filename": "bad_lora.safetensors"})
                self.assertEqual(moved.status_code, 200)
                self.assertTrue((lora_dir / "bad_lora.safetensors").is_file())
                self.assertEqual(moved.json()["active_image_model"], "base_sdxl.safetensors")

                ok = local_client.post("/api/images/select", json={"model": "base_sdxl.safetensors"})
                self.assertEqual(ok.status_code, 200)
                self.assertEqual(ok.json()["image_model"], "base_sdxl.safetensors")

    def test_lan_client_can_fetch_v1_scene_files_and_cancel_jobs(self):
        import tempfile
        from unittest import mock
        from hub.image_engine import image_engine

        with tempfile.TemporaryDirectory() as tmp:
            scenes_dir = Path(tmp)
            (scenes_dir / "img_demo123.png").write_bytes(b"\x89PNG\r\n\x1a\nDEMO")
            with mock.patch.object(api, "SCENES_DIR", scenes_dir):
                lan_client = TestClient(api.create_app(), client=("192.168.0.55", 50000))
                self.assertEqual(lan_client.get("/api/images/files/img_demo123.png").status_code, 403)
                v1_res = lan_client.get("/v1/images/files/img_demo123.png")
                self.assertEqual(v1_res.status_code, 200)
                self.assertEqual(v1_res.headers.get("content-type"), "image/png")

                self.assertEqual(lan_client.post("/v1/images/jobs/img_missing/cancel").status_code, 404)
                image_engine._jobs["img_lan_q"] = {
                    "job_id": "img_lan_q",
                    "status": "queued",
                    "stage": "queued",
                    "created_at": 1,
                }
                try:
                    c_res = lan_client.post("/v1/images/jobs/img_lan_q/cancel")
                    self.assertEqual(c_res.status_code, 200)
                    self.assertTrue(c_res.json()["ok"])
                finally:
                    image_engine._jobs.pop("img_lan_q", None)


if __name__ == "__main__":
    unittest.main()
