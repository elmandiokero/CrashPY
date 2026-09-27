#!/usr/bin/env bash
# Inicia CrashPY en Linux / macOS (se reinicia solo si se cierra con error)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "❌ No se encontró Node.js. Instalá la versión LTS (22.13 o superior) desde https://nodejs.org"
  exit 1
fi

[ -d node_modules ] || npm install --omit=dev || exit 1
[ -f .env ] || cp .env.example .env

while true; do
  node server/index.js && break
  echo "⚠️  El servidor se cerró con un error. Se reinicia en 5 segundos (Ctrl+C para cancelar)..."
  sleep 5
done
