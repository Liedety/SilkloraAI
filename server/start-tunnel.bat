@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title SilkloraAI - Cloudflare Online Tunnel

echo ==========================================================
echo        SilkloraAI - Cloudflare Online Tunnel (HTTPS)
echo ==========================================================
echo.
echo This tool creates a free, secure public HTTPS connection.
echo It bypasses all Wi-Fi router isolation and Windows Firewall.
echo Your phone can connect via 4G, 5G, or any Wi-Fi network.
echo.

if exist "%~dp0cloudflared.exe" goto :cloudflared_ready

echo Downloading Cloudflare Tunnel client (one-time setup, ~30 MB)...
if exist "%SystemRoot%\System32\curl.exe" (
    "%SystemRoot%\System32\curl.exe" -L -o "%~dp0cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    goto :check_download
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', '%~dp0cloudflared.exe')"

:check_download
if not exist "%~dp0cloudflared.exe" (
    echo Error: Failed to download cloudflared.exe. Please check internet connection.
    pause
    exit /b 1
)
echo Cloudflare client successfully installed.
echo.

:cloudflared_ready
echo Starting tunnel for local server at http://localhost:8080...
echo.
echo Look for the line below containing:
echo "https://...trycloudflare.com"
echo.
echo Copy that HTTPS URL and enter it into the SilkloraAI app on your phone:
echo Example: https://your-tunnel-name.trycloudflare.com/v1
echo.
echo Keep this window open while using the mobile app.
echo Press Ctrl+C to stop the tunnel.
echo ==========================================================
echo.

"%~dp0cloudflared.exe" tunnel --url http://localhost:8080

pause
