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

echo ERROR: Python 3 (3.8+) was not found on this system.
echo Please install Python 3.10 or 3.11 from https://www.python.org/downloads/
echo Ensure the option Add Python to PATH is checked during installation.
echo.
pause
exit /b 1

:python_found
echo Located Python: "%PY_EXE%" %PY_ARGS%

set "RUN_EXE="
set "RUN_ARGS="

if exist "venv\Scripts\python.exe" (
    echo Using existing virtual environment in venv.
    set "RUN_EXE=venv\Scripts\python.exe"
    set "RUN_ARGS="
) else (
    echo Initializing virtual environment in venv...
    "%PY_EXE%" %PY_ARGS% -m venv venv >nul 2>&1
    if exist "venv\Scripts\python.exe" (
        echo Virtual environment successfully initialized.
        set "RUN_EXE=venv\Scripts\python.exe"
        set "RUN_ARGS="
    ) else (
        echo Notice: Virtual environment not available. Using system Python directly.
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
