@echo off
REM Use npm.cmd so PowerShell script blocking does not affect dev startup.
cd /d "%~dp0"
call npm.cmd run dev
