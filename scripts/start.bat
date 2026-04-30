@echo off
setlocal
echo ========================================
echo   NeckGuardian - Starting...
echo ========================================
echo.

echo Stopping old backend if running...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :18920 ^| findstr LISTENING') do (
    taskkill /F /PID %%a 2>nul
    echo Old backend stopped.
)

echo Starting Python backend...
start "NeckGuardian-Backend" cmd /c "cd /d "%~dp0..\backend" && python main.py"

echo Waiting for backend to initialize...
timeout /t 3 /nobreak >nul

echo Starting Electron app...
cd /d "%~dp0.."
set ELECTRON_RUN_AS_NODE=
npx electron .

echo.
echo NeckGuardian stopped.
pause
