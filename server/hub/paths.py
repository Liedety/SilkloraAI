from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
IMAGE_MODELS_DIR = MODELS_DIR / "image"
IMAGE_AUX_DIR = MODELS_DIR / "image_aux"
LORAS_DIR = MODELS_DIR / "loras"
BIN_DIR = BASE_DIR / "bin" / "sd"
DATA_DIR = BASE_DIR / "data"
SCENES_DIR = DATA_DIR / "scenes"
LORA_DATASETS_DIR = DATA_DIR / "lora_datasets"
WEB_DIR = BASE_DIR / "web"
LOG_FILE = DATA_DIR / "server.log"
SETTINGS_FILE = DATA_DIR / "settings.json"

for _d in (MODELS_DIR, IMAGE_MODELS_DIR, IMAGE_AUX_DIR, LORAS_DIR, DATA_DIR, SCENES_DIR, LORA_DATASETS_DIR):
    _d.mkdir(parents=True, exist_ok=True)
