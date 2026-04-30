#!/usr/bin/env bash
set -Eeuo pipefail

# Start both servers:
# - Express app: http://localhost:3000
# - Python AI server: http://localhost:8000

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PIDS=()

log() {
    printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

find_python() {
    for cmd in python3 python py; do
        if command -v "$cmd" >/dev/null 2>&1 && "$cmd" --version >/dev/null 2>&1; then
            printf '%s' "$cmd"
            return 0
        fi
    done

    return 1
}

require_free_port() {
    local port="$1"
    local label="$2"

    if ! "$PYTHON_CMD" -c "import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.5)
try:
    s.bind(('127.0.0.1', port))
except OSError:
    sys.exit(1)
finally:
    s.close()
" "$port"; then
        echo "$label port $port is already in use."
        echo "Close the existing server first, then run ./start-all.sh again."
        exit 1
    fi
}

cleanup() {
    local code=$?

    if [ "${#PIDS[@]}" -gt 0 ]; then
        log "Stopping servers..."
        for pid in "${PIDS[@]}"; do
            kill "$pid" >/dev/null 2>&1 || true
        done
        wait "${PIDS[@]}" >/dev/null 2>&1 || true
    fi

    if [ "$code" -eq 0 ]; then
        log "All servers stopped."
    fi

    exit "$code"
}

trap cleanup EXIT INT TERM

PYTHON_CMD="$(find_python)" || {
    echo "Python was not found. Install Python 3 and try again."
    exit 1
}

require_free_port 3000 "Express"
require_free_port 8000 "AI server"

log "Preparing Node dependencies..."
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "node_modules already exists; skipping npm install."
fi

log "Preparing Python virtual environment..."
if [ ! -d "venv" ]; then
    "$PYTHON_CMD" -m venv venv
fi

if [ -f "venv/bin/activate" ]; then
    # macOS/Linux
    # shellcheck disable=SC1091
    source "venv/bin/activate"
elif [ -f "venv/Scripts/activate" ]; then
    # Windows Git Bash
    # shellcheck disable=SC1091
    source "venv/Scripts/activate"
else
    echo "Could not find the virtual environment activation script."
    exit 1
fi

log "Preparing Python dependencies..."
DEPS_STAMP="venv/.requirements-installed"
if [ ! -f "$DEPS_STAMP" ] || [ "requirements.txt" -nt "$DEPS_STAMP" ]; then
    python -m pip install -r requirements.txt
    touch "$DEPS_STAMP"
else
    echo "Python requirements already installed; skipping pip install."
fi

log "Starting AI server on http://localhost:8000 ..."
python semantic_search.py &
PIDS+=("$!")

log "Starting Express server on http://localhost:3000 ..."
npm start &
PIDS+=("$!")

cat <<'EOF'

=================================
Servers are running:
  Express app:   http://localhost:3000
  AI server:     http://localhost:8000
  AI API docs:   http://localhost:8000/docs

Press Ctrl+C to stop both servers.
=================================
EOF

wait -n "${PIDS[@]}"
