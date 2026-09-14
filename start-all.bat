@echo off
cd /d "%~dp0server"
start "Server" cmd /k "node index.js"
cd /d "%~dp0client"
start "Client" cmd /k "npx vite"
echo Started server on http://localhost:9017
echo Started client on http://localhost:5173
