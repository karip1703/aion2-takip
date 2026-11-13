@echo off
rem AION 2 Takip - Ekran izleyici baslatici (kurulum gerektirmez)
cd /d "%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0izleyici.ps1"
