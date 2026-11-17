#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8107}"
if [ -x "/usr/local/google/home/morrisette/.gemini/jetski/scratch/lingoforge/.venv/bin/python" ]; then
  PY="/usr/local/google/home/morrisette/.gemini/jetski/scratch/lingoforge/.venv/bin/python"
else
  PY="python3"
fi
exec "$PY" server.py --host 0.0.0.0 --port "$PORT"
