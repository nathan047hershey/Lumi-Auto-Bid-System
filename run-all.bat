@echo off
setlocal EnableExtensions
title Lumi / Job Apply Master - Run All
color 0B
cd /d "%~dp0"

echo.
echo  ========================================
echo   Lumi / Job Apply Master - Run All
echo  ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Node.js not found. Install from https://nodejs.org and retry.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] npm not found. Reinstall Node.js with npm included.
  pause
  exit /b 1
)

REM Optional first-time install on a new PC
if not exist "server\node_modules\" (
  echo  [*] Installing server dependencies...
  pushd server
  call npm.cmd install
  if errorlevel 1 (
    echo  [ERROR] server npm install failed
    popd
    pause
    exit /b 1
  )
  popd
)
if not exist "client\node_modules\" (
  echo  [*] Installing client dependencies...
  pushd client
  call npm.cmd install
  if errorlevel 1 (
    echo  [ERROR] client npm install failed
    popd
    pause
    exit /b 1
  )
  popd
)
if not exist "node_modules\" (
  echo  [*] Installing root dependencies...
  call npm.cmd install
)

REM Free only our ports (do not kill every Node process on the machine)
echo  [*] Freeing ports 9017 and 5173 if busy...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":9017 .*LISTENING"') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":5173 .*LISTENING"') do taskkill /F /PID %%P >nul 2>&1
timeout /t 1 /nobreak >nul

echo  [1/2] Starting API  (http://127.0.0.1:9017^) ...
start "Lumi-API" cmd /k "cd /d ""%~dp0server"" && title Lumi-API && npm.cmd run dev"

timeout /t 3 /nobreak >nul

echo  [2/2] Starting UI   (http://127.0.0.1:5173^) ...
start "Lumi-UI" cmd /k "cd /d ""%~dp0client"" && title Lumi-UI && npm.cmd run dev"

timeout /t 4 /nobreak >nul

echo  [*] Opening browser...
start "" "http://127.0.0.1:5173"

echo.
echo  ========================================
echo   Running
echo  ========================================
echo.
echo   UI:   http://127.0.0.1:5173
echo   API:  http://127.0.0.1:9017
echo.
echo   Default logins (username / password):
echo     vincent / 123456   - Admin (default on login form)
echo     admin   / admin123 - Admin
echo     bob     / bob123   - User
echo     henry   / mgr123   - Manager
echo.
echo   Leave the Lumi-API and Lumi-UI windows open.
echo.
echo   Chrome ^(same profile as Lumi extension^):
echo     1. chrome://extensions -^> Reload Lumi
echo     2. App -^> Check Lumi
echo     3. Auto Bidder -^> 3 Options -^> Add mailbox
echo        ^(turn OFF VPN/Clash first or Microsoft login times out^)
echo.
echo   Greenhouse email codes: after Add mailbox succeeds, Lumi fills them.
echo   Until then: copy/paste the code from Outlook manually.
echo.
pause
endlocal
