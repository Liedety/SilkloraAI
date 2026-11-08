@echo off
chcp 65001 > nul
title SilkloraAI Local AI Hub Server

echo ==========================================================
echo          SilkloraAI Local AI Hub - Launcher (Windows)
echo ==========================================================
echo.

where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ОШИБКА: Python не найден в системе.
    echo Пожалуйста, установите Python 3.10+ с официального сайта python.org
    echo и не забудьте отметить галочку "Add Python to PATH".
    pause
    exit /b 1
)

cd /d "%~dp0"

if not exist "venv" (
    echo Создание виртуального окружения venv...
    python -m venv venv
    if %errorlevel% neq 0 (
        echo Ошибка создания venv.
        pause
        exit /b 1
    )
)

echo Активация виртуального окружения...
call venv\Scripts\activate.bat

echo Проверка и обновление зависимостей...
python -m pip install -q --upgrade pip
pip install -q -r requirements.txt

echo.
echo Запуск сервера Silklora Local AI Hub...
echo.
python server.py %*

if %errorlevel% neq 0 (
    echo.
    echo Сервер остановлен с ошибкой.
    pause
)
