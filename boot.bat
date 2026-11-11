@echo off
setlocal EnableExtensions EnableDelayedExpansion
title autoBlog
cd /d "%~dp0"
rem Launched from VSCode/Claude Code this is inherited and makes Electron run as plain Node
set "ELECTRON_RUN_AS_NODE="

rem ---- 1. Node 20+ (use nvm's folder directly, no global switch / no admin) ----
set "NODE_DIR="
if defined NVM_HOME (
  for /f "delims=" %%d in ('dir /b /ad /o-n "%NVM_HOME%\v2*" 2^>nul') do (
    if not defined NODE_DIR set "NODE_DIR=%NVM_HOME%\%%d"
  )
)
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"

for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if "%NODE_MAJOR%"=="" goto :no_node
if %NODE_MAJOR% LSS 20 goto :no_node
for /f "delims=" %%v in ('node -v') do echo [boot] node %%v

rem ---- 1-1. Desktop shortcut (first run on a new PC) ----
powershell -NoProfile -Command "$l = Join-Path ([Environment]::GetFolderPath('Desktop')) 'autoBlog.lnk'; if (-not (Test-Path $l)) { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($l); $s.TargetPath = '%~dp0boot.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0resources\icon.ico,0'; $s.WindowStyle = 7; $s.Save(); Write-Host '[boot] desktop shortcut created' }"

rem ---- 1-2. Shared API keys (the parent folder .env) ----
if not exist "%~dp0..\.env" echo [boot] NOTE: ..\.env not found. Copy the parent folder .env here for shared AI keys.

rem ---- 2. Pull latest source (skip on failure, keep local changes) ----
echo [boot] git pull...
git pull --ff-only
if errorlevel 1 (
  echo [boot] WARNING: git pull failed ^(local changes or offline^). Running local source.
)

rem ---- 3. npm install only when package-lock.json changed ----
set "STAMP=node_modules\.boot-lock-hash"
set "NEW_HASH="
for /f "delims=" %%h in ('certutil -hashfile package-lock.json SHA256 ^| findstr /v ":"') do (
  if not defined NEW_HASH set "NEW_HASH=%%h"
)
set "OLD_HASH="
if exist "%STAMP%" set /p OLD_HASH=<"%STAMP%"
if not exist node_modules goto :install
if not "%NEW_HASH%"=="%OLD_HASH%" goto :install
goto :run

:install
echo [boot] npm install ^(dependencies changed^)...
call npm install
if errorlevel 1 (
  echo [boot] ERROR: npm install failed.
  pause
  exit /b 1
)
>"%STAMP%" echo %NEW_HASH%

:run
rem ---- 4. Run (dev mode = always the current source) ----
echo [boot] starting autoBlog...
call npm run dev
if errorlevel 1 pause
exit /b 0

:no_node
echo [boot] ERROR: Node 20+ not found. Install with: nvm install 24
pause
exit /b 1
