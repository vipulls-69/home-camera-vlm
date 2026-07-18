#!/usr/bin/env bash
# One-command setup + run for Sentinel: installs backend (Python venv) and
# frontend (npm) dependencies if missing, then starts both dev servers.
#
# Safe to re-run: existing venvs / node_modules are reused, so this doubles
# as the day-to-day "start the app" command for existing contributors.
#
# Usage: ./setup.sh
set -euo pipefail

cd "$(dirname "$0")"
ROOT_DIR="$PWD"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
VENV_DIR="$BACKEND_DIR/.venv"

PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "==> Backend: setting up Python virtual environment"
if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$BACKEND_DIR/requirements.txt"
deactivate

echo "==> Frontend: installing npm dependencies"
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  (cd "$FRONTEND_DIR" && npm install)
else
  echo "node_modules already present, skipping npm install (delete frontend/node_modules to force a reinstall)"
fi

cleanup() {
  echo
  echo "Shutting down..."
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting backend (http://localhost:8000)"
(
  cd "$BACKEND_DIR"
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  exec python main.py
) &

echo "==> Starting frontend (http://localhost:3000)"
(
  cd "$FRONTEND_DIR"
  exec npm run dev
) &

wait
