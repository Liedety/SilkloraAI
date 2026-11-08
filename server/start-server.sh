#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================================="
echo "         SilkloraAI Local AI Hub - Linux Launcher         "
echo "=========================================================="

if ! command -v python3 &> /dev/null; then
    echo "ERROR: python3 was not found. Please install Python 3.10+."
    exit 1
fi

VENV_DIR="$SCRIPT_DIR/venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Initializing virtual environment in $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "Checking package dependencies from requirements.txt..."
pip install -q --upgrade pip
pip install -q -r "$SCRIPT_DIR/requirements.txt"

echo "Starting SilkloraAI Local AI Hub server on port 8080..."
python "$SCRIPT_DIR/server.py" "$@"
