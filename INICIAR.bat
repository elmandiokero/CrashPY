@echo off
chcp 65001 >nul
title CrashPY - Servidor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] No se encontro Node.js en esta PC.
  echo      Instala la version LTS desde https://nodejs.org y volve a abrir este archivo.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo  Instalando dependencias por primera vez, espera un momento...
  echo.
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo  [X] No se pudieron instalar las dependencias. Revisa tu conexion a internet.
    pause
    exit /b 1
  )
)

if not exist ".env" if exist ".env.example" copy ".env.example" ".env" >nul

:inicio
echo.
echo  Iniciando CrashPY... (para apagarlo cerra esta ventana o apreta Ctrl+C)
echo.
node server\index.js
if %errorlevel% neq 0 (
  echo.
  echo  El servidor se cerro con un error. Se reinicia solo en 5 segundos...
  timeout /t 5 /nobreak >nul
  goto inicio
)
echo.
echo  El servidor se apago.
pause
