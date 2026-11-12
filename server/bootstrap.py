#!/usr/bin/env python3
"""SilkloraAI Local AI Hub: one-step environment setup and launch.

Called by start-server.bat / start-server.sh with a suitable Python interpreter. Uses only the
standard library until the requirements are installed. Every step is skipped when the machine
is already set up, so repeated starts are fast.

Options:
    install        only install everything (packages, engine, firewall rule) and exit
    --repair       reinstall the inference engine and ask for the firewall rule again
    --no-browser   do not open the dashboard automatically
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

DATA_DIR = BASE_DIR / "data"
STATE_FILE = DATA_DIR / "setup_state.json"
REQUIREMENTS = BASE_DIR / "requirements.txt"

IS_WINDOWS = os.name == "nt"
MIN_ENGINE_VERSION = (0, 3, 16)
CPU_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/cpu"
CUDA_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/cu121"
METAL_INDEX = "https://abetlen.github.io/llama-cpp-python/whl/metal"
WHEEL_RELEASES = "https://api.github.com/repos/dougeeai/llama-cpp-python-wheels/releases"
FIREWALL_RULE = "SilkloraAI-Hub"
LEGACY_FIREWALL_RULE = "SilkloraAI Local Hub"


def say(text: str = ""):
    print(text, flush=True)


def step(number: int, total: int, text: str):
    say(f"[{number}/{total}] {text}")


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict):
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except Exception:
        pass


def pip(*args: str, quiet: bool = True) -> bool:
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", *args]
    if quiet:
        cmd.insert(5, "-q")
    return subprocess.run(cmd).returncode == 0


# --------------------------------------------------------------------------- requirements

def ensure_requirements(state: dict) -> bool:
    digest = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()
    if state.get("requirements") == digest:
        probe = subprocess.run(
            [sys.executable, "-c", "import fastapi, uvicorn, requests, psutil"],
            capture_output=True,
        )
        if probe.returncode == 0:
            return True

    if subprocess.run([sys.executable, "-m", "pip", "--version"], capture_output=True).returncode != 0:
        subprocess.run([sys.executable, "-m", "ensurepip", "--default-pip"], capture_output=True)

    ok = pip("--prefer-binary", "-r", str(REQUIREMENTS)) or pip("--prefer-binary", "--user", "-r", str(REQUIREMENTS))
    if ok:
        state["requirements"] = digest
    return ok


# --------------------------------------------------------------------------- hardware

def nvidia_info() -> Optional[dict]:
    smi = shutil.which("nvidia-smi")
    if not smi and IS_WINDOWS:
        for candidate in (r"C:\Windows\System32\nvidia-smi.exe", r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe"):
            if os.path.exists(candidate):
                smi = candidate
                break
    if not smi:
        return None
    for fields in ("name,compute_cap,driver_version", "name,driver_version"):
        try:
            out = subprocess.check_output(
                [smi, f"--query-gpu={fields}", "--format=csv,noheader"],
                universal_newlines=True, timeout=8, stderr=subprocess.DEVNULL,
            ).strip().splitlines()
        except Exception:
            continue
        if out:
            parts = [p.strip() for p in out[0].split(",")]
            info = {"name": parts[0], "compute_cap": "", "driver": parts[-1]}
            if "compute_cap" in fields:
                info["compute_cap"] = parts[1]
            return info
    return None


def compute_cap_number(info: dict) -> int:
    """8.9 -> 89, 12.0 -> 120. Falls back to the GPU name for old drivers without compute_cap."""
    cap = info.get("compute_cap", "")
    match = re.match(r"(\d+)\.(\d+)", cap)
    if match:
        return int(match.group(1)) * 10 + int(match.group(2))
    name = info.get("name", "").lower()
    guesses = (("rtx 50", 120), ("rtx 40", 89), ("rtx 30", 86), ("rtx a", 86), ("rtx 20", 75), ("gtx 16", 75), ("t4", 75))
    for token, value in guesses:
        if token in name:
            return value
    return 0


# --------------------------------------------------------------------------- engine

TEST_MODEL_URL = "https://huggingface.co/ggml-org/tiny-llamas/resolve/main/stories260K.gguf"
TEST_MODEL = DATA_DIR / "engine_test.gguf"
TEST_MODEL_MIN_BYTES = 500_000
# 0xC000001D STATUS_ILLEGAL_INSTRUCTION: the build uses a processor instruction set this CPU lacks.
CRASH_CODES = (-1073741795, 3221225501)
MAX_GPU_CANDIDATES = 4
CUDA13_MIN_DRIVER = 580


def probe_engine() -> dict:
    """Import llama_cpp in a fresh process so a crashing build cannot take the launcher down."""
    code = (
        "import sys, json; sys.path.insert(0, sys.argv[1])\n"
        "from hub import cuda; cuda.register_dll_directories(); cuda.link_cuda_dlls()\n"
        "import llama_cpp as l\n"
        "print(json.dumps({'version': getattr(l, '__version__', '0'), 'gpu': bool(l.llama_supports_gpu_offload())}))\n"
    )
    try:
        proc = subprocess.run([sys.executable, "-c", code, str(BASE_DIR)], capture_output=True, text=True, timeout=90)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if proc.returncode != 0:
        if proc.returncode in CRASH_CODES:
            return {"ok": False, "error": "illegal instruction (0xC000001D)", "code": proc.returncode}
        tail = (proc.stderr or "").strip().splitlines()[-1:] or [f"exit code {proc.returncode}"]
        return {"ok": False, "error": tail[0], "code": proc.returncode}
    try:
        data = json.loads(proc.stdout.strip().splitlines()[-1])
        return {"ok": True, "version": data["version"], "gpu": data["gpu"]}
    except Exception:
        return {"ok": False, "error": "unexpected probe output"}


def ensure_test_model() -> bool:
    if TEST_MODEL.exists() and TEST_MODEL.stat().st_size >= TEST_MODEL_MIN_BYTES:
        return True
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = TEST_MODEL.with_suffix(".part")
    try:
        import urllib.request

        with urllib.request.urlopen(TEST_MODEL_URL, timeout=60) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f)
        os.replace(tmp, TEST_MODEL)
        return True
    except Exception as e:
        say(f"      Could not download the engine test model: {e}")
        tmp.unlink(missing_ok=True)
        return False


def engine_selftest(use_gpu: bool) -> tuple:
    """Load a real tiny model and generate a few tokens. Returns (ok, reason)."""
    if not ensure_test_model():
        return False, "test model unavailable"
    code = (
        "import sys; sys.path.insert(0, sys.argv[1])\n"
        "from hub import cuda; cuda.register_dll_directories(); cuda.link_cuda_dlls()\n"
        "from llama_cpp import Llama\n"
        "llm = Llama(model_path=sys.argv[2], n_ctx=256, n_gpu_layers=int(sys.argv[3]), verbose=False)\n"
        "out = llm.create_completion('Once upon a time', max_tokens=4, temperature=0.0)\n"
        "print('SELFTEST_OK', len(out['choices'][0]['text']))\n"
    )
    layers = "-1" if use_gpu else "0"
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code, str(BASE_DIR), str(TEST_MODEL), layers],
            capture_output=True, text=True, timeout=240,
        )
    except subprocess.TimeoutExpired:
        return False, "the test model did not finish in time"
    if proc.returncode in CRASH_CODES:
        return False, "illegal instruction (0xC000001D): this build needs a processor feature this CPU does not have"
    if proc.returncode == 0 and "SELFTEST_OK" in (proc.stdout or ""):
        return True, "ok"
    tail = (proc.stderr or "").strip().splitlines()[-1:] or [f"exit code {proc.returncode}"]
    return False, tail[0]


def version_tuple(text: str):
    nums = re.findall(r"\d+", text.split("+")[0])[:3]
    return tuple(int(n) for n in nums) + (0,) * (3 - len(nums))


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "SilkloraAI-Hub", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


WHEEL_RE = re.compile(
    r"llama_cpp_python-(?P<ver>\d+\.\d+\.\d+)\+cuda(?P<cuda>\d+\.\d+)\.(?P<arch>[\w.]+)-(?P<py>[a-z0-9]+)-[a-z0-9_]+-win_amd64\.whl",
    re.IGNORECASE,
)


def driver_major(gpu: dict) -> int:
    match = re.match(r"\d+", gpu.get("driver", "") or "")
    return int(match.group(0)) if match else 0


def windows_cuda_candidates(gpu: dict) -> list:
    """Prebuilt Windows CUDA wheels for this GPU, newest version first, best CUDA match first."""
    cap = compute_cap_number(gpu)
    if not cap:
        return []
    drv = driver_major(gpu)
    py_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    found = []
    seen = set()
    for page in (1, 2):
        try:
            releases = fetch_json(f"{WHEEL_RELEASES}?per_page=100&page={page}")
        except Exception:
            break
        if not releases:
            break
        for release in releases:
            for asset in release.get("assets", []):
                match = WHEEL_RE.match(asset["name"])
                if not match or match["py"] not in (py_tag, "py3"):
                    continue
                sms = [int(n) for n in re.findall(r"sm(\d+)", match["arch"])]
                if not sms:
                    continue
                if match["cuda"].startswith("13.") and drv < CUDA13_MIN_DRIVER:
                    continue
                usable = [s for s in sms if s // 10 == cap // 10 and s <= cap]
                if not usable:
                    continue
                if cap >= 100 and not match["cuda"].startswith("13."):
                    continue
                key = asset["browser_download_url"]
                if key in seen:
                    continue
                seen.add(key)
                cuda_rank = 0 if match["cuda"].startswith("13.") else 1
                found.append({
                    "url": key,
                    "version": match["ver"],
                    "cuda": match["cuda"],
                    "sort": (
                        tuple(-n for n in version_tuple(match["ver"])),
                        cuda_rank,
                        0 if cap in sms else 1,
                        0 if match["py"] == py_tag else 1,
                    ),
                })
    found.sort(key=lambda c: c["sort"])
    return found[:MAX_GPU_CANDIDATES]


def uninstall_engine():
    subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "llama-cpp-python"], capture_output=True)


def install_windows_candidate(cand: dict) -> bool:
    runtime = ["nvidia-cuda-runtime", "nvidia-cublas"] if cand["cuda"].startswith("13.") else ["nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"]
    pip("--prefer-binary", *runtime)
    uninstall_engine()
    return pip("--upgrade", "--no-cache-dir", cand["url"], quiet=False)


def install_cpu_engine() -> bool:
    uninstall_engine()
    if platform.system() == "Darwin":
        return (
            pip("--upgrade", "--prefer-binary", "--only-binary=llama-cpp-python", "llama-cpp-python", "--extra-index-url", METAL_INDEX, quiet=False)
            or pip("--upgrade", "--prefer-binary", "llama-cpp-python", quiet=False)
        )
    return (
        pip("--upgrade", "--prefer-binary", "--only-binary=llama-cpp-python", "llama-cpp-python", "--extra-index-url", CPU_INDEX, quiet=False)
        or pip("--upgrade", "--prefer-binary", "llama-cpp-python", quiet=False)
    )


def install_cuda_engine_linux() -> bool:
    uninstall_engine()
    return pip("--upgrade", "--prefer-binary", "--only-binary=llama-cpp-python", "llama-cpp-python", "--extra-index-url", CUDA_INDEX, quiet=False)


def _record(state: dict, probe: dict, gpu: Optional[dict], source: str):
    state["engine_verified"] = {
        "version": probe["version"],
        "gpu": gpu["name"] if gpu else "",
        "gpu_mode": bool(probe["gpu"]),
        "source": source,
    }
    state.pop("engine_gave_up", None)


def _verified_for(state: dict, probe: dict, gpu: Optional[dict]) -> bool:
    rec = state.get("engine_verified") or {}
    return (
        probe["ok"]
        and rec.get("version") == probe["version"]
        and rec.get("gpu") == (gpu["name"] if gpu else "")
        and rec.get("gpu_mode") == bool(probe["gpu"])
    )


def ensure_engine(state: dict, repair: bool) -> dict:
    gpu = nvidia_info()
    use_gpu = gpu is not None and platform.system() != "Darwin"
    probe = probe_engine()

    def outdated(p):
        return p["ok"] and version_tuple(p["version"]) < MIN_ENGINE_VERSION

    if probe["ok"] and not outdated(probe) and not repair:
        if _verified_for(state, probe, gpu):
            return probe
        if (probe["gpu"] or not use_gpu):
            say("      Checking the installed engine with a test model...")
            ok, reason = engine_selftest(bool(probe["gpu"]))
            if ok:
                _record(state, probe, gpu, "installed")
                return probe
            say(f"      The installed engine failed the check: {reason}")

    if not probe["ok"]:
        say(f"      Inference engine is not ready: {probe.get('error', 'not installed')}")
    elif outdated(probe):
        say(f"      Inference engine {probe['version']} is outdated")
    elif use_gpu and not probe["gpu"]:
        say(f"      GPU detected ({gpu['name']}) but the engine runs on CPU only")

    if use_gpu and platform.system() == "Windows":
        candidates = windows_cuda_candidates(gpu)
        if not candidates:
            say("      No prebuilt GPU engine matches this graphics card and driver.")
        for number, cand in enumerate(candidates, start=1):
            say(f"      GPU engine option {number}/{len(candidates)}: llama-cpp-python {cand['version']} (CUDA {cand['cuda']})")
            if not install_windows_candidate(cand):
                say("        installation failed, trying the next option")
                continue
            probe = probe_engine()
            if not probe["ok"]:
                say(f"        does not start: {probe.get('error', 'unknown error')}")
                continue
            ok, reason = engine_selftest(bool(probe["gpu"]))
            if ok:
                _record(state, probe, gpu, f"cuda-{cand['cuda']}-{cand['version']}")
                return probe
            say(f"        failed the check: {reason}")
    elif use_gpu and platform.system() == "Linux":
        say("      Installing GPU engine (CUDA 12)")
        install_cuda_engine_linux()
        probe = probe_engine()
        if probe["ok"]:
            ok, reason = engine_selftest(bool(probe["gpu"]))
            if ok:
                _record(state, probe, gpu, "linux-cuda12")
                return probe
            say(f"        failed the check: {reason}")

    say("      Installing the CPU engine")
    install_cpu_engine()
    probe = probe_engine()
    if probe["ok"]:
        ok, reason = engine_selftest(False)
        if ok:
            _record(state, probe, gpu, "cpu")
            return probe
        say(f"      The CPU engine failed the check: {reason}")
        probe = dict(probe, ok=False, error=reason)
    state.pop("engine_verified", None)
    return probe


# --------------------------------------------------------------------------- firewall

def firewall_rule_exists() -> bool:
    for name in (FIREWALL_RULE, LEGACY_FIREWALL_RULE):
        proc = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule", f"name={name}"],
            capture_output=True,
        )
        if proc.returncode == 0:
            return True
    return False


def ensure_firewall(state: dict, repair: bool):
    if not IS_WINDOWS:
        return True
    if firewall_rule_exists():
        return True
    if state.get("firewall_declined") and not repair:
        return False
    say("      Windows will ask for permission to open the network port for your phone.")
    ps = (
        "Start-Process netsh -Verb RunAs -Wait -ArgumentList "
        f"'advfirewall','firewall','add','rule','name={FIREWALL_RULE}','dir=in','action=allow',"
        "'protocol=TCP','localport=8080-8099','profile=any'"
    )
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], capture_output=True)
    if firewall_rule_exists():
        state.pop("firewall_declined", None)
        return True
    state["firewall_declined"] = True
    say("      Port was not opened. The phone may not connect. Run start-server again with --repair to retry.")
    return False


# --------------------------------------------------------------------------- main

def main(argv) -> int:
    from hub.console import disable_quickedit

    disable_quickedit()
    repair = "--repair" in argv
    install_only = "--install" in argv or "install" in argv
    passthrough = [a for a in argv if a not in ("--repair", "--install", "install")]
    state = load_state()

    say("=" * 60)
    say("  SilkloraAI Local AI Hub")
    say("=" * 60)

    if sys.version_info < (3, 10):
        say(f"Python 3.10 or newer is required (found {platform.python_version()}).")
        return 1

    total = 3
    step(1, total, "Checking components")
    if not ensure_requirements(state):
        say("      Could not install the required packages. Check your internet connection and run again.")
        save_state(state)
        return 1

    step(2, total, "Preparing the inference engine")
    probe = ensure_engine(state, repair)
    if probe["ok"]:
        say(f"      Engine {probe['version']} ({'GPU acceleration' if probe['gpu'] else 'CPU'})")
    else:
        say("      The inference engine could not be started. The dashboard will show details.")

    step(3, total, "Network access for the phone")
    ensure_firewall(state, repair)
    save_state(state)

    if install_only:
        say("")
        if probe["ok"]:
            say("Installation finished. Start the server with start-server.bat (or start-server.sh).")
            return 0
        say("Installation finished, but the inference engine did not start. See data\\server.log.")
        return 1

    say("")
    import server

    return server.main(passthrough)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
