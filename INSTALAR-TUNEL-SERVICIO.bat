@echo off
chcp 65001 >nul
title CrashPY - Instalar tunel de Cloudflare como servicio

rem Instalar un servicio de Windows necesita permisos de administrador
net session >nul 2>&1
if errorlevel 1 (
  echo Pidiendo permisos de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Esto deja el tunel de Cloudflare funcionando SIEMPRE,
echo   aunque cierres las ventanas, y arranca solo con Windows.
echo   Usa el token guardado por TUNEL-CLOUDFLARE.bat
echo  ============================================================
echo.

if not exist "cloudflared-token.txt" (
  echo  [X] Todavia no hay token guardado.
  echo      Primero abri TUNEL-CLOUDFLARE.bat y pega el token de Cloudflare.
  echo.
  pause
  exit /b 1
)

set CF=
where cloudflared >nul 2>nul
if not errorlevel 1 set CF=cloudflared
if not defined CF if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set CF="%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set CF="%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF (
  echo  [X] No se encontro cloudflared. Abri primero TUNEL-CLOUDFLARE.bat, que lo instala.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$t = ((Get-Content -Raw 'cloudflared-token.txt').Trim() -split '\s+')[-1]; Set-Content -NoNewline -Encoding ascii -Path 'cloudflared-token.txt' -Value $t"
set /p TOKEN=<cloudflared-token.txt

rem Si ya habia un servicio instalado, se reemplaza
sc query cloudflared >nul 2>&1
if not errorlevel 1 (
  echo  Reemplazando el servicio anterior...
  %CF% service uninstall >nul 2>&1
  timeout /t 3 /nobreak >nul
)

%CF% service install %TOKEN%
if errorlevel 1 (
  echo.
  echo  [X] No se pudo instalar el servicio. Revisa que el token sea el correcto.
  pause
  exit /b 1
)

echo.
echo  Listo. El tunel queda como servicio "cloudflared" de Windows.
echo  Ya no hace falta abrir TUNEL-CLOUDFLARE.bat: solo INICIAR.bat
echo.
sc query cloudflared | findstr /i "STATE"
echo.
pause
