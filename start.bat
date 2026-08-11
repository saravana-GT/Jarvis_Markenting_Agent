@echo off
echo ==========================================
echo Starting Jarvis Agency Platform...
echo ==========================================

:: Start a temporary minimized command window that waits 2 seconds and opens the browser
start /min cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the node server in the foreground (Ctrl+C to stop)
npm start
