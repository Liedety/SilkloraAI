#!/usr/bin/env bash
# Single entry point for Linux and macOS: prepares a virtual environment, then bootstrap.py does the rest.
# Options are passed through: --repair, --no-browser
set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

PY=""
for candidate in python3.12 python3.11 python3.13 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
       "$candidate" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "Python 3.10 - 3.13 was not found. Install it with your package manager and run this file again."
    exit 1
fi

if [ ! -x venv/bin/python ]; then
    echo "Creating virtual environment..."
    "$PY" -m venv venv || {
        echo "Could not create a virtual environment. On Debian or Ubuntu run: sudo apt install python3-venv"
        exit 1
    }
fi

exec venv/bin/python bootstrap.py "$@"
