@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ================================================
echo    UnityChat Extension Build
echo ================================================
echo.

REM ---- check node ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found in PATH.
    echo         Install from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   node %%v
for /f "tokens=*" %%v in ('npm --version') do echo   npm  v%%v
echo.

REM ---- install deps if missing ----
if not exist "node_modules\" (
    echo [1/2] Installing dependencies ^(first run only^)...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
) else (
    echo [1/2] Dependencies already installed.
    echo.
)

REM ---- run build ----
echo [2/2] Building Chrome + Opera extensions...
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ================================================
echo    Build complete.
echo ================================================
echo.
echo   dist\chrome\       (Load unpacked in chrome://extensions)
echo   dist\opera\        (Load unpacked in opera://extensions)
echo   dist\*.zip         (For Chrome Web Store / Opera addons upload)
echo.

REM ---- offer to open dist folder ----
choice /c YN /n /m "Open dist folder in Explorer? [Y/N] "
if errorlevel 2 goto :end
start "" "%~dp0dist"

:end
endlocal
