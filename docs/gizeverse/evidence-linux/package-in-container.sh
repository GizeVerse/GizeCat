#!/usr/bin/env bash
# GizeCat Linux packaging check inside a throwaway container (ADR 0004 §11-§12).
# Input: /in/src.tar, /in/x11check.py. Output: /out/summary.tsv, logs, artifacts list.
# Labels: building the packages is REAL; running the packaged app under Xvfb is SIMULATED_OR_MOCK_TESTED.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive CI=1 npm_config_fund=false npm_config_audit=false
OUT=/out
SUMMARY=$OUT/summary.tsv
: > "$SUMMARY"
note() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$SUMMARY"; echo "== $1: $2 ${3:-}"; }
run() { local name=$1; shift; if "$@" > "$OUT/$name.log" 2>&1; then note "$name" PASS; return 0; else local rc=$?; note "$name" FAIL "exit $rc"; return $rc; fi; }

run apt bash -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  ca-certificates xvfb xauth xcompmgr x11-utils xdotool python3 python3-xlib xz-utils file \
  libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libx11-xcb1 libdrm2 libxkbfile1 libsecret-1-0 libnotify4 procps' || exit 1
mkdir -p /work && tar -xf /in/src.tar -C /work && cd /work || exit 1
run npm-ci npm ci --ignore-scripts || exit 1
run electron-install node node_modules/electron/install.js || exit 1
run package-linux npm run package:linux || exit 1
( cd release && for f in *.AppImage *.tar.gz; do [ -f "$f" ] && printf '%s\t%s\t%s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; done ) > "$OUT/artifacts.tsv"
note artifacts "$( [ -s "$OUT/artifacts.tsv" ] && echo PASS || echo FAIL )" "$(cut -f1,2 "$OUT/artifacts.tsv" | tr '\n' ' ')"

TGZ=$(ls release/*.tar.gz | head -1)
mkdir -p /pkg && tar -xzf "$TGZ" -C /pkg
APPDIR=$(dirname "$(find /pkg -maxdepth 2 -name desktop-cat -type f | head -1)")
note packaged-exe "$( [ -x "$APPDIR/desktop-cat" ] && echo PASS || echo FAIL )" "$APPDIR/desktop-cat"
ls "$APPDIR/resources/app.asar.unpacked/node_modules/@koromix/" > "$OUT/koffi-unpacked.txt" 2>&1
grep -q koffi-linux-x64 "$OUT/koffi-unpacked.txt" && note koffi-linux-unpacked PASS || note koffi-linux-unpacked FAIL "$(cat "$OUT/koffi-unpacked.txt")"
chown -R node:node /pkg
chown root:root "$APPDIR/chrome-sandbox" && chmod 4755 "$APPDIR/chrome-sandbox"

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1 &
export DISPLAY=:99
for i in $(seq 1 50); do xdpyinfo > /dev/null 2>&1 && break; sleep 0.2; done
xcompmgr > "$OUT/xcompmgr.log" 2>&1 &
sleep 1

# Packaged app with the sandbox (user node, setuid helper): starts, overlays, test hooks ignored.
su node -s /bin/bash -c "DESKTOP_CAT_USER_DATA=/tmp/ud-pkg DESKTOP_CAT_TEST=1 timeout 25s '$APPDIR/desktop-cat' > $OUT/pkg-run.stdout.log 2>&1"
cat /tmp/ud-pkg/logs/*.log > "$OUT/pkg-run.log" 2>/dev/null || true
c() { local n; n=$(grep -c "\"m\":\"$1\"" "$OUT/pkg-run.log" 2>/dev/null); echo "${n:-0}"; }
note pkg-started "$( [ "$(c started)" -ge 1 ] && echo PASS || echo FAIL )" "started=$(c started) overlays=$(c 'overlay created')"
grep -o '"m":"starting","d":{[^}]*}' "$OUT/pkg-run.log" | head -1 > "$OUT/pkg-starting.txt"
grep -q '"packaged":true' "$OUT/pkg-starting.txt" && grep -q '"test":false' "$OUT/pkg-starting.txt" && note pkg-test-hooks-ignored PASS "packaged:true test:false despite DESKTOP_CAT_TEST=1" || note pkg-test-hooks-ignored FAIL "$(cat "$OUT/pkg-starting.txt")"
grep -o '"m":"platform capabilities","d":{.*}' "$OUT/pkg-run.log" | head -1 > "$OUT/pkg-capabilities.txt"
note pkg-capabilities "$( [ -s "$OUT/pkg-capabilities.txt" ] && echo PASS || echo FAIL )" "$(cut -c1-300 "$OUT/pkg-capabilities.txt")"
errs=$(grep -c '"l":"error"' "$OUT/pkg-run.log" || true)
note pkg-errors "$( [ "$errs" -eq 0 ] && echo PASS || echo WARN )" "error lines: $errs"

# Packaged app started with --no-sandbox: must refuse before creating anything (dialog, no log, no overlay).
su node -s /bin/bash -c "DESKTOP_CAT_USER_DATA=/tmp/ud-nosb timeout 12s '$APPDIR/desktop-cat' --no-sandbox > $OUT/pkg-nosandbox.stdout.log 2>&1" &
NS=$!
sleep 7
xwininfo -root -tree > "$OUT/pkg-nosandbox-tree.txt" 2>&1
wait $NS
rc=$?
# Electron prints a pre-ready error box to stderr on Linux (no window): judge by output, exit code and logs.
if grep -q 'GizeCat cannot start safely' "$OUT/pkg-nosandbox.stdout.log" && [ "$rc" -eq 1 ] && [ ! -d /tmp/ud-nosb/logs ]; then
  note pkg-no-sandbox-refused PASS "refusal printed, exit 1, no logger, no overlay"
else
  note pkg-no-sandbox-refused FAIL "exit $rc; see pkg-nosandbox.stdout.log"
fi
echo DONE
