@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI - Qwen2.5-VL Engine Installer

echo ==========================================================
echo    SilkloraAI - Qwen2.5-VL CUDA Engine Auto-Installer
echo ==========================================================
echo.

set "PY_EXE="
if exist "%~dp0python_runtime\python.exe" (
    set "PY_EXE=%~dp0python_runtime\python.exe"
) else if exist "venv\Scripts\python.exe" (
    set "PY_EXE=venv\Scripts\python.exe"
) else (
    set "PY_EXE=python"
)

"!PY_EXE!" ensure_engine.py

echo.
pause
