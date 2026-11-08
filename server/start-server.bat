@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SilkloraAI Local AI Hub Server

echo ==========================================================
echo          SilkloraAI Local AI Hub - Windows Launcher
echo ==========================================================
echo.

set "PY_CMD="

where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PY_CMD=python"
    goto :found_python
)

where py >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PY_CMD=py -3"
    goto :found_python
)

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
    if exist "%%~D\python.exe" (
        set "PY_CMD=%%~D\python.exe"
        goto :found_python
    )
)

for /d %%D in ("%ProgramFiles%\Python3*") do (
    if exist "%%~D\python.exe" (
        set "PY_CMD=%%~D\python.exe"
        goto :found_python
    )
)

echo ERROR: Python 3 was not detected in PATH or default directories.
echo Please install Python 3.10 or newer from https://www.python.org/
echo Ensure the option "Add Python to PATH" is checked during setup.
echo.
pause
exit /b 1

:found_python
echo Python binary located: %PY_CMD%

if not exist "venv\Scripts\python.exe" (
    echo Initializing virtual environment in venv...
    %PY_CMD% -m venv venv
    if %ERRORLEVEL% neq 0 (
        echo Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo Verifying Python package dependencies...
call "venv\Scripts\python.exe" -m pip install -q --upgrade pip
call "venv\Scripts\python.exe" -m pip install -q -r requirements.txt
if %ERRORLEVEL% neq 0 (
    echo Notice: pip installation returned non-zero code. Attempting to start server...
)

echo.
echo Launching SilkloraAI Local AI Hub server on port 8080...
echo.
call "venv\Scripts\python.exe" server.py %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo Server process exited with code %ERRORLEVEL%.
    pause
)
