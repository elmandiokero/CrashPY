@echo off
chcp 65001 >nul
title CrashPY - Tunel Cloudflare
cd /d "%~dp0"

rem Puerto del servidor (el mismo que PORT en .env; por defecto 3000)
set PORT=3000
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do set PORT=%%b
)

call :buscar_cloudflared
if not defined CF (
  echo.
  echo  No se encontro cloudflared. Instalandolo con winget...
  echo.
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  call :buscar_cloudflared
)
if not defined CF (
  echo.
  echo  [X] No se pudo instalar cloudflared automaticamente.
  echo.
  echo  Descarga cloudflared-windows-amd64.exe desde
  echo  https://github.com/cloudflare/cloudflared/releases/latest
  echo  renombralo a cloudflared.exe y ponelo en esta misma carpeta.
  echo.
  pause
  exit /b 1
)

if exist "cloudflared-token.txt" goto permanente

echo.
echo  ============================================================
echo   TUNEL PERMANENTE (tu dominio, por ejemplo crash.alexlamasg.lat)
echo.
echo   Si ya creaste el tunel en Cloudflare, pega aca el comando o el
echo   token que te mostro Cloudflare (cloudflared.exe service install eyJ...)
echo   y apreta Enter. Queda guardado para la proxima vez.
echo.
echo   Si todavia no lo tenes, solo apreta Enter y se abre un tunel
echo   rapido de prueba con una direccion temporal.
echo  ============================================================
echo.
set "CF_INPUT="
set /p "CF_INPUT=Token: "
if not defined CF_INPUT goto rapido
powershell -NoProfile -Command "$t = (($env:CF_INPUT).Trim() -split '\s+')[-1]; Set-Content -NoNewline -Encoding ascii -Path 'cloudflared-token.txt' -Value $t"

:permanente
rem Deja en el archivo solo el token (por si se pego el comando completo)
powershell -NoProfile -Command "$t = ((Get-Content -Raw 'cloudflared-token.txt').Trim() -split '\s+')[-1]; Set-Content -NoNewline -Encoding ascii -Path 'cloudflared-token.txt' -Value $t"
echo.
echo  ============================================================
echo   Conectando el tunel permanente de Cloudflare...
echo   Primero tiene que estar abierto INICIAR.bat
echo.
echo   Cuando veas "Registered tunnel connection" ya se puede entrar
echo   desde tu dominio, por ejemplo https://crash.alexlamasg.lat
echo.
echo   Para usar otro token borra el archivo cloudflared-token.txt
echo  ============================================================
echo.
%CF% tunnel --no-autoupdate run --token-file "%~dp0cloudflared-token.txt"
goto fin

:rapido
echo.
echo  ============================================================
echo   Abriendo un tunel rapido hacia http://localhost:%PORT%
echo   Primero tiene que estar abierto INICIAR.bat
echo.
echo   Abajo va a aparecer una direccion parecida a:
echo      https://algo-algo-algo.trycloudflare.com
echo   Esa es la direccion para abrir desde el celular.
echo   Cambia cada vez que abris el tunel; para una fija mira el README.
echo  ============================================================
echo.
%CF% tunnel --no-autoupdate --url http://localhost:%PORT%

:fin
echo.
echo  El tunel se cerro.
pause
exit /b 0

:buscar_cloudflared
set CF=
where cloudflared >nul 2>nul
if not errorlevel 1 set CF=cloudflared
if not defined CF if exist "%~dp0cloudflared.exe" set CF="%~dp0cloudflared.exe"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set CF="%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set CF="%ProgramFiles%\cloudflared\cloudflared.exe"
exit /b 0
