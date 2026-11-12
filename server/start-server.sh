#!/usr/bin/env bash
# Single entry point for Linux and macOS: prepares Python and a virtual environment in venv/, then
# bootstrap.py installs the packages and the inference engine and starts the server.
# Options are passed through: install (only set up), --repair, --no-browser
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "=========================================================="
echo "  SilkloraAI Local AI Hub - setup"
echo "=========================================================="

find_python() {
    for candidate in python3.12 python3.11 python3.13 python3.10 python3; do
        if command -v "$candidate" >/dev/null 2>&1 && \
           "$candidate" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

# Downloads uv (a single binary) and a standalone Python 3.12 into the user's home. No root needed.
install_python() {
    echo "Python 3.10 - 3.13 was not found. Downloading Python 3.12 (one time)..." >&2
    if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
        if command -v curl >/dev/null 2>&1; then
            curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
        fi
    fi
    UV="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
    if [ ! -x "$UV" ]; then
        echo "Could not download the Python installer. Install Python 3.11 or 3.12 with your package manager and run this file again." >&2
        return 1
    fi
    "$UV" python install 3.12 >/dev/null
    PY="$("$UV" python find 3.12)"
    echo "$PY"
}

VENV_DIR="$PWD/venv"
PY="$(find_python || true)"
if [ -z "$PY" ] && [ -x "$VENV_DIR/bin/python" ]; then
    PY="$VENV_DIR/bin/python"
fi

if [ -z "$PY" ]; then
    PY="$(install_python)" || exit 1
fi

if [ ! -x "$VENV_DIR/bin/python" ] || ! "$VENV_DIR/bin/python" -c 'import sys' >/dev/null 2>&1; then
    echo "Creating the environment in venv/ ..."
    rm -rf "$VENV_DIR"
    if ! "$PY" -m venv "$VENV_DIR" 2>/dev/null; then
        UV="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
        "$UV" venv --python "$PY" "$VENV_DIR" >/dev/null || {
            echo "Could not create the environment. On Debian or Ubuntu run: sudo apt install python3-venv"
            exit 1
        }
    fi
fi

exec "$VENV_DIR/bin/python" bootstrap.py "$@"
