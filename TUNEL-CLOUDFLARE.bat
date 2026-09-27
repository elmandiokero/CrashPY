@echo off
chcp 65001 >nul
title CrashPY - Tunel Cloudflare
cd /d "%~dp0"

rem Puerto del servidor (el mismo que PORT en .env; por defecto 3000)
set PORT=3000
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do set PORT=%%b
)

set CF=
where cloudflared >nul 2>nul
if not errorlevel 1 set CF=cloudflared
if not defined CF if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"
if not defined CF (
  echo.
  echo  [X] No se encontro cloudflared.
  echo.
  echo  Opcion 1 - En una terminal ejecuta:  winget install --id Cloudflare.cloudflared
  echo             y despues volve a abrir este archivo.
  echo  Opcion 2 - Descarga cloudflared-windows-amd64.exe desde
  echo             https://github.com/cloudflare/cloudflared/releases/latest
  echo             renombralo a cloudflared.exe y ponelo en esta misma carpeta.
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   Abriendo un tunel rapido hacia http://localhost:%PORT%
echo   Primero tiene que estar abierto INICIAR.bat
echo.
echo   Abajo va a aparecer una direccion parecida a:
echo      https://algo-algo-algo.trycloudflare.com
echo   Esa es la direccion para abrir desde el celular.
echo   (cambia cada vez que abris el tunel; para una fija mira el README)
echo  ============================================================
echo.
%CF% tunnel --no-autoupdate --url http://localhost:%PORT%
echo.
echo  El tunel se cerro.
pause
