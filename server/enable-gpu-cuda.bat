@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI - Enable NVIDIA CUDA 12 GPU Acceleration

echo ==========================================================
echo    SilkloraAI - Enable NVIDIA CUDA 12 GPU Acceleration
echo ==========================================================
echo.
echo Detected 8 GB NVIDIA GPU. Setting up full GPU acceleration...
echo This will allow models to load directly into VRAM (n_gpu_layers = -1).
echo.

set "PY_EXE="
set "PY_ARGS="

if exist "%~dp0python_runtime\python.exe" (
    set "PY_EXE=%~dp0python_runtime\python.exe"
) else if exist "venv\Scripts\python.exe" (
    set "PY_EXE=venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=python"
    ) else (
        echo Error: Python environment not found. Please run start-server.bat first.
        pause
        exit /b 1
    )
)

echo [1/3] Installing NVIDIA CUDA 12 runtime & cuBLAS packages via pip...
"%PY_EXE%" %PY_ARGS% -m pip install nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 --prefer-binary

echo.
echo [2/3] Installing CUDA-accelerated llama-cpp-python engine...
"%PY_EXE%" %PY_ARGS% -m pip install --upgrade --force-reinstall llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121

echo.
echo [3/3] Linking CUDA DLLs and testing GPU inference engine...
"%PY_EXE%" %PY_ARGS% link_cuda.py

if !ERRORLEVEL! equ 0 (
    echo.
    echo ==========================================================
    echo [SUCCESS] NVIDIA GPU acceleration is now fully activated!
    echo When you load a model with GPU Layers = -1, it will load
    echo directly into your 8 GB VRAM.
    echo ==========================================================
) else (
    echo.
    echo ==========================================================
    echo Configuration finished with code !ERRORLEVEL!.
    echo Please review log output above.
    echo ==========================================================
)

echo.
pause
