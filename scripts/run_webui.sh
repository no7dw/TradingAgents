#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_ROOT"
if [[ ! -f web/dist/index.html ]]; then
  npm --prefix web ci
  npm --prefix web run build
fi
if [[ -x venv/bin/python ]]; then
  exec venv/bin/python -m webui.server
else
  exec python -m webui.server
fi
