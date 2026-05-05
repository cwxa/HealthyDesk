@echo off
setlocal
chcp 65001 >nul
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

echo Building frontend...
cd /d "%~dp0.."
call npx vite build
if errorlevel 1 (
    echo Frontend build failed!
    pause
    exit /b 1
)

echo Starting Electron app...
set ELECTRON_RUN_AS_NODE=
call npx electron .

echo.
echo NeckGuardian stopped.
pause
