@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI Local AI Hub

rem Single entry point: finds or installs Python, then bootstrap.py does the rest.
rem Options are passed through: --repair, --no-browser

set "PY="
set "PYARGS="

call :probe "%~dp0python_runtime\python.exe" ""
if defined PY goto :run
call :probe "%~dp0venv\Scripts\python.exe" ""
if defined PY goto :run

where py >nul 2>nul
if !errorlevel! equ 0 (
    for %%V in (3.12 3.11 3.13 3.10) do (
        if not defined PY call :probe "py" "-%%V"
    )
)
if defined PY goto :run

call :probe "python" ""
if defined PY goto :run

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if not defined PY call :probe "%%~D\python.exe" ""
)
for /d %%D in ("%ProgramFiles%\Python3*") do (
    if not defined PY call :probe "%%~D\python.exe" ""
)
if defined PY goto :run

echo Python 3.10 - 3.13 was not found. Installing a private copy of Python 3.11...
set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
if "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9.exe"

if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -L -o "%~dp0python_setup.exe" "!SETUP_URL!"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('!SETUP_URL!', '%~dp0python_setup.exe')"
)
if not exist "%~dp0python_setup.exe" (
    echo Could not download Python. Check your internet connection or install Python 3.11 from python.org.
    pause
    exit /b 1
)
start /wait "" "%~dp0python_setup.exe" /quiet InstallAllUsers=0 TargetDir="%~dp0python_runtime" AssociateFiles=0 Shortcuts=0 Include_launcher=0 Include_test=0 Include_pip=1 PrependPath=0
del "%~dp0python_setup.exe" >nul 2>&1

call :probe "%~dp0python_runtime\python.exe" ""
if not defined PY (
    echo Python installation failed. Please install Python 3.11 from python.org and run this file again.
    pause
    exit /b 1
)

:run
"%PY%" %PYARGS% "%~dp0bootstrap.py" %*
if !errorlevel! neq 0 (
    echo.
    echo The server stopped with an error. Details are in data\server.log
    pause
)
exit /b %errorlevel%

:probe
rem %1 = interpreter, %2 = extra arguments. Accepts Python 3.10 to 3.13 only.
"%~1" %~2 -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1
if !errorlevel! equ 0 (
    set "PY=%~1"
    set "PYARGS=%~2"
)
exit /b 0
