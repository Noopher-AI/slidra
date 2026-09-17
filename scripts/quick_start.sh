#!/usr/bin/env bash
#
# quick_start.sh — one-command launcher for the Slidra frontend, for manual
# acceptance testing.
#
# What it does:
#   1. Sync dependencies (including any new ones added to a workspace)
#   2. Build server (tsc -b) and web (Next.js static export), plus the Rust binary
#   3. Check preconditions (build artifacts, CLI executable, agent adapter)
#   4. Prepare a presentation (the demo deck, or a blank one with --blank)
#   5. Run slidra serve, open a browser to look at it
#
# Two ways to prepare a presentation:
#   - Default (no flag): packs docs/demo/ into a demo presentation, four slides,
#     three assets (an image, a video, an audio file), two of which carry an
#     effect list. Used to verify **existing behavior still works** — page
#     navigation, assets, playback, effects, rewind, fullscreen all need
#     ready-made content to verify against. To change the test material, edit
#     docs/demo/, then rerun with --fresh.
#   - --blank: creates a brand-new blank presentation. Used to verify **the
#     from-scratch path** — new presentation creation, the first element
#     insertion, the empty-state screen, an agent's first command against a
#     blank presentation.
#
# Usage:
#   ./scripts/quick_start.sh                      # fully automatic, demo presentation
#   ./scripts/quick_start.sh --blank              # fully automatic, blank presentation
#   ./scripts/quick_start.sh --port 6000          # change the port
#   ./scripts/quick_start.sh --agent claude       # pick an agent (recommended when several are detected)
#   ./scripts/quick_start.sh --agent pi          # use Pi with the local OpenAI-compatible Qwen endpoint
#   ./scripts/quick_start.sh --fresh              # discard the old presentation, recreate it
#   ./scripts/quick_start.sh --skip-build         # skip the build (don't use this when you only changed frontend source)
#   ./scripts/quick_start.sh --open               # also open a browser (default: don't)
#   ./scripts/quick_start.sh --no-open            # kept for existing invocations; already the default behavior
#   ./scripts/quick_start.sh --qa --no-open       # sandbox QA layer: starts serve + headless
#                                         #   Chromium in the background, writes the env file browser-use uses
#   ./scripts/quick_start.sh --qa-stop            # tears down the background serve and Chromium left by --qa

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT=5173
AGENT=""
FRESH=0
SKIP_BUILD=0
# Default to not opening a browser: this script is often rerun repeatedly
# (change a line, rerun verification, change another line), and opening a new
# tab every time leaves a pile of tabs pointing at the same URL, most of them
# carrying a stale presentation id. Add --open yourself if you want one.
OPEN_BROWSER=0
BLANK=0
QA=0
QA_STOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port requires a value}"; shift 2 ;;
    --agent) AGENT="${2:?--agent requires a value}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --open) OPEN_BROWSER=1; shift ;;
    # Already the default; the flag itself is kept so existing invocations and docs (qa/README.md) don't break.
    --no-open) OPEN_BROWSER=0; shift ;;
    --blank) BLANK=1; shift ;;
    --qa) QA=1; shift ;;
    --qa-stop) QA_STOP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

CLI="$ROOT/node_modules/.bin/slidra"
DEMO_SOURCE="$ROOT/docs/demo"
DEMO_DIR="$ROOT/.quickstart"
DEMO_SLIDRA="$DEMO_DIR/demo.slidra"
DEMO_ID_FILE="$DEMO_DIR/presentation-id"
BLANK_SLIDRA="$DEMO_DIR/blank.slidra"
BLANK_ID_FILE="$DEMO_DIR/blank-presentation-id"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

# --qa / --qa-stop shared state -----------------------------------------------
# Sandbox QA layer: --qa starts an extra serve + headless Chromium in the
# background after the normal flow (steps 1-4), for browser-use to drive;
# --qa-stop tears them down. These two flags don't change any behavior in
# steps 1-4.
QA_DIR="$ROOT/.quickstart/qa"
QA_SERVE_PGID_FILE="$QA_DIR/serve.pgid"
QA_CHROMIUM_PGID_FILE="$QA_DIR/chromium.pgid"
QA_ENV_FILE="$QA_DIR/qa.env"
QA_SERVE_LOG="$QA_DIR/serve.log"
QA_CDP_PORT="${SLIDRA_QA_CDP_PORT:-9222}"

# Tears down the process group recorded in a pgid file: TERM, wait up to 5
# seconds, KILL if it's still alive. slidra serve spawns an independent
# node child process (not exec), so killing just the wrapper doesn't take
# down the server; --qa starts it via setsid and records the whole process
# group's PGID, so signaling the whole group here is what actually cleans it
# up.
qa_kill_pgid_file() {
  local pgid_file="$1"
  [ -f "$pgid_file" ] || return 1
  local pgid
  pgid="$(cat "$pgid_file")"
  if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    local waited=0
    while [ "$waited" -lt 5 ] && kill -0 -- "-$pgid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    kill -0 -- "-$pgid" 2>/dev/null && kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  rm -f "$pgid_file"
  return 0
}

# Teardown should never fail just because things were already clean, so it
# always exits 0.
qa_stop() {
  local found=0
  qa_kill_pgid_file "$QA_SERVE_PGID_FILE" && found=1
  qa_kill_pgid_file "$QA_CHROMIUM_PGID_FILE" && found=1
  rm -f "$QA_ENV_FILE"
  if [ "$found" -eq 0 ]; then
    echo "No QA environment was running."
  else
    echo "QA environment torn down."
  fi
}

if [ "$QA_STOP" -eq 1 ] && [ "$QA" -eq 0 ]; then
  qa_stop
  exit 0
fi

if [ "$QA" -eq 1 ]; then
  # Check that browser-use is on PATH before spending time on a build — it's
  # provided by the workspace's sandbox tools mount (/opt/sandbox), not an npm
  # dependency and not this project's Dockerfile's responsibility, and a
  # missing binary shouldn't make someone wait through a whole build before
  # seeing this error.
  if ! command -v browser-use >/dev/null 2>&1; then
    echo "browser-use not found: it should be provided by the workspace's sandbox tools mount (/opt/sandbox), not an npm dependency of this project nor .devcontainer/Dockerfile's responsibility. Confirm the runtime environment has /opt/sandbox mounted." >&2
    exit 1
  fi
  if [ "$QA_STOP" -eq 1 ]; then
    # Given together with --qa: treated as "stop first, then start".
    qa_stop
  elif [ -f "$QA_SERVE_PGID_FILE" ] || [ -f "$QA_CHROMIUM_PGID_FILE" ]; then
    echo "Detected an existing QA environment, tearing it down before restarting." >&2
    qa_stop
  fi
  mkdir -p "$QA_DIR"
fi

# 1. Dependencies -------------------------------------------------------------
# Switching branches can change just a workspace's package.json or the
# lockfile; node_modules' own timestamp doesn't prove the last install
# actually finished. Let npm sync the whole dependency tree.
step "Syncing dependencies"
npm install

# 2. Build --------------------------------------------------------------------
# serve only serves packages/web/dist's static files, with no framework dev server
# proxy (ADR-0002), so the frontend must be rebuilt after every change to see
# it.
if [ "$SKIP_BUILD" -eq 0 ]; then
  step "Building server / web / Rust CLI"
  npm run build
fi

if [ ! -f "$ROOT/packages/web/dist/index.html" ]; then
  echo "packages/web/dist does not exist — run npm run build first (or rerun without --skip-build)." >&2
  exit 1
fi

# 3. Preconditions --------------------------------------------------------------
# node_modules/.bin/slidra is a link to the Rust artifact
# (target/release/slidra), created only by scripts/link-cli.mjs as the last
# step of npm run build.
if [ ! -x "$CLI" ]; then
  echo "No executable node_modules/.bin/slidra found (it should point at cargo build's output, target/release/slidra). Run npm run build and retry." >&2
  exit 1
fi

step "Checking agent"
# All adapters (claude-code-acp / codex-acp / pi-acp) are ordinary npm dependencies of
# @slidra/server, installed together with step 1's npm install — no
# separate global install or PATH probing needed. Which one to use is a
# user-level setting (settings.json) or a one-time override via --agent; when
# none is chosen, serve still starts normally, only the chat feature waits
# until one is selected.
if [ -n "$AGENT" ] && [ "$AGENT" != "claude" ] && [ "$AGENT" != "codex" ] && [ "$AGENT" != "pi" ]; then
  echo "--agent must be claude, codex, or pi." >&2
  exit 1
fi

# 4. Presentation ---------------------------------------------------------------
if [ "$FRESH" -eq 1 ]; then
  rm -rf "$DEMO_DIR"
fi
mkdir -p "$DEMO_DIR"

if [ "$BLANK" -eq 1 ]; then
  if [ ! -f "$BLANK_SLIDRA" ]; then
    step "Creating a blank presentation"
    "$CLI" new "$BLANK_SLIDRA" --name "Blank Presentation"
  fi

  if [ ! -s "$BLANK_ID_FILE" ]; then
    step "Opening the blank presentation to get its id"
    # open prints one message line, then { "id": "..." }; only the id field is kept.
    "$CLI" open "$BLANK_SLIDRA" \
      | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*"\([^"]*\)"$/\1/' > "$BLANK_ID_FILE"
  fi

  PRESENTATION_ID="$(cat "$BLANK_ID_FILE")"
  if [ -z "$PRESENTATION_ID" ]; then
    echo "Could not get the presentation id — rerun with --fresh." >&2
    exit 1
  fi
else
  # docs/demo/ being newer than the packed .slidra means the source material has
  # changed. The manual-verification path never repacks automatically —
  # repacking requires reopening, which would issue a new presentation id and
  # invalidate any URL or terminal command the user is already holding.
  #
  # --qa doesn't have this concern (it rewrites SLIDRA_QA_PRESENTATION_ID in
  # the QA env file on every run, so nobody is holding onto an old URL), and a
  # stale deck is a real hazard on the QA path: an agent would run case
  # scripts against old material, and every PASS/FAIL would reflect the wrong
  # presentation content, with the only clue being the stderr note below. This
  # has previously caused several rounds of running a case against a stale
  # demo deck with a full-bleed background rect, misdiagnosing an environment
  # problem — a blank-area drag always being read as a move gesture — as
  # browser-use/CDP flakiness. So --qa just repacks unconditionally, leaving
  # no room to trip over this.
  if [ -f "$DEMO_SLIDRA" ] && [ -n "$(find "$DEMO_SOURCE" -newer "$DEMO_SLIDRA" -type f -print -quit)" ]; then
    if [ "$QA" -eq 1 ]; then
      step "docs/demo/ is newer than the demo presentation, repacking (--qa)"
      rm -f "$DEMO_SLIDRA" "$DEMO_ID_FILE"
    else
      echo "Note: docs/demo/ has been modified, but the demo presentation is still the old one — rerun with --fresh to apply the change." >&2
    fi
  fi

  if [ ! -f "$DEMO_SLIDRA" ]; then
    step "Packing the demo presentation (docs/demo/ -> .slidra)"
    # There is no CLI command to pack a directory into a .slidra (see
    # docs/spec/cli.md's `pack` entry — that packs an already-open
    # presentation, not an arbitrary directory), so call
    # scripts/pack-directory.mjs directly.
    node "$ROOT/scripts/pack-directory.mjs" "$DEMO_SOURCE" "$DEMO_SLIDRA"
  fi

  if [ ! -s "$DEMO_ID_FILE" ]; then
    step "Opening the demo presentation to get its id"
    # open prints one message line, then { "id": "..." }; only the id field is kept.
    "$CLI" open "$DEMO_SLIDRA" \
      | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | sed 's/.*"\([^"]*\)"$/\1/' > "$DEMO_ID_FILE"
  fi

  PRESENTATION_ID="$(cat "$DEMO_ID_FILE")"
  if [ -z "$PRESENTATION_ID" ]; then
    echo "Could not get the presentation id — rerun with --fresh." >&2
    exit 1
  fi
fi

# S9 checklist steps -----------------------------------------------------------
# Shared between the demo and --blank checklists below: Deck Space, continuous
# save, the agent sandbox boundary, master view mode, and chat/undo history
# persistence all behave the same regardless of which deck is currently open.
# $PRESENTATION_ID is set above in both branches; this heredoc is deliberately
# unquoted so it expands.
S9_CHECKLIST="$(cat <<S9EOF
Deck Space (workspace entry, deck creation/switching/deletion)
  - Click the "Deck Space" button in the title bar: it opens as a full-screen overlay; the currently
    open deck's card shows a "Current" badge.
  - Click "New deck": a new deck appears in the list; click its card to switch into it — the title bar's
    deck name changes and the "Current" badge moves to the new deck.
  - On a deck that is NOT current, click its trash "Delete" icon, then "Confirm delete": the card
    disappears from the list. (Delete/Rename are disabled on the current deck itself — switch away first.)
  - Click "Close" (only shown once a deck is open) to return to the editor on the deck you started with.
Continuous save
  - Edit an element (e.g. type "change the title to Q3 Report" in the chat box, or drag an element):
    the status next to the deck name in the title bar shows "Saving…" then "Saved" within about a
    second. There is no manual Save button any more.
  - Force a save failure: make an edit, then immediately (within about a second, before the "Saving…"
    debounce fires) chmod 444 the open deck's .slidra file (path printed above) from another terminal —
    the status shows "Save failed" and a banner reading "Permission denied writing <filename>." with a
    "Retry" button appears. (chmod-ing the file before editing just makes the edit itself fail outright,
    since the deck file is a live SQLite database — it does not exercise this banner.)
  - chmod 644 the file back to writable, click "Retry": the banner disappears and the status returns to
    "Saved".
Agent sandbox boundary
  - In the chat box, ask the agent to run a shell command that writes outside its sandbox, e.g.
    "run: echo test > ~/slidra-escape-test.txt".
  - The command fails (non-zero exit, reported back through the chat) and the file is never created —
    confirm from a separate terminal:
        ls ~/slidra-escape-test.txt
    (expect "No such file or directory"). The refusal happens at the OS level (Landlock/Seatbelt),
    not a string-based command filter.
Master view mode
  - In the left rail, click "Edit template" (disabled with the tooltip "Save a slide as a template
    first" if no template exists yet — ask the agent to save the current slide as a template first
    in that case).
  - The button becomes "Back to slides", the rail switches to listing templates, and a bar reads
    "Editing this template. Existing slides don't change until you use the action below." with a
    "Let the agent update the slides" button. Drag-reorder is disabled while in this mode.
  - Edit the template, then click "Let the agent update the slides": the agent runs and propagates the
    change to the real slides that use the template.
  - Click "Back to slides": the slides that used the template now show the propagated change.
Chat and undo history surviving a restart
  - In the chat box, make one more edit (e.g. "change the title to Persistence Check"), then press
    Ctrl+C to stop this script.
  - Relaunch the same command (same presentation id — don't pass --fresh): the chat panel shows the
    same conversation on load, and Ctrl+Z (undo) still reverts the edit made just before the restart.
  - Cross-check from the terminal — this should print the same entries before and after the restart:
        node_modules/.bin/slidra chat-history $PRESENTATION_ID
Agent-switch divider
  - Switch the connected agent mid-conversation (via the agent picker in the side panel), or click the
    "New session" ("+") button: the chat thread inserts a system divider message, e.g. "Switched to
    <Agent>. It will handle messages from here. Above is the conversation before it joined — the agent
    has no memory of it; it can read it back with slidra chat-history if it needs to." ("Started a new
    conversation. ..." for "New session".)
S9EOF
)"

# 5. Launch ---------------------------------------------------------------
SERVE_ARGS=("serve" "$PRESENTATION_ID" "--port" "$PORT")
if [ -n "$AGENT" ]; then
  SERVE_ARGS+=("--agent" "$AGENT")
fi

# The agent runs `slidra ...` (that's how the editing contract specifies
# it), and its shell inherits environment variables from the serve process.
# The project has no globally installed CLI, so the workspace's
# node_modules/.bin must be added to PATH — without this, the agent would get
# "command not found: slidra" and be completely unable to edit the
# presentation.
export PATH="$ROOT/node_modules/.bin:$PATH"

step "Verifying PATH"
RESOLVED="$(command -v slidra || true)"
if [ "$RESOLVED" != "$CLI" ]; then
  echo "PATH fixup failed: slidra resolved to \"${RESOLVED:-(not found)}\", expected ${CLI}." >&2
  exit 1
fi
# slidra has no --help; invoking it with no arguments confirms it actually
# ran (the Rust binary itself prints "missing command name" and exits
# non-zero, it no longer falls back to Node) rather than the shell treating
# it as command not found.
INVOKE_OUTPUT="$(slidra 2>&1 || true)"
if printf '%s' "$INVOKE_OUTPUT" | grep -qi "command not found"; then
  echo "slidra failed to run — the agent would get command not found." >&2
  exit 1
fi
echo "slidra is available: $RESOLVED"

URL="http://127.0.0.1:$PORT"

if [ "$QA" -eq 1 ]; then
  : # --qa doesn't print the manual verification checklist (it takes the background-launch path further down instead).
elif [ "$BLANK" -eq 1 ]; then
  cat <<INFO

Presentation id: $PRESENTATION_ID
Presentation file: $BLANK_SLIDRA
URL: $URL

Verification checklist (blank presentation, verifying the from-scratch path):
  - The screen opens to a blank presentation with no slides at all (a new presentation has zero pages); the stage has no white background, just a single centered line of white text reading "No slides now".
  - Click New -> From outline... and paste in an outline: the message starts with /slidra-plan, and after the agent writes out
    plan/outline.md and plan/design-spec.md, the editor pops up a blocking plan-confirmation dialog.
  - Each question in the dialog defaults to the agent's suggestion, and can be switched or freely edited; after clicking "Confirm and build" the agent runs
    /slidra-build to build the whole deck from page 1, register templates, and fix errors down to zero with slidra validate.
  - Type a command to create an element in the chat box (e.g. "add a title text"), and the agent edits the file via the CLI —
    the screen updates automatically with the new element showing up: this is the first command ever issued against this presentation.
  - View the same content from the terminal:
      node_modules/.bin/slidra cat $PRESENTATION_ID project.json

$S9_CHECKLIST

Other:
  - Press Ctrl+C to stop.

INFO
else
cat <<INFO

Presentation id: $PRESENTATION_ID
Demo presentation file: $DEMO_SLIDRA
URL: $URL

Verification checklist (covering what's done so far):
  Page navigation
    - The screen shows page 1, "Acceptance Demo Deck", with 1 / 4 shown at the bottom right.
    - Press > or the right arrow key to move to pages 2, 3, 4; at the end the button greys out and pressing again does nothing and doesn't crash.
    - Pressing arrow keys while the cursor is in the chat input box should move the cursor, not change pages.
  Assets
    - Page 2's blue square image renders (its relative path is resolved to /api/raw/ via <base>).
    - A Range request should return 206 and Content-Range:
        curl -si -H 'Range: bytes=0-9' $URL/api/raw/assets/photo.svg | head -5
    - An invalid Range should return 416:
        curl -si -H 'Range: bytes=99999999-' $URL/api/raw/assets/photo.svg | head -3
  Live preview
    - Edit the content from a separate terminal — the screen should update without a full reload, and should stay on whichever page you're currently viewing:
        node_modules/.bin/slidra text set $PRESENTATION_ID slides/001.svg el-title "Q3 Report"
  Agent chat
    - Type "change the title on page one to Q3 Report" in the chat box — the agent edits the file via the CLI, and the screen updates automatically.
    - The screen shows no tool-progress indicator while the agent runs a command — it's normal for it to look stalled until the agent replies.
  Overview
    - The left side shows real thumbnails of every page in order; clicking one jumps to that page, and the current page is visually distinguishable.
  Play mode
    - Go to page 1 and click "Play": press the right arrow key repeatedly from the start without leaving the screen.
    - Pages 1 and 2 have no effect list, so pressing the right arrow key once moves straight to the next page.
    - Page 3 (the one with an effect list): the screen doesn't flash the full content immediately — the three lines
      "Step One", "Step Two", "Step Three" start hidden, while the title stays visible.
      Pressing the right arrow key reveals the three lines one at a time, one per press; after all three steps, pressing
      again moves to page 4.
  - Clicking elsewhere on the screen (e.g. the chat input box) to steal focus should clearly indicate "focus is not on the player",
      with a button provided to click back into it.
    - Clicking "Exit playback" returns to view mode, and arrow keys resume changing pages instead of advancing steps.
  Fullscreen toggle
    - In play mode there is a "Fullscreen" button (not present in view mode).
    - Clicking it makes the whole playback screen (including the control bar) fill the display, and the button label changes to "Exit fullscreen";
      arrow-key advancement and button clicks both keep working while in fullscreen.
    - Pressing Esc or the button again returns to inline playback without leaving play mode.
  Audio/video effects (page 4)
    - After completing the three steps on page 3, pressing the right arrow key once more moves to page 4, "Media".
    - The caption text "Key point" starts hidden, and fades in on the right arrow key.
    - Pressing again swaps the video placeholder block for the actual playing video, aligned to where the placeholder was.
    - Pressing again starts narration audio playing next to the speaker icon (no visible change, but the browser tab's mute icon,
      or the devtools Elements panel, will show an extra <audio> element playing).
    - This is now the final step of the whole presentation; pressing the right arrow key again does nothing and doesn't crash.
  Rewind (continuing from the last step of page 4 above, pressing the left arrow key repeatedly)
    - Press the left arrow key once: this only rewinds to the step right before "narration audio started" — the screen stays on page 4,
      and both the video and the narration audio disappear (not paused, fully removed), with no sound at all.
    - Press again: rewinds to the "caption fade-in" step itself, still on page 4.
    - Press again: crosses back to page 3, and page 3 appears as if it had "played all the way through" —
      "Step One", "Step Two", "Step Three" are all visible, not page 3's blank starting state.
    - Pressing the left arrow key once more on page 3: only "Step Three" disappears; "Step One" and "Step Two"
      remain visible — confirming it rewinds one step at a time, not the whole page at once.
    - Continuing to press the left arrow key rewinds through pages 2 and 1 in order; a page with no effect list
      crosses in a single press.
    - Once rewound all the way to the very start of page 1, pressing the left arrow key again does nothing and doesn't crash.
    - Throughout the whole rewind: no error message ever appears on screen, and no video or audio
      is left playing.

$S9_CHECKLIST

Other:
  - View the same content from the terminal:
      node_modules/.bin/slidra cat $PRESENTATION_ID slides/001.svg
  - Press Ctrl+C to stop.

INFO
fi

if [ "$QA" -eq 0 ] && [ "$OPEN_BROWSER" -eq 1 ] && command -v open >/dev/null 2>&1; then
  # Only open the browser once serve has successfully bound, to avoid opening a page that isn't up yet.
  ( sleep 2; open "$URL" ) &
fi

# 5. Launch ---------------------------------------------------------------------
if [ "$QA" -eq 0 ]; then
  step "Starting slidra serve"
  exec "$CLI" "${SERVE_ARGS[@]}"
fi

# --qa: start serve in the background, poll until it responds, then start
# headless Chromium, and finally write the env file and run browser-use
# --doctor as a smoke test. Unlike the non---qa path, this one must let the
# script finish on its own (the requirement being "one command finishes
# completely"), so exec isn't used here.
step "Starting slidra serve (QA, background)"

qa_wait_http() {
  local url="$1" timeout_s="$2" waited=0
  while [ "$waited" -lt "$timeout_s" ]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

setsid bash -c '
  echo $$ > "$1"
  shift
  exec "$@"
' _ "$QA_SERVE_PGID_FILE" "$CLI" "${SERVE_ARGS[@]}" > "$QA_SERVE_LOG" 2>&1 &
disown

if ! qa_wait_http "$URL/" 60; then
  echo "slidra serve did not respond at $URL/ within 60 seconds. Last 20 lines of serve.log:" >&2
  tail -n 20 "$QA_SERVE_LOG" >&2 || true
  exit 1
fi
echo "serve is ready: $URL"

step "Resolving Chromium's path"
CHROMIUM="$(node -e "console.log(require('playwright').chromium.executablePath())")"
if [ ! -x "$CHROMIUM" ]; then
  echo "Chromium executable does not exist or is not executable: ${CHROMIUM}. Run npx playwright install chromium and retry." >&2
  exit 1
fi
echo "Chromium: $CHROMIUM"

step "Starting headless Chromium (QA, background)"
if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$QA_CDP_PORT/json/version" 2>/dev/null | grep -q '^200$'; then
  echo "CDP port $QA_CDP_PORT is already in use. Set the SLIDRA_QA_CDP_PORT environment variable to use a different port." >&2
  exit 1
fi

CHROMIUM_PROFILE_DIR="$QA_DIR/profile"
mkdir -p "$CHROMIUM_PROFILE_DIR"
CHROMIUM_LOG="$QA_DIR/chromium.log"

setsid bash -c '
  echo $$ > "$1"
  shift
  exec "$@"
' _ "$QA_CHROMIUM_PGID_FILE" "$CHROMIUM" \
  --headless=new --no-sandbox \
  "--remote-debugging-port=$QA_CDP_PORT" \
  --window-size=1440,900 \
  "--user-data-dir=$CHROMIUM_PROFILE_DIR" \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  about:blank > "$CHROMIUM_LOG" 2>&1 &
disown

if ! qa_wait_http "http://127.0.0.1:$QA_CDP_PORT/json/version" 30; then
  echo "Chromium did not open the CDP port ${QA_CDP_PORT} within 30 seconds. Last 20 lines of chromium.log:" >&2
  tail -n 20 "$CHROMIUM_LOG" >&2 || true
  exit 1
fi
echo "Chromium CDP is ready: 127.0.0.1:$QA_CDP_PORT"

step "Writing the QA env file"
cat > "$QA_ENV_FILE" <<ENV
export BU_CDP_URL="http://127.0.0.1:$QA_CDP_PORT"
export BH_AGENT_WORKSPACE="$ROOT/qa"
export SLIDRA_QA_URL="$URL"
export SLIDRA_QA_PRESENTATION_ID="$PRESENTATION_ID"
export BH_RUNTIME_DIR="/tmp/slidra-qa-$(id -u)"
export BH_TMP_DIR="$QA_DIR/tmp"
export SLIDRA_QA_CDP_PORT="$QA_CDP_PORT"
ENV
mkdir -p "$QA_DIR/tmp"
echo "Written: $QA_ENV_FILE"

step "Opening Slidra (via qa/agent_helpers.py's open_deck())"
# `browser-use --doctor` is a read-only diagnostic and doesn't start the
# daemon itself (the daemon only starts when running an actual script, via
# ensure_daemon(), see browser_harness/run.py). Doctor is expected to report
# that the active page is Slidra, so a script that navigates to
# SLIDRA_QA_URL is run first here — accomplishing both "start the daemon"
# and "open Slidra" together — before running the doctor check.
set +e
DOCTOR_OPEN_OUTPUT="$( set -a; source "$QA_ENV_FILE"; set +a; browser-use <<'PY' 2>&1
print(open_deck())
PY
)"
DOCTOR_OPEN_RC=$?
set -e
if [ "$DOCTOR_OPEN_RC" -ne 0 ]; then
  echo "Failed to open Slidra (exit code ${DOCTOR_OPEN_RC}):" >&2
  echo "$DOCTOR_OPEN_OUTPUT" >&2
  echo "The QA environment has been left running (.quickstart/qa/) — tear it down with --qa-stop, or troubleshoot from the output above and rerun." >&2
  exit "$DOCTOR_OPEN_RC"
fi
echo "$DOCTOR_OPEN_OUTPUT"

step "browser-use --doctor"
set +e
( set -a; source "$QA_ENV_FILE"; set +a; browser-use --doctor )
DOCTOR_RC=$?
set -e

if [ "$DOCTOR_RC" -ne 0 ]; then
  echo "browser-use --doctor reported a problem (exit code ${DOCTOR_RC}). The QA environment has been left running (.quickstart/qa/) — tear it down with --qa-stop, or troubleshoot from the output above and rerun." >&2
  exit "$DOCTOR_RC"
fi

cat <<QAINFO

QA environment is ready.
  source $QA_ENV_FILE
  browser-use < qa/cases/smoke.py

To tear down:
  ./scripts/quick_start.sh --qa-stop

QAINFO
