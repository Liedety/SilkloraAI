@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI Local AI Hub Server
:: Disable Windows Console QuickEdit mode to prevent accidental mouse clicks from suspending the server
reg add HKCU\Console /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1

echo ==========================================================
echo          SilkloraAI Local AI Hub - Windows Launcher
echo ==========================================================
echo.

set "PY_EXE="
set "PY_ARGS="

:: 1. Check for existing local bundled/downloaded runtime
if exist "%~dp0python_runtime\python.exe" (
    "%~dp0python_runtime\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=%~dp0python_runtime\python.exe"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 2. Check for existing working venv
if exist "venv\Scripts\python.exe" (
    "venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=venv\Scripts\python.exe"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 3. Check standard installation folders in AppData and Program Files
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

:: 4. Try Python Launcher py -3 or py
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

:: 5. Try standard python in PATH
where python >nul 2>nul
if !ERRORLEVEL! equ 0 (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set "PY_EXE=python"
        set "PY_ARGS="
        goto :python_found
    )
)

:: 6. Automatic download and install of Python 3.11 if missing
echo Python 3 was not detected on this system.
echo Automatically downloading Python 3.11 runtime for Windows...
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
    echo Error: Failed to download Python installer.
    echo Please install Python 3.10+ from python.org.
    pause
    exit /b 1
)

echo Installing Python 3.11 into local environment...
start /wait "" "%~dp0python_setup.exe" /quiet InstallAllUsers=0 TargetDir="%~dp0python_runtime" AssociateFiles=0 Shortcuts=0 Include_launcher=0 Include_test=0 Include_pip=1 PrependPath=0
if exist "%~dp0python_setup.exe" del "%~dp0python_setup.exe" >nul 2>&1

if exist "%~dp0python_runtime\python.exe" (
    set "PY_EXE=%~dp0python_runtime\python.exe"
    set "PY_ARGS="
    goto :python_found
)

echo Error: Python installation failed.
pause
exit /b 1

:python_found
echo Located Python: "%PY_EXE%" %PY_ARGS%

set "RUN_EXE="
set "RUN_ARGS="

if exist "venv\Scripts\python.exe" (
    set "RUN_EXE=venv\Scripts\python.exe"
    set "RUN_ARGS="
) else if exist "%~dp0python_runtime\python.exe" (
    set "RUN_EXE=%~dp0python_runtime\python.exe"
    set "RUN_ARGS="
) else (
    set "RUN_EXE=%PY_EXE%"
    set "RUN_ARGS=%PY_ARGS%"
)

:: Ensure pip is ready
"%RUN_EXE%" %RUN_ARGS% -m pip --version >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo Installing pip...
    "%RUN_EXE%" %RUN_ARGS% -m ensurepip --default-pip >nul 2>&1
)

:: Install/verify base requirements
echo Checking dependencies...
"%RUN_EXE%" %RUN_ARGS% -m pip install -r requirements.txt --prefer-binary >nul 2>&1

:: Check and setup NVIDIA GPU CUDA 12 acceleration and modern engine
where nvidia-smi >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo NVIDIA GPU detected. Verifying inference engine and CUDA 12 acceleration...
    "%RUN_EXE%" %RUN_ARGS% ensure_engine.py
) else (
    "%RUN_EXE%" %RUN_ARGS% -c "from llama_cpp import Llama" >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        echo Installing CPU-optimized inference engine...
        "%RUN_EXE%" %RUN_ARGS% -m pip install llama-cpp-python --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
    )
)

:: Ensure Windows Firewall rule for port 8080 (requests Admin UAC if missing)
netsh advfirewall firewall show rule name="SilkloraAI Local Hub" >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo Opening port 8080 in Windows Firewall for mobile phone connection...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"SilkloraAI Local Hub\" dir=in action=allow protocol=TCP localport=8080 profile=any' -Verb RunAs -Wait" >nul 2>&1
)

echo.
echo ==========================================================
echo Starting SilkloraAI Local AI Hub server on port 8080...
echo Web Panel: http://localhost:8080
echo ==========================================================
echo.

"%RUN_EXE%" %RUN_ARGS% server.py %*

if !ERRORLEVEL! neq 0 (
    echo.
    echo Server process exited with code !ERRORLEVEL!.
    pause
)
