@echo off
chcp 65001 >nul
title CrashPY - Arranque automatico
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LANZADOR=%STARTUP%\CrashPY.cmd"

if exist "%LANZADOR%" goto ya_activo

> "%LANZADOR%" echo @echo off
>> "%LANZADOR%" echo rem Creado por CrashPY: abre el juego y el tunel al iniciar Windows
>> "%LANZADOR%" echo start "CrashPY - Servidor" /min "%~dp0INICIAR.bat"
>> "%LANZADOR%" echo timeout /t 10 /nobreak ^>nul
>> "%LANZADOR%" echo start "CrashPY - Tunel" /min "%~dp0TUNEL-CLOUDFLARE.bat"

echo.
echo  Listo. Cada vez que prendas la PC e inicies sesion se abren solos,
echo  minimizados, el juego (INICIAR.bat) y el tunel (TUNEL-CLOUDFLARE.bat).
echo.
echo  Importante:
echo   - Configura antes el tunel una vez con TUNEL-CLOUDFLARE.bat
echo   - En Windows pone Suspender: Nunca, para que la PC no se duerma
echo.
pause
exit /b 0

:ya_activo
echo.
echo  El arranque automatico ya esta activado.
set "RESP="
set /p "RESP=Si queres desactivarlo escribi S y apreta Enter: "
if /i "%RESP%"=="S" (
  del /q "%LANZADOR%"
  echo  Desactivado.
) else (
  echo  Sigue activado.
)
echo.
pause
