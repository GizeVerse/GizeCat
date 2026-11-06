#!/usr/bin/env bash
# GizeCat Linux verification inside a throwaway container (ADR 0004 §12).
# Input:  /in/src.tar (git archive of the commit under test), /in/x11check.py
# Output: /out/*.log, /out/summary.tsv (step<TAB>status<TAB>detail), /out/x11-*.json
# Labels: the headless tiers are REAL on Linux (Debian 12 in Docker). Everything with Electron
# runs under Xvfb, a virtual X server without a desktop session: SIMULATED_OR_MOCK_TESTED.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive CI=1 npm_config_fund=false npm_config_audit=false
OUT=/out
SUMMARY=$OUT/summary.tsv
: > "$SUMMARY"
note() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$SUMMARY"; echo "== $1: $2 ${3:-}"; }
run() { local name=$1; shift; if "$@" > "$OUT/$name.log" 2>&1; then note "$name" PASS; return 0; else local rc=$?; note "$name" FAIL "exit $rc"; return $rc; fi; }

note image PASS "$(. /etc/os-release; echo "$PRETTY_NAME") node $(node --version) $(uname -m)"

run apt bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  ca-certificates xvfb xauth xcompmgr x11-utils xdotool python3 python3-xlib \
  libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libx11-xcb1 libdrm2 libxkbfile1 libsecret-1-0 libnotify4 procps' || exit 1

mkdir -p /work && tar -xf /in/src.tar -C /work && cd /work || exit 1
run npm-ci npm ci --ignore-scripts || exit 1
run electron-install node node_modules/electron/install.js || exit 1
run typecheck npm run typecheck
run lint npm run lint
run vitest npx vitest run
run build npm run build || exit 1

# --- Electron under Xvfb (SIMULATED desktop) ---------------------------------------------
# Try the Chromium sandbox first (setuid helper, non-root user); fall back to --no-sandbox only
# if it cannot start here, and record that (the packaged-build refusal cannot be shown then).
chown -R node:node /work
# After the recursive chown: the setuid helper must stay root-owned.
chown root:root node_modules/electron/dist/chrome-sandbox && chmod 4755 node_modules/electron/dist/chrome-sandbox
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 &
export DISPLAY=:99
for i in $(seq 1 50); do xdpyinfo > /dev/null 2>&1 && break; sleep 0.2; done
xdpyinfo > "$OUT/xdpyinfo.log" 2>&1 && note xvfb PASS "1920x1080x24" || { note xvfb FAIL; exit 1; }

EXTRA_FLAGS=""
probe_sandbox() {
  su node -s /bin/bash -c "cd /work && DESKTOP_CAT_USER_DATA=/tmp/ud-probe timeout 12s node_modules/electron/dist/electron . > $OUT/sandbox-probe.log 2>&1"
  if grep -q '"m":"starting"' /tmp/ud-probe/logs/*.log 2>/dev/null && ! grep -qiE 'sandbox.*(fail|not|error)|No usable sandbox' "$OUT/sandbox-probe.log"; then
    note sandbox PASS "Chromium sandbox on (setuid helper, user node)"
  else
    EXTRA_FLAGS="--no-sandbox"
    note sandbox WARN "sandbox could not start in this container; Electron runs use --no-sandbox (labelled)"
  fi
}
probe_sandbox

# One app run: $1 = phase name, $2 = seconds, then an optional command run in the background
# while the app is up (e.g. starting or killing the compositor).
app_run() {
  local phase=$1 secs=$2; shift 2
  local ud=/tmp/ud-$phase
  rm -rf "$ud"
  su node -s /bin/bash -c "cd /work && DESKTOP_CAT_USER_DATA=$ud timeout ${secs}s node_modules/electron/dist/electron . $EXTRA_FLAGS > $OUT/app-$phase.stdout.log 2>&1" &
  local pid=$!
  if [ $# -gt 0 ]; then "$@"; fi
  wait $pid
  cat "$ud"/logs/*.log > "$OUT/app-$phase.log" 2>/dev/null || true
}
# grep -c prints 0 itself when nothing matches (and exits 1): never append a second 0.
count() { local n; n=$(grep -c "\"m\":\"$2\"" "$OUT/app-$1.log" 2>/dev/null); echo "${n:-0}"; }

# A: no compositing manager -> the overlay must be withheld (review H3).
app_run nocomp 20
pa=$(grep -o '"m":"platform","d":{[^}]*}' "$OUT/app-nocomp.log" | head -1)
note platform-line "$( [ -n "$pa" ] && echo PASS || echo FAIL )" "$pa"
if [ "$(count nocomp 'overlays withheld')" -ge 1 ] && [ "$(count nocomp 'overlay created')" -eq 0 ]; then note phaseA-no-compositor PASS "withheld, 0 overlays"; else note phaseA-no-compositor FAIL "withheld=$(count nocomp 'overlays withheld') created=$(count nocomp 'overlay created')"; fi
python3 /in/x11check.py clickthrough 300 300 > "$OUT/x11-control-noapp.json" 2>&1
python3 /in/x11check.py clickthrough-blocked 300 300 > "$OUT/x11-control-blocked.json" 2>&1

# B: with xcompmgr -> overlays created, mapped, click-through away from the cat.
xcompmgr > "$OUT/xcompmgr.log" 2>&1 &
COMP=$!
sleep 1
phaseB() {
  sleep 14
  python3 /in/x11check.py overlays > "$OUT/x11-overlays.json" 2>&1
  python3 /in/x11check.py clickthrough 300 300 > "$OUT/x11-clickthrough.json" 2>&1
  # Chromium on X11 leaves a 1x1 input rectangle at the overlay origin (seen in run 1): measure it.
  python3 /in/x11check.py clickthrough 0 0 > "$OUT/x11-clickthrough-origin.json" 2>&1
  python3 /in/x11check.py clickthrough 1 1 > "$OUT/x11-clickthrough-1-1.json" 2>&1
  xwininfo -root -tree > "$OUT/x11-tree.txt" 2>&1
}
app_run comp 24 phaseB
if [ "$(count comp 'overlay created')" -ge 1 ]; then note phaseB-compositor PASS "overlays created=$(count comp 'overlay created')"; else note phaseB-compositor FAIL "created=0"; fi
grep -q '"clickReachedWindowBelow": true' "$OUT/x11-clickthrough.json" && note phaseB-click-through PASS "click at (300,300) reached the window below the overlay" || note phaseB-click-through FAIL "$(cat "$OUT/x11-clickthrough.json")"

# C: compositor dies while the app runs -> overlays withdrawn within the 10 s gate check.
phaseC() { sleep 12; kill $COMP 2>/dev/null; }
app_run compdies 30 phaseC
if [ "$(count compdies 'overlay created')" -ge 1 ] && [ "$(count compdies 'overlays withdrawn')" -ge 1 ]; then note phaseC-compositor-dies PASS "created then withdrawn"; else note phaseC-compositor-dies FAIL "created=$(count compdies 'overlay created') withdrawn=$(count compdies 'overlays withdrawn')"; fi

# D: errors across all runs
errs=$(cat "$OUT"/app-*.log 2>/dev/null | grep -c '"l":"error"' || true)
note app-errors "$( [ "$errs" -eq 0 ] && echo PASS || echo WARN )" "error lines: $errs"
grep -h '"l":"error"' "$OUT"/app-*.log > "$OUT/app-errors.log" 2>/dev/null || true
echo DONE
