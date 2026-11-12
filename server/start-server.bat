@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI Local AI Hub

rem One file for everything. It makes sure Python 3.10 - 3.13 is available (an existing one is used,
rem otherwise Python 3.12 is fetched by the uv tool into python_runtime\), creates the environment in
rem venv\, installs all packages and the inference engine for the graphics card, opens the network port
rem for the phone, and then starts the server.
rem
rem   start-server.bat            install whatever is missing and start the server
rem   start-server.bat install    install everything and exit, without starting the server
rem   start-server.bat --repair   reinstall the inference engine and the firewall rule

set "VENV_DIR=%~dp0venv"
set "VENV_PY=%~dp0venv\Scripts\python.exe"
set "PRIVATE_PY=%~dp0python_runtime\python.exe"
set "UV_EXE=%~dp0python_tools\uv.exe"
set "BASE_CMD="
set "OK_PY="

echo ==========================================================
echo   SilkloraAI Local AI Hub - setup
echo ==========================================================

if exist "%VENV_PY%" (
    call :probe "%VENV_PY%" ""
    if defined OK_PY goto :deps
    echo The existing environment is damaged. Recreating it...
    rmdir /s /q "%VENV_DIR%" >nul 2>&1
)

call :find_base
if defined BASE_CMD (
    echo Creating the environment in venv\ ...
    %BASE_CMD% -m venv "%VENV_DIR%"
) else (
    call :uv_environment
)
if not exist "%VENV_PY%" goto :fail_venv

:deps
echo.
"%VENV_PY%" "%~dp0bootstrap.py" %*
set "RESULT=!errorlevel!"
if /i "%~1"=="install" goto :finish_install
if !RESULT! neq 0 goto :fail_run
exit /b 0

:finish_install
echo.
if !RESULT! neq 0 echo Installation finished with errors. See the messages above.
pause
exit /b !RESULT!

:fail_run
echo.
echo The server stopped with an error. Details are in data\server.log
pause
exit /b !RESULT!

:fail_venv
echo.
echo The environment could not be created. Check the internet connection and run this file again.
echo If it keeps failing, delete the venv and python_tools folders and run it again.
pause
exit /b 1

:find_base
rem Looks for an existing Python 3.10 - 3.13 and remembers the first one that works in BASE_CMD.
if exist "%PRIVATE_PY%" (
    call :probe "%PRIVATE_PY%" ""
    if defined OK_PY set "BASE_CMD="%PRIVATE_PY%""
)
if defined BASE_CMD exit /b 0

where py >nul 2>nul
if !errorlevel! equ 0 (
    for %%V in (3.12 3.11 3.13 3.10) do (
        if not defined BASE_CMD (
            call :probe "py" "-%%V"
            if defined OK_PY set "BASE_CMD=py -%%V"
        )
    )
)

if not defined BASE_CMD (
    call :probe "python" ""
    if defined OK_PY set "BASE_CMD=python"
)
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if not defined BASE_CMD (
        call :probe "%%~fD\python.exe" ""
        if defined OK_PY set "BASE_CMD="%%~fD\python.exe""
    )
)
for /d %%D in ("%ProgramFiles%\Python3*") do (
    if not defined BASE_CMD (
        call :probe "%%~fD\python.exe" ""
        if defined OK_PY set "BASE_CMD="%%~fD\python.exe""
    )
)
exit /b 0

:uv_environment
rem No usable Python on this computer: uv downloads Python 3.12 and creates the environment with it.
echo.
echo Python 3.10 - 3.13 was not found on this computer.
echo Preparing Python 3.12 with the uv tool (one time, about 30 MB)...
if not exist "%UV_EXE%" call :get_uv
if not exist "%UV_EXE%" (
    echo Could not prepare the uv tool. Check the internet connection and run this file again.
    exit /b 1
)
set "UV_PYTHON_INSTALL_DIR=%~dp0python_runtime"
echo Creating the environment in venv\ ...
"%UV_EXE%" venv "%VENV_DIR%" --python 3.12 --seed --clear
exit /b 0

:get_uv
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" (set "UV_ARCH=aarch64") else (set "UV_ARCH=x86_64")
set "UV_URL=https://github.com/astral-sh/uv/releases/latest/download/uv-%UV_ARCH%-pc-windows-msvc.zip"
set "UV_ZIP=%~dp0python_tools\uv.zip"
if not exist "%~dp0python_tools" mkdir "%~dp0python_tools"
echo Downloading uv...
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -sS -L --fail -o "%UV_ZIP%" "%UV_URL%"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('%UV_URL%', '%UV_ZIP%')"
)
if not exist "%UV_ZIP%" exit /b 1
tar -xf "%UV_ZIP%" -C "%~dp0python_tools" uv.exe
del "%UV_ZIP%" >nul 2>&1
exit /b 0

:probe
rem %1 = interpreter, %2 = its extra argument. Sets OK_PY when the interpreter is Python 3.10 - 3.13.
set "OK_PY="
"%~1" %~2 -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1
if !errorlevel! equ 0 set "OK_PY=1"
exit /b 0
