import threading
from collections import deque
from datetime import datetime
from typing import List

from .paths import LOG_FILE

MAX_LOG_FILE_BYTES = 1024 * 1024


class DiagnosticLogger:
    def __init__(self, max_entries: int = 1000):
        self._lock = threading.Lock()
        self._entries = deque(maxlen=max_entries)
        self._trim_file()

    def _trim_file(self):
        try:
            if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_FILE_BYTES:
                tail = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-500:]
                LOG_FILE.write_text("\n".join(tail) + "\n", encoding="utf-8")
        except Exception:
            pass

    def log(self, level: str, message: str):
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry = f"[{stamp}] [{level.upper()}] {message}"
        with self._lock:
            self._entries.append(entry)
            try:
                with open(LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(entry + "\n")
            except Exception:
                pass
        try:
            print(f"[SilkloraAI] [{level.upper()}] {message}", flush=True)
        except Exception:
            pass

    def info(self, message: str):
        self.log("INFO", message)

    def warning(self, message: str):
        self.log("WARNING", message)

    def error(self, message: str):
        self.log("ERROR", message)

    def entries(self) -> List[str]:
        with self._lock:
            return list(self._entries)

    def clear(self):
        with self._lock:
            self._entries.clear()
            try:
                LOG_FILE.write_text("", encoding="utf-8")
            except Exception:
                pass


logger = DiagnosticLogger()
