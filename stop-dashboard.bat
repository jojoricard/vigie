@echo off
rem Stops the agent and the dashboard's Chrome.

cd /d "%~dp0"
set PORT=5252
for /f %%p in ('powershell -NoProfile -Command "(Get-Content -Raw config.json | ConvertFrom-Json).port"') do set PORT=%%p

rem --- Node agent ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do taskkill /pid %%p /f >nul 2>&1

rem --- Dashboard Chrome, recognized by its chrome-profile folder ---
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*chrome-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo Dashboard stopped.
