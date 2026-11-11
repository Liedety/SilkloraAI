@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI Local AI Hub

rem One file for everything. It prepares Python 3.11 (downloaded when no suitable Python exists),
rem creates the private environment in venv\, installs all packages and the inference engine for
rem the graphics card, opens the network port for the phone, and then starts the server.
rem
rem   start-server.bat            install whatever is missing and start the server
rem   start-server.bat install    install everything and exit, without starting the server
rem   start-server.bat --repair   reinstall the inference engine and the firewall rule

set "VENV_DIR=%~dp0venv"
set "VENV_PY=%~dp0venv\Scripts\python.exe"
set "PRIVATE_PY=%~dp0python_runtime\python.exe"
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
if not defined BASE_CMD call :install_python
if not defined BASE_CMD goto :fail_python

echo Creating the environment in venv\ ...
%BASE_CMD% -m venv "%VENV_DIR%"
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

:fail_python
echo Python could not be prepared. See the messages above.
pause
exit /b 1

:fail_venv
echo Could not create the environment in venv\. Delete the venv folder and run this file again.
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

:install_python
echo.
echo Python 3.10 - 3.13 was not found on this computer.
set "SETUP_EXE=%~dp0python-3.11.9-amd64.exe"
if exist "%SETUP_EXE%" goto :run_setup

set "SETUP_EXE=%~dp0python_setup.exe"
echo Downloading Python 3.11 into python_runtime\ (one time, about 25 MB)...
echo Offline: place python-3.11.9-amd64.exe next to start-server.bat and run this file again.
set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
if "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 set "SETUP_URL=https://www.python.org/ftp/python/3.11.9/python-3.11.9.exe"
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -L --fail -o "%SETUP_EXE%" "!SETUP_URL!"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('!SETUP_URL!', '%SETUP_EXE%')"
)
if !errorlevel! neq 0 if exist "%~dp0python_setup.exe" del "%~dp0python_setup.exe" >nul 2>&1
if not exist "%SETUP_EXE%" (
    echo Could not download Python. Check the internet connection, or install Python 3.11 from python.org and place the installer here as python-3.11.9-amd64.exe.
    exit /b 1
)

:run_setup
if exist "%~dp0python_runtime" rmdir /s /q "%~dp0python_runtime" >nul 2>&1
echo Installing Python 3.11 ...
"%SETUP_EXE%" /quiet InstallAllUsers=0 TargetDir="%~dp0python_runtime" AssociateFiles=0 Shortcuts=0 Include_launcher=0 Include_test=0 Include_pip=1 PrependPath=0
if exist "%~dp0python_setup.exe" del "%~dp0python_setup.exe" >nul 2>&1

call :find_base
exit /b 0

:probe
rem %1 = interpreter, %2 = its extra argument. Sets OK_PY when the interpreter is Python 3.10 - 3.13.
set "OK_PY="
"%~1" %~2 -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,13) else 1)" >nul 2>&1
if !errorlevel! equ 0 set "OK_PY=1"
exit /b 0
