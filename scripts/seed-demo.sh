#!/usr/bin/env bash
# Seed a demo tasks Store with varied dummy data for UI work on `tasks serve`.
# Usage: bash scripts/seed-demo.sh   (re-running wipes and reseeds)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
export TASKS_HOME="${TASKS_HOME:-/tmp/tasks-ui-demo/home}"
PROJ="${PROJ:-/tmp/tasks-ui-demo/project}"
CLI="bun run $REPO/src/cli.ts"

rm -rf "/tmp/tasks-ui-demo"
mkdir -p "$TASKS_HOME" "$PROJ"
cd "$PROJ"

run() { $CLI "$@"; }

run init >/dev/null

# Helper: create a task, echo its short id (parsed from "task: new #N: title").
mk() { run new "$@" | sed -n 's/^task: new #\([0-9]*\):.*/\1/p'; }

# --- backlog (varied effort, bodies, attendance) ---
mk "Design the onboarding flow" --effort high --body "Three screens: welcome, connect store, first task. Needs copy review." >/dev/null
mk "Tweak footer spacing" --effort low >/dev/null
mk "Research SSE reconnect backoff" --effort medium --unattended --body "Native EventSource retry stalls after proxy drop. Compare manual backoff strategies." >/dev/null
mk "Write ADR for path encoding" --effort low --body "Capture why we URL-encode the project path into the store dir name." >/dev/null

# --- ready ---
R1=$(mk "Add keyboard shortcuts" --effort medium --body "j/k to move card focus, e to edit, n for new task.")
R2=$(mk "Polish empty-lane state" --effort low)
run mv "$R1" ready >/dev/null
run mv "$R2" ready >/dev/null

# --- doing (one attended, one agent) ---
D1=$(mk "Build the card drawer" --effort high --body "Slide-in panel: title, body markdown, deps, effort, attendance toggle.")
D2=$(mk "Crawl docs for examples" --effort medium --unattended --body "Agent task: pull code samples from the framework docs.")
run mv "$D1" doing >/dev/null
run mv "$D2" doing >/dev/null

# --- blocked (with real dependency so the blocked-by badge shows) ---
B1=$(mk "Ship the binary release" --effort high --body "Cut v0.2, attach dist/tasks to the GitHub release.")
run link "$B1" --depends-on "$D1" >/dev/null
run mv "$B1" blocked >/dev/null

# --- review ---
V1=$(mk "Review drag-and-drop PR" --effort medium --body "Check optimistic move + reconcile, keyboard sensor, toast on failure.")
run mv "$V1" review >/dev/null

# --- done ---
F1=$(mk "Scaffold the web toolchain" --effort medium --body "Vite + React 19 + Tailwind v4, deps isolated in web/package.json.")
F2=$(mk "Set up the git-backed store" --effort high)
run mv "$F1" done >/dev/null
run mv "$F2" done >/dev/null

echo
echo "Seeded demo store."
echo "  TASKS_HOME=$TASKS_HOME"
echo "  project=$PROJ"
echo
echo "Run the backend:"
echo "  cd $PROJ && TASKS_HOME=$TASKS_HOME bun run $REPO/src/cli.ts serve"
