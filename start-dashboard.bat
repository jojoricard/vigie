@echo off
rem Starts LibreHardwareMonitor, the agent and Chrome full screen on the chosen display.
rem To change POS_X / POS_Y (see detect-monitors.ps1), LHM_PATH or BROWSER,
rem set them in start-dashboard.local.bat (ignored by git) rather than here.

set POS_X=0
set POS_Y=0
set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "LHM_PATH=C:\Program Files\LibreHardwareMonitor\LibreHardwareMonitor.exe"

cd /d "%~dp0"
if exist "%~dp0start-dashboard.local.bat" call "%~dp0start-dashboard.local.bat"

rem --- Port from config.json, 5252 when it isn't set ---
set PORT=5252
for /f %%p in ('powershell -NoProfile -Command "(Get-Content -Raw config.json | ConvertFrom-Json).port"') do set PORT=%%p

rem --- Auto update when this is a git clone ---
if exist ".git" (
  where git >nul 2>&1 && git pull --ff-only >nul 2>&1
)

rem --- LibreHardwareMonitor, unless already running ---
tasklist /FI "IMAGENAME eq LibreHardwareMonitor.exe" 2>nul | findstr /i "LibreHardwareMonitor.exe" >nul
if errorlevel 1 (
  if exist "%LHM_PATH%" start "" "%LHM_PATH%"
)

rem --- Node agent without a window, unless already listening ---
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'agent.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
)

rem --- Give the agent time to start ---
timeout /t 4 /nobreak >nul

rem --- Chrome in app mode, full screen on the target display ---
if not exist "%BROWSER%" (
  echo Chrome not found at: %BROWSER%
  echo Set BROWSER in start-dashboard.local.bat.
  pause
  goto :eof
)
start "" "%BROWSER%" --user-data-dir="%~dp0chrome-profile" --disable-gpu --no-first-run --no-default-browser-check --app=http://localhost:%PORT% --window-position=%POS_X%,%POS_Y% --start-fullscreen
