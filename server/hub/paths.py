from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
DATA_DIR = BASE_DIR / "data"
WEB_DIR = BASE_DIR / "web"
LOG_FILE = DATA_DIR / "server.log"
SETTINGS_FILE = DATA_DIR / "settings.json"

MODELS_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)
