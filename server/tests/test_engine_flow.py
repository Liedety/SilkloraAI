import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bootstrap  # noqa: E402

GPU = {"name": "RTX 4060 Ti", "compute_cap": "8.9", "driver": "581.15"}
CRASH = "illegal instruction (0xC000001D): this build needs a processor feature this CPU does not have"


def cand(version, cuda):
    return {"url": f"https://example.invalid/{version}-{cuda}.whl", "version": version, "cuda": cuda, "sort": ()}


class EngineFlowTests(unittest.TestCase):
    def run_flow(self, state, probes, selftests, candidates, cpu_ok=True):
        """probes: list of probe dicts returned in order; selftests: list of (ok, reason) in call order."""
        probe_seq = list(probes)
        test_seq = list(selftests)
        calls = {"install": [], "cpu": 0, "tests": []}

        def fake_probe():
            return probe_seq.pop(0) if len(probe_seq) > 1 else probe_seq[0]

        def fake_test(use_gpu):
            calls["tests"].append(use_gpu)
            return test_seq.pop(0) if len(test_seq) > 1 else test_seq[0]

        def fake_install(c):
            calls["install"].append(c["version"] + "-" + c["cuda"])
            return True

        def fake_cpu():
            calls["cpu"] += 1
            return cpu_ok

        with mock.patch.object(bootstrap, "nvidia_info", return_value=GPU), \
             mock.patch.object(bootstrap, "probe_engine", side_effect=fake_probe), \
             mock.patch.object(bootstrap, "engine_selftest", side_effect=fake_test), \
             mock.patch.object(bootstrap, "windows_cuda_candidates", return_value=candidates), \
             mock.patch.object(bootstrap, "install_windows_candidate", side_effect=fake_install), \
             mock.patch.object(bootstrap, "install_cpu_engine", side_effect=fake_cpu), \
             mock.patch.object(bootstrap.platform, "system", return_value="Windows"), \
             mock.patch.object(bootstrap, "say", lambda *a, **k: None):
            result = bootstrap.ensure_engine(state, repair=False)
        return result, calls, state

    def test_crashing_engine_is_replaced_by_working_candidate(self):
        # The installed engine (0.3.16) is checked first; it crashes, then the candidates are tried.
        state = {}
        probes = [
            {"ok": True, "version": "0.3.16", "gpu": True},   # installed engine
            {"ok": True, "version": "0.3.16", "gpu": True},   # after installing candidate 1
            {"ok": True, "version": "0.3.20", "gpu": True},   # after installing candidate 2
        ]
        result, calls, state = self.run_flow(
            state,
            probes=probes,
            selftests=[(False, CRASH), (False, CRASH), (True, "ok")],
            candidates=[cand("0.3.16", "12.1"), cand("0.3.20", "13.0")],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["version"], "0.3.20")
        self.assertEqual(calls["install"], ["0.3.16-12.1", "0.3.20-13.0"])
        self.assertEqual(calls["cpu"], 0)
        self.assertTrue(state["engine_verified"]["source"].startswith("cuda-13.0"))
        self.assertTrue(state["engine_verified"]["gpu_mode"])

    def test_falls_back_to_cpu_when_all_gpu_builds_fail(self):
        crash_probe = {"ok": True, "version": "0.3.16", "gpu": True}
        cpu_probe = {"ok": True, "version": "0.3.36", "gpu": False}
        probes = [crash_probe, crash_probe, cpu_probe]
        result, calls, state = self.run_flow(
            {},
            probes=probes,
            selftests=[(False, CRASH), (False, CRASH), (True, "ok")],
            candidates=[cand("0.3.16", "12.1")],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(calls["cpu"], 1)
        self.assertEqual(state["engine_verified"]["source"], "cpu")
        self.assertFalse(state["engine_verified"]["gpu_mode"])

    def test_cpu_engine_is_not_accepted_when_gpu_exists(self):
        cpu_probe = {"ok": True, "version": "0.3.36", "gpu": False}
        ok_probe = {"ok": True, "version": "0.3.20", "gpu": True}
        state = {"engine_verified": {"version": "0.3.36", "gpu": "RTX 4060 Ti", "gpu_mode": False, "source": "cpu"}}
        result, calls, state = self.run_flow(
            state,
            probes=[cpu_probe, ok_probe],
            selftests=[(True, "ok")],
            candidates=[cand("0.3.20", "13.0")],
        )
        self.assertEqual(calls["install"], ["0.3.20-13.0"])
        self.assertTrue(result["ok"])
        self.assertTrue(result["gpu"])

    def test_failed_gpu_attempt_is_not_repeated_on_normal_start(self):
        cpu_probe = {"ok": True, "version": "0.3.36", "gpu": False}
        state = {
            "engine_verified": {"version": "0.3.36", "gpu": "RTX 4060 Ti", "gpu_mode": False, "source": "cpu"},
            "gpu_engine_attempt": {"fingerprint": "RTX 4060 Ti|581.15", "result": "failed", "schema": bootstrap.GPU_ATTEMPT_SCHEMA},
        }
        result, calls, _ = self.run_flow(state, probes=[cpu_probe], selftests=[(True, "ok")], candidates=[cand("0.3.20", "13.0")])
        self.assertEqual(calls["install"], [])
        self.assertTrue(result["ok"])
        self.assertFalse(result["gpu"])

    def test_driver_update_retries_gpu_engines(self):
        cpu_probe = {"ok": True, "version": "0.3.36", "gpu": False}
        ok_probe = {"ok": True, "version": "0.3.20", "gpu": True}
        state = {
            "engine_verified": {"version": "0.3.36", "gpu": "RTX 4060 Ti", "gpu_mode": False, "source": "cpu"},
            "gpu_engine_attempt": {"fingerprint": "RTX 4060 Ti|560.70", "result": "failed", "schema": bootstrap.GPU_ATTEMPT_SCHEMA},
        }
        result, calls, _ = self.run_flow(state, probes=[cpu_probe, ok_probe], selftests=[(True, "ok")], candidates=[cand("0.3.20", "13.0")])
        self.assertEqual(calls["install"], ["0.3.20-13.0"])

    def test_old_gave_up_note_from_previous_candidate_list_is_ignored(self):
        cpu_probe = {"ok": True, "version": "0.3.36", "gpu": False}
        ok_probe = {"ok": True, "version": "0.3.36", "gpu": True}
        state = {
            "engine_verified": {"version": "0.3.36", "gpu": "RTX 4060 Ti", "gpu_mode": False, "source": "cpu"},
            "gpu_engine_attempt": {"fingerprint": "RTX 4060 Ti|560.94", "result": "failed", "schema": 1},
        }
        result, calls, _ = self.run_flow(state, probes=[cpu_probe, ok_probe], selftests=[(True, "ok")], candidates=[cand("0.3.36", "12.4")])
        self.assertEqual(calls["install"], ["0.3.36-12.4"])

    def test_verified_engine_is_not_retested(self):
        probe = {"ok": True, "version": "0.3.20", "gpu": True}
        state = {"engine_verified": {"version": "0.3.20", "gpu": "RTX 4060 Ti", "gpu_mode": True, "source": "x"}}
        result, calls, _ = self.run_flow(state, probes=[probe], selftests=[(True, "ok")], candidates=[])
        self.assertEqual(calls["tests"], [])
        self.assertEqual(calls["install"], [])
        self.assertTrue(result["ok"])

    def test_engine_change_triggers_new_check(self):
        probe = {"ok": True, "version": "0.3.20", "gpu": True}
        state = {"engine_verified": {"version": "0.3.16", "gpu": "RTX 4060 Ti", "gpu_mode": True, "source": "x"}}
        result, calls, _ = self.run_flow(state, probes=[probe], selftests=[(True, "ok")], candidates=[])
        self.assertEqual(calls["tests"], [True])

    def test_unusable_cpu_engine_reports_failure(self):
        crash_probe = {"ok": False, "error": "illegal instruction (0xC000001D)", "code": -1073741795}
        result, calls, state = self.run_flow(
            {},
            probes=[crash_probe],
            selftests=[(False, CRASH)],
            candidates=[],
        )
        self.assertFalse(result["ok"])
        self.assertNotIn("engine_verified", state)


if __name__ == "__main__":
    unittest.main()
