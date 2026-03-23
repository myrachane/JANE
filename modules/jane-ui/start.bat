@echo off
cd /d "%~dp0"
echo Starting Jane UI...
npx --no-install electron .
if %errorlevel% neq 0 (
  echo.
  echo Electron not found. Run install.bat first.
  pause
)
