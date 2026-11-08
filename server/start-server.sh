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
RUN_PY="python3"

if [ -f "$VENV_DIR/bin/python" ]; then
    RUN_PY="$VENV_DIR/bin/python"
elif python3 -m venv "$VENV_DIR" 2>/dev/null && [ -f "$VENV_DIR/bin/python" ]; then
    RUN_PY="$VENV_DIR/bin/python"
else
    echo "Notice: venv not available, using system python3."
    RUN_PY="python3"
fi

echo "Installing / verifying requirements..."
"$RUN_PY" -m pip install -q -r "$SCRIPT_DIR/requirements.txt" --prefer-binary || "$RUN_PY" -m pip install -q --user -r "$SCRIPT_DIR/requirements.txt" --prefer-binary || true

echo "Starting SilkloraAI Local AI Hub server on port 8080..."
echo "Web panel: http://localhost:8080"
exec "$RUN_PY" "$SCRIPT_DIR/server.py" "$@"
