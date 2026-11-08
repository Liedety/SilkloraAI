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

echo [1/3] Installing NVIDIA CUDA 12 & cuBLAS runtime libraries via pip...
"%PY_EXE%" %PY_ARGS% -m pip install nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 --prefer-binary
if !ERRORLEVEL! neq 0 (
    echo Warning: Pip installation returned warning, continuing...
)

echo.
echo [2/3] Installing CUDA-accelerated llama-cpp-python engine...
"%PY_EXE%" %PY_ARGS% -m pip install --upgrade --force-reinstall llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121

echo.
echo [3/3] Linking CUDA DLLs into inference engine directory...
"%PY_EXE%" %PY_ARGS% -c "import os, sys, shutil; from pathlib import Path; import llama_cpp; lib_dir = Path(llama_cpp.__file__).parent / 'lib'; lib_dir.mkdir(parents=True, exist_ok=True); [(shutil.copy2(dll, lib_dir / dll.name), print('  Linked: ' + dll.name)) for sp in sys.path if (Path(sp) / 'nvidia').exists() for dll in (Path(sp) / 'nvidia').glob('**/bin/*.dll') if dll.name.lower() in ('cudart64_12.dll', 'cublas64_12.dll', 'cublaslt64_12.dll')]; print('  CUDA DLL linking completed.')"

echo.
echo ==========================================================
echo Testing GPU engine initialization...
"%PY_EXE%" %PY_ARGS% -c "from llama_cpp import Llama; import llama_cpp; print('SUCCESS: NVIDIA CUDA engine loaded! GPU offload support:', llama_cpp.llama_supports_gpu_offload())"

if !ERRORLEVEL! equ 0 (
    echo.
    echo [SUCCESS] NVIDIA GPU acceleration is now fully activated!
    echo When you load a model with GPU Layers = -1, it will load into your 8 GB VRAM.
) else (
    echo.
    echo Notice: Automatic test returned non-zero code. Please run start-server.bat to inspect.
)

echo ==========================================================
echo.
pause
