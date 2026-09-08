@echo off
echo ========================================
echo Job Apply Master - Setup Script
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] Installing Node.js dependencies for server...
cd server
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Server npm install failed
    pause
    exit /b 1
)
cd ..

echo.
echo [2/4] Installing Node.js dependencies for client...
cd client
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Client npm install failed
    pause
    exit /b 1
)
cd ..

echo.
echo [3/4] Starting Backend Server (port 8001)...
start "JobApply-Server" cmd /k "cd server && npm run dev"

echo.
echo [4/4] Starting Frontend (port 5173)...
start "JobApply-Client" cmd /k "cd client && npm run dev"

echo.
echo ========================================
echo Setup complete!
echo - Backend API: http://localhost:8001
echo - Frontend:    http://localhost:5173
echo - Login:       vincent / 123456  (also admin/admin123, bob/bob123, henry/mgr123)
echo ========================================
echo.
echo NOTE: RabbitMQ and Python Scraper are optional.
echo       Core features work without them.
echo.
pause
