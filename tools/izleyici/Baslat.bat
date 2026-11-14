@echo off
rem AION 2 Takip - uygulama baslatici (kurulum gerektirmez): ekran izleyici + site penceresi
cd /d "%~dp0"
start "" powershell -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0izleyici.ps1"
