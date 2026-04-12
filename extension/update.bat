@echo off
chcp 65001 >nul 2>&1
setlocal

echo ============================================
echo   UnityChat - Aktualizace extension
echo ============================================
echo.

set "ZIP=%TEMP%\unitychat-update.zip"
set "DIR=%TEMP%\unitychat-update"
set "URL=https://jouki.cz/download/unitychat.zip"

echo Stahuji nejnovejsi verzi z %URL% ...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%URL%' -OutFile '%ZIP%'" 2>nul
if not exist "%ZIP%" (
    echo.
    echo CHYBA: Stazeni se nezdarilo. Zkontroluj pripojeni k internetu.
    pause
    exit /b 1
)

echo Rozbaluji...
if exist "%DIR%" rmdir /s /q "%DIR%"
powershell -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DIR%' -Force" 2>nul
if not exist "%DIR%\manifest.json" (
    echo.
    echo CHYBA: Rozbaleni se nezdarilo.
    pause
    exit /b 1
)

echo Aktualizuji soubory...
xcopy /s /y /q "%DIR%\*" "%~dp0" >nul

echo Cistim docasne soubory...
del "%ZIP%" 2>nul
rmdir /s /q "%DIR%" 2>nul

echo.
echo ============================================
echo   Hotovo! Nyni v prohlizeci:
echo   1. Otevri chrome://extensions
echo   2. Klikni na reload tlacitko u UnityChat
echo ============================================
echo.
pause
