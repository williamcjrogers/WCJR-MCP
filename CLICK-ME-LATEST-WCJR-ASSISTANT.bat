@echo off
rem Launches the latest source build from this workspace.
rem Updated: 2026-03-24 22:19 Europe/London
setlocal
cd /d "%~dp0"

if not exist "package.json" (
  echo This launcher must be run from the WCJR-MCP project folder.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies are missing.
  echo Run "npm install" in this folder first, then click this file again.
  pause
  exit /b 1
)

echo Stopping any existing WCJR Assistant source processes from this workspace...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$project = [regex]::Escape((Resolve-Path '.').Path); " ^
  "$targets = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $project -and ($_.Name -in @('electron.exe','node.exe','WCJR Assistant.exe','cmd.exe')) }; " ^
  "foreach ($process in $targets) { try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch {} }"
timeout /t 1 /nobreak >nul

echo Launching WCJR Assistant from source...
call npm --workspace apps/desktop run start
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo WCJR Assistant failed to start. Exit code: %EXIT_CODE%
  pause
)

exit /b %EXIT_CODE%
