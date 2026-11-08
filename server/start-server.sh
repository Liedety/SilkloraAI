#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================================="
echo "         SilkloraAI Local AI Hub - Launcher (Linux)      "
echo "=========================================================="

# Check python3
if ! command -v python3 &> /dev/null; then
    echo "ERROR: python3 не найден. Установите Python 3.10+ в вашей системе."
    exit 1
fi

VENV_DIR="$SCRIPT_DIR/venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Создание виртуального окружения Python: $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

echo "Активация venv..."
source "$VENV_DIR/bin/activate"

echo "Проверка и установка зависимостей из requirements.txt..."
pip install -q --upgrade pip
pip install -q -r "$SCRIPT_DIR/requirements.txt"

# Run server
echo "Запуск Silklora Local AI Hub сервера на порту 8080..."
python "$SCRIPT_DIR/server.py" "$@"
