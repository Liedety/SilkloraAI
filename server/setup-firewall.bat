@echo off
setlocal
cd /d "%~dp0"
title SilkloraAI - Windows Defender Firewall Setup

echo ==========================================================
echo       SilkloraAI Local Hub - Firewall Configuration
echo ==========================================================
echo.
echo Requesting Administrator privileges to open TCP port 8080...
echo (If prompted by Windows User Account Control, please click YES)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c netsh advfirewall firewall add rule name=\"SilkloraAI Local Hub\" dir=in action=allow protocol=TCP localport=8080 profile=any && echo. && echo [SUCCESS] Firewall rule configured! Your phone can now connect. && pause' -Verb RunAs"

echo Done.
