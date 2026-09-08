@echo off
echo ========================================
echo Installing Python Dependencies
echo ========================================
echo.

py -m pip install flask playwright requests

echo.
echo Installing Playwright browsers (this may take a while)...
py -m playwright install chromium

echo.
echo Testing imports...
py -c "import flask; print('Flask OK')" || echo Flask FAILED
py -c "import playwright; print('Playwright OK')" || echo Playwright FAILED
py -c "import requests; print('Requests OK')" || echo Requests FAILED

echo.
echo ========================================
echo Python setup complete!
echo To start the scraper:
echo   cd server\services\scraper
echo   python python_service.py
echo ========================================
pause
