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


if __name__ == "__main__":
    unittest.main()
