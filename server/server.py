#!/usr/bin/env python3
"""SilkloraAI Local AI Hub: entry point. Normally started through start-server.bat / start-server.sh."""

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

DEFAULT_PORT = 8080
PORT_SEARCH_RANGE = 20


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0 if os.name == "nt" else 1)
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _stop_previous_instance(port: int, logger) -> None:
    """Terminate an earlier copy of this server that still holds the port."""
    import psutil

    for conn in psutil.net_connections(kind="inet"):
        if conn.laddr.port != port or conn.status != "LISTEN" or not conn.pid or conn.pid == os.getpid():
            continue
        try:
            proc = psutil.Process(conn.pid)
            cmdline = " ".join(proc.cmdline()).lower()
            if "server.py" in cmdline or "bootstrap.py" in cmdline:
                logger.warning(f"Port {port} is held by an earlier server instance (PID {conn.pid}); stopping it")
                proc.kill()
                proc.wait(timeout=5)
        except Exception:
            pass


def choose_port(preferred: int, logger) -> int:
    if not _port_is_free(preferred):
        try:
            _stop_previous_instance(preferred, logger)
        except Exception:
            pass
    for port in range(preferred, preferred + PORT_SEARCH_RANGE):
        if _port_is_free(port):
            if port != preferred:
                logger.warning(f"Port {preferred} is in use by another program; using {port} instead")
            return port
    return preferred


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-browser", action="store_true")
    args, _ = parser.parse_known_args(argv)

    from hub.console import disable_quickedit

    disable_quickedit()

    import uvicorn

    from hub import __version__, api
    from hub.engine import engine_info
    from hub.log import logger
    from hub.network import local_adapters

    logger.info(f"SilkloraAI Local AI Hub {__version__} starting (Python {sys.version.split()[0]})")
    info = engine_info()
    if info["available"]:
        logger.info(f"Inference engine: llama-cpp-python {info['version']} ({'GPU offload available' if info['gpu_offload'] else 'CPU only'})")
    else:
        logger.error(f"Inference engine is not available: {info['error']}")

    port = choose_port(int(os.environ.get("PORT", DEFAULT_PORT)), logger)
    api.port_holder["port"] = port
    primary = local_adapters()[0]["ip"]

    print("", flush=True)
    print("  SilkloraAI Local AI Hub is running", flush=True)
    print(f"  Dashboard (this computer): http://localhost:{port}", flush=True)
    print(f"  Phone address:             http://{primary}:{port}/v1", flush=True)
    print("  Close this window to stop the server.", flush=True)
    print("", flush=True)

    if not args.no_browser and not os.environ.get("SILKLORA_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()

    uvicorn.run(api.create_app(), host="0.0.0.0", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
