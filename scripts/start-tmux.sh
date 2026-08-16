#!/usr/bin/env bash
# Start (or restart) the openworks tmux session with all services
# Usage: ./start-tmux.sh
#
# Each window auto-restarts on exit so a single crash doesn't kill the service.

set -e
cd "$(dirname "$0")"

SESSION=letter
PROJECT_DIR="$(pwd)"

# Kill existing session if any (clean restart)
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Build "run forever" wrapper — restart on exit, sleep 5s between
wrap() {
  local cmd="$1"
  echo "while true; do echo '[wrap] starting: $cmd'; $cmd; echo '[wrap] exited (status=$?), restart in 5s'; sleep 5; done"
}

tmux new-session -d -s "$SESSION" -n convex \
  "cd $PROJECT_DIR && $(wrap './node_modules/.bin/convex dev')"

tmux new-window -t "$SESSION" -n browser \
  "cd $PROJECT_DIR/browser && $(wrap 'npm run dev')"

tmux new-window -t "$SESSION" -n worker \
  "cd $PROJECT_DIR && $(wrap 'npx tsx scripts/worker.mts')"

echo
echo "tmux session '$SESSION' ready (3 windows: convex, browser, worker)"
echo "  attach:  tmux attach -t $SESSION"
echo "  switch:  Ctrl-b 0/1/2"
echo "  detach:  Ctrl-b d"
echo "  kill:    tmux kill-session -t $SESSION"
echo
sleep 5
echo "--- status ---"
lsof -ti:6001 >/dev/null 2>&1 && echo "  browser  6001  alive" || echo "  browser  6001  starting..."
pgrep -f "convex dev" >/dev/null && echo "  convex          alive" || echo "  convex          starting..."
pgrep -f "worker.m[jt]s" >/dev/null && echo "  worker          alive" || echo "  worker          starting..."
