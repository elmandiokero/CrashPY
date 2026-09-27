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

if exist "cloudflared-config.yml" goto correr_dominio
if exist "cloudflared-token.txt" goto correr_token

:menu
echo.
echo  ============================================================
echo   COMO QUERES PUBLICAR EL JUEGO?
echo.
echo   1 = Con mi dominio, por ejemplo crash.alexlamasg.lat  [RECOMENDADO]
echo       Se configura solo: se abre el navegador, elegis tu dominio
echo       en Cloudflare y tocas Authorize. Nada mas.
echo.
echo   2 = Ya tengo un token de Cloudflare y lo quiero pegar
echo.
echo   3 = Tunel rapido de prueba, con una direccion temporal
echo  ============================================================
echo.
set "OPCION="
set /p "OPCION=Escribi 1, 2 o 3 y apreta Enter: "
if "%OPCION%"=="1" goto configurar_dominio
if "%OPCION%"=="2" goto pedir_token
if "%OPCION%"=="3" goto rapido
goto menu

rem ---- Opcion 1: dominio propio, todo automatico ----
:configurar_dominio
set "HOST="
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PUBLIC_URL=" ".env"') do set "HOST=%%b"
)
if not defined HOST set "HOST=crash.alexlamasg.lat"
set "HOST=%HOST:https://=%"
set "HOST=%HOST:http://=%"
set "HOST=%HOST:/=%"
echo.
echo  El juego va a quedar en:  https://%HOST%
set "OTRO="
set /p "OTRO=Apreta Enter para confirmar, o escribi otro dominio: "
if defined OTRO set "HOST=%OTRO%"
set "HOST=%HOST:https://=%"
set "HOST=%HOST:http://=%"
set "HOST=%HOST:/=%"

if not exist "%USERPROFILE%\.cloudflared\cert.pem" (
  echo.
  echo  Se va a abrir el navegador con Cloudflare:
  echo  inicia sesion, toca tu dominio y despues Authorize.
  echo  Cuando diga que ya podes cerrar la pagina, volve a esta ventana.
  echo.
  %CF% tunnel login
)
if not exist "%USERPROFILE%\.cloudflared\cert.pem" (
  echo.
  echo  [X] No se completo la autorizacion en Cloudflare. Abri este archivo de nuevo.
  pause
  exit /b 1
)

echo.
echo  Creando el tunel crashpy-pc...
%CF% tunnel create crashpy-pc >nul 2>&1
if exist "cloudflared-cred.json" del /q "cloudflared-cred.json"
%CF% tunnel token --cred-file "%~dp0cloudflared-cred.json" crashpy-pc >nul
if not exist "cloudflared-cred.json" (
  echo.
  echo  [X] No se pudo crear el tunel. Revisa los mensajes de arriba.
  pause
  exit /b 1
)

echo  Apuntando %HOST% a esta PC...
%CF% tunnel route dns -f crashpy-pc %HOST%
if errorlevel 1 (
  echo.
  echo  [X] No se pudo crear el registro DNS de %HOST%.
  echo      Revisa que el dominio este en la misma cuenta de Cloudflare que autorizaste.
  if exist "cloudflared-cred.json" del /q "cloudflared-cred.json"
  pause
  exit /b 1
)

> "cloudflared-config.yml" echo tunnel: crashpy-pc
>> "cloudflared-config.yml" echo credentials-file: '%~dp0cloudflared-cred.json'
>> "cloudflared-config.yml" echo ingress:
>> "cloudflared-config.yml" echo   - service: http://localhost:%PORT%

echo.
echo  Listo, quedo configurado: https://%HOST%
goto correr_dominio

:correr_dominio
echo.
echo  ============================================================
echo   Conectando el tunel de Cloudflare con tu dominio...
echo   Primero tiene que estar abierto INICIAR.bat
echo.
echo   Cuando veas "Registered tunnel connection" ya se puede entrar.
echo   Para configurar otro dominio borra cloudflared-config.yml
echo  ============================================================
echo.
%CF% tunnel --no-autoupdate --config "%~dp0cloudflared-config.yml" run
goto fin

rem ---- Opcion 2: token copiado desde el panel ----
:pedir_token
echo.
echo  Pega el comando o el token que te mostro Cloudflare
echo  (cloudflared.exe service install eyJ...) y apreta Enter.
echo.
set "CF_INPUT="
set /p "CF_INPUT=Token: "
if not defined CF_INPUT goto menu
powershell -NoProfile -Command "$t = (($env:CF_INPUT).Trim() -split '\s+')[-1]; Set-Content -NoNewline -Encoding ascii -Path 'cloudflared-token.txt' -Value $t"

:correr_token
rem Deja en el archivo solo el token (por si se pego el comando completo)
powershell -NoProfile -Command "$t = ((Get-Content -Raw 'cloudflared-token.txt').Trim() -split '\s+')[-1]; Set-Content -NoNewline -Encoding ascii -Path 'cloudflared-token.txt' -Value $t"
echo.
echo  ============================================================
echo   Conectando el tunel de Cloudflare con tu token...
echo   Primero tiene que estar abierto INICIAR.bat
echo   Para usar otro token borra el archivo cloudflared-token.txt
echo  ============================================================
echo.
%CF% tunnel --no-autoupdate run --token-file "%~dp0cloudflared-token.txt"
goto fin

rem ---- Opcion 3: tunel rapido de prueba ----
:rapido
echo.
echo  ============================================================
echo   Abriendo un tunel rapido hacia http://localhost:%PORT%
echo   Primero tiene que estar abierto INICIAR.bat
echo.
echo   Abajo va a aparecer una direccion parecida a:
echo      https://algo-algo-algo.trycloudflare.com
echo   Esa es la direccion para abrir desde el celular.
echo   Cambia cada vez que abris el tunel.
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
