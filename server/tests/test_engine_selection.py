import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bootstrap  # noqa: E402
from hub.engine import is_illegal_instruction  # noqa: E402

PY = f"cp{sys.version_info.major}{sys.version_info.minor}"


def wheel(version, cuda, arch, py=None):
    py = py or PY
    name = f"llama_cpp_python-{version}+cuda{cuda}.{arch}-{py}-{'none' if py == 'py3' else py}-win_amd64.whl"
    return {"name": name, "browser_download_url": f"https://example.invalid/{name}"}


RELEASES = [
    {"assets": [
        wheel("0.3.20", "13.0", "sm89.ada", "py3"),
        wheel("0.3.20", "13.0", "sm86.ampere", "py3"),
        wheel("0.3.20", "13.0", "sm75.turing", "py3"),
        wheel("0.3.20", "13.0", "sm100.sm120.blackwell", "py3"),
        wheel("0.3.20", "12.1", "sm86.ampere", "py3"),
    ]},
    {"assets": [
        wheel("0.3.16", "13.0", "sm89.ada"),
        wheel("0.3.16", "12.1", "sm89.ada"),
        wheel("0.3.16", "12.1", "sm75.turing"),
    ]},
]


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self._orig = bootstrap.fetch_json
        bootstrap.fetch_json = lambda url: RELEASES if "page=1" in url else []

    def tearDown(self):
        bootstrap.fetch_json = self._orig

    @staticmethod
    def gpu(name, cap, driver):
        return {"name": name, "compute_cap": cap, "driver": driver}

    def test_newest_cuda13_first_for_ada_with_new_driver(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("RTX 4060 Ti", "8.9", "581.15"))
        self.assertEqual(cands[0]["version"], "0.3.20")
        self.assertEqual(cands[0]["cuda"], "13.0")

    def test_cuda13_skipped_on_old_driver(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("RTX 4060 Ti", "8.9", "560.70"))
        self.assertTrue(cands)
        self.assertTrue(all(c["cuda"] == "12.1" for c in cands))

    def test_ada_card_never_gets_ampere_only_build_as_first_choice(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("RTX 4060 Ti", "8.9", "581.15"))
        self.assertNotIn("sm86", cands[0]["url"])

    def test_blackwell_only_gets_cuda13_builds(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("RTX 5070", "12.0", "581.15"))
        self.assertTrue(cands)
        self.assertTrue(all(c["cuda"] == "13.0" for c in cands))

    def test_turing_card_gets_sm75_build(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("GTX 1660", "7.5", "581.15"))
        self.assertTrue(any("sm75" in c["url"] for c in cands))

    def test_candidate_list_is_bounded(self):
        cands = bootstrap.windows_cuda_candidates(self.gpu("RTX 4060 Ti", "8.9", "581.15"))
        self.assertLessEqual(len(cands), bootstrap.MAX_GPU_CANDIDATES)

    def test_no_compute_capability_means_no_gpu_candidates(self):
        self.assertEqual(bootstrap.windows_cuda_candidates({"name": "x", "compute_cap": "", "driver": "581"}), [])


class CrashDetectionTests(unittest.TestCase):
    def test_winerror_text_is_recognized(self):
        self.assertTrue(is_illegal_instruction("[WinError -1073741795] Windows Error 0xc000001d"))

    def test_unrelated_error_is_not_a_crash(self):
        self.assertFalse(is_illegal_instruction("failed to load model: invalid magic"))

    def test_exit_code_constants(self):
        self.assertIn(-1073741795, bootstrap.CRASH_CODES)
        self.assertIn(3221225501, bootstrap.CRASH_CODES)


if __name__ == "__main__":
    unittest.main()
