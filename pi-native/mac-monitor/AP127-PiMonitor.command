#!/bin/bash
# AP127 Pi Monitor — starts the localhost dashboard for the Orange Pi Zero 2W
# that runs the flight-schedule fetch pipeline, and opens it in your browser.
# Closing this Terminal window (or Ctrl-C) stops the server.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYFILE="$DIR/server.py"
CFG="$DIR/config.json"

if [ ! -f "$PYFILE" ] || [ ! -f "$CFG" ]; then
    echo "Missing server.py or config.json in $DIR"
    read -r -p "Press Return to close..." _
    exit 1
fi

PORT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port",8766))' "$CFG" 2>/dev/null)
[ -z "$PORT" ] && PORT=8766

PYTHON_BIN=$(command -v python3)
if [ -z "$PYTHON_BIN" ]; then
    echo "python3 not found. Install it with: brew install python3"
    read -r -p "Press Return to close..." _
    exit 1
fi

# Clear a stale instance still bound to the port (e.g. from a crashed session).
EXISTING_PID=$(lsof -ti "tcp:$PORT" 2>/dev/null)
if [ -n "$EXISTING_PID" ]; then
    kill -9 $EXISTING_PID 2>/dev/null
    sleep 0.5
fi

"$PYTHON_BIN" "$PYFILE" &
SERVER_PID=$!

sleep 1
open "http://127.0.0.1:$PORT"

echo ""
echo "AP127 Pi Monitor is running (pid $SERVER_PID)."
echo "Dashboard: http://127.0.0.1:$PORT"
echo "Close this window or press Ctrl-C to stop."
trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
