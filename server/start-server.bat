@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI Local AI Hub Server

echo ==========================================================
echo          SilkloraAI Local AI Hub - Windows Launcher
echo ==========================================================
echo.

set "PY_EXE="
set "PY_ARGS="

:: 0. Check for local bundled/downloaded runtime
if exist "%~dp0python_runtime\python.exe" (
    "%~dp0python_runtime\python.exe" -c "import sys; sys.exit(0)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=%~dp0python_runtime\python.exe"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 1. Try standard python in PATH
where python >nul 2>nul
if !ERRORLEVEL! equ 0 (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=python"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 2. Try Python Launcher py -3 or py
where py >nul 2>nul
if !ERRORLEVEL! equ 0 (
    py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=py"
        set "PY_ARGS=-3"
        goto :python_found
    )
    py -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=py"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 3. Try standard installation folders in AppData and Program Files
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%~D\python.exe" (
        "%%~D\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            set "PY_EXE=%%~D\python.exe"
            set "PY_ARGS="
            goto :python_found
        )
    )
)

for /d %%D in ("%ProgramFiles%\Python3*") do (
    if exist "%%~D\python.exe" (
        "%%~D\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            set "PY_EXE=%%~D\python.exe"
            set "PY_ARGS="
            goto :python_found
        )
    )
)

for /d %%D in ("%ProgramFiles(x86)%\Python3*") do (
    if exist "%%~D\python.exe" (
        "%%~D\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            set "PY_EXE=%%~D\python.exe"
            set "PY_ARGS="
            goto :python_found
        )
    )
)

:: 4. Automatic setup: download and install standalone Python 3.11 runtime
echo Python 3 was not detected on this system.
echo Automatically downloading Python 3.11 runtime for Windows...
echo Please wait, downloading installer...

set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
if "%PROCESSOR_ARCHITECTURE%"=="x86" (
    if not defined PROCESSOR_ARCHITEW6432 (
        set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9.exe"
    )
)

if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -L -o "%~dp0python_setup.exe" "!SETUP_URL!"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('!SETUP_URL!', '%~dp0python_setup.exe')"
)

if not exist "%~dp0python_setup.exe" (
    echo Error: Failed to download Python installer automatically.
    echo Please check internet connection or install Python 3.10+ from python.org.
    echo.
    pause
    exit /b 1
)

echo Installing Python 3.11 runtime into local environment...
echo (Takes about 30-60 seconds, please wait...)
start /wait "" "%~dp0python_setup.exe" /quiet InstallAllUsers=0 TargetDir="%~dp0python_runtime" AssociateFiles=0 Shortcuts=0 Include_launcher=0 Include_test=0 Include_pip=1 PrependPath=0
if exist "%~dp0python_setup.exe" del "%~dp0python_setup.exe" >nul 2>&1

if exist "%~dp0python_runtime\python.exe" (
    echo Python 3.11 runtime successfully initialized in python_runtime.
    set "PY_EXE=%~dp0python_runtime\python.exe"
    set "PY_ARGS="
    goto :python_found
)

echo Notice: Local directory setup returned unexpected result. Attempting user profile install...
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -L -o "%~dp0python_setup.exe" "!SETUP_URL!"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('!SETUP_URL!', '%~dp0python_setup.exe')"
)
start /wait "" "%~dp0python_setup.exe" /quiet InstallAllUsers=0 SimpleInstall=1 PrependPath=1 Include_pip=1
if exist "%~dp0python_setup.exe" del "%~dp0python_setup.exe" >nul 2>&1

if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" (
    echo Python 3.11 successfully installed into user profile.
    set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    set "PY_ARGS="
    goto :python_found
)

echo ERROR: Automatic installation could not be completed.
echo Please install Python 3.10 or 3.11 from https://www.python.org/
echo Check the box Add Python to PATH during installation.
echo.
pause
exit /b 1

:python_found
echo Located Python: "%PY_EXE%" %PY_ARGS%

set "RUN_EXE="
set "RUN_ARGS="

if exist "venv\Scripts\python.exe" (
    echo Using existing virtual environment: venv
    set "RUN_EXE=venv\Scripts\python.exe"
    set "RUN_ARGS="
) else if exist "%~dp0python_runtime\python.exe" (
    echo Using local runtime environment.
    set "RUN_EXE=%~dp0python_runtime\python.exe"
    set "RUN_ARGS="
) else (
    echo Initializing virtual environment in venv...
    "%PY_EXE%" %PY_ARGS% -m venv venv >nul 2>&1
    if exist "venv\Scripts\python.exe" (
        echo Virtual environment successfully initialized.
        set "RUN_EXE=venv\Scripts\python.exe"
        set "RUN_ARGS="
    ) else (
        echo Notice: Virtual environment not available. Using Python directly.
        set "RUN_EXE=%PY_EXE%"
        set "RUN_ARGS=%PY_ARGS%"
    )
)

echo Installing / verifying dependencies from requirements.txt...
"%RUN_EXE%" %RUN_ARGS% -m pip install -r requirements.txt --prefer-binary
if !ERRORLEVEL! neq 0 (
    echo Retrying pip installation with --user flag...
    "%RUN_EXE%" %RUN_ARGS% -m pip install --user -r requirements.txt --prefer-binary
)

:: Check / install llama-cpp-python with NVIDIA CUDA acceleration if available
"%RUN_EXE%" %RUN_ARGS% -c "import llama_cpp" >nul 2>&1
if !ERRORLEVEL! neq 0 (
    where nvidia-smi >nul 2>nul
    if !ERRORLEVEL! equ 0 (
        echo NVIDIA GPU detected. Installing CUDA-accelerated llama-cpp-python...
        "%RUN_EXE%" %RUN_ARGS% -m pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu121
        if !ERRORLEVEL! neq 0 (
            echo Notice: CUDA package install returned non-zero code, falling back to CPU version...
            "%RUN_EXE%" %RUN_ARGS% -m pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu >nul 2>&1
        )
    ) else (
        echo Installing CPU-optimized llama-cpp-python...
        "%RUN_EXE%" %RUN_ARGS% -m pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu >nul 2>&1
    )
)

echo.
echo Launching SilkloraAI Local AI Hub server on port 8080...
echo Web panel: http://localhost:8080
echo.
"%RUN_EXE%" %RUN_ARGS% server.py %*

if !ERRORLEVEL! neq 0 (
    echo.
    echo Server process exited with code !ERRORLEVEL!.
    pause
)
