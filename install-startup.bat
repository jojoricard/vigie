@echo off
rem Adds Vigie to Windows startup (shortcut in shell:startup).
rem Run it once. To undo, delete Vigie.lnk in shell:startup.

set "TARGET=%~dp0start-dashboard.bat"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\Vigie.lnk');" ^
  "$s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"

echo.
echo Shortcut created: %STARTUP%\Vigie.lnk
echo Vigie (agent + screen) will start at every login.
echo.
echo Tip: for LibreHardwareMonitor to ALSO start as administrator
echo (all sensors), open LHM ^> Options ^> "Run On Windows Startup".
echo.
pause
