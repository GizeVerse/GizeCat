#!/usr/bin/env bash
# GizeCat 1.4.0: ad-hoc macOS test builds from a Linux container (ADR 0004 §11, decision D11).
#
# Runs INSIDE a throwaway node:24-bookworm-slim container started by scripts/package-mac-docker.mjs,
# never on the host. Input: /stage/src.tar (git archive of the committed HEAD). Output: /stage/out.
#
# What it produces, and what it does not:
# - GizeCat-<version>-mac-x64-adhoc.zip and GizeCat-<version>-mac-arm64-adhoc.zip: 'Desktop Cat.app'
#   bundles built with `electron-builder --mac dir`, then re-signed AD HOC with rcodesign (no
#   identity, no hardened runtime, no notarization). Electron's fuses are flipped after packing,
#   which breaks the framework's original signature, and Apple Silicon refuses unsigned code, so the
#   ad-hoc re-sign is required. These are unsigned test builds, never a release: Gatekeeper blocks
#   them until the user allows them (System Settings > Privacy & Security > Open Anyway).
# - No DMG (dmgbuild is macOS-only) and no universal build (lipo is macOS-only): those, and every
#   Developer ID signed and notarized artifact, come from .github/workflows/macos-packages.yml.
# - A build is not a test: nothing here runs the app.
set -euo pipefail

STAGE=/stage
OUT="$STAGE/out"
WORK=/work
# apple-codesign (rcodesign) 0.29.0, MPL-2.0, prebuilt x86_64 Linux (musl) binary. The sha256 is the
# one published with the release (the .sha256 asset), checked before the archive is opened.
RCODESIGN_VERSION=0.29.0
RCODESIGN_TARBALL="apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl.tar.gz"
RCODESIGN_URL="https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${RCODESIGN_TARBALL}"
RCODESIGN_SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002

log() { printf '[mac-adhoc] %s\n' "$*"; }
die() { printf '[mac-adhoc] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$STAGE/src.tar" ] || die "missing $STAGE/src.tar"
[ "$(uname -m)" = "x86_64" ] || die "the pinned rcodesign binary is x86_64; this container runs $(uname -m)"
mkdir -p "$OUT"

log "installing tools (ca-certificates curl zip unzip)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl zip unzip >/dev/null

log "unpacking the source"
mkdir -p "$WORK"
tar -xf "$STAGE/src.tar" -C "$WORK"
cd "$WORK"
VERSION="$(node -p "require('./package.json').version")"
COMMIT="${GIZECAT_COMMIT:-unknown}"
log "version $VERSION, commit $COMMIT, node $(node --version)"

log "npm ci"
npm ci --ignore-scripts --no-audit --no-fund

log "building the JavaScript bundle"
node scripts/build.mjs

log "packaging 'Desktop Cat.app' for x64 and arm64 (dir target, unsigned)"
# No identity lookup (there is no keychain here), no publishing. electron-builder skips signing on
# a non-macOS host and logs that; the ad-hoc signature is added below.
CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac dir --x64 --arm64 --publish never

log "fetching rcodesign $RCODESIGN_VERSION"
curl -fsSL --retry 3 -o /tmp/rcodesign.tgz "$RCODESIGN_URL"
echo "$RCODESIGN_SHA256  /tmp/rcodesign.tgz" | sha256sum -c -
tar -xzf /tmp/rcodesign.tgz -C /tmp
RCODESIGN="/tmp/apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl/rcodesign"
[ -x "$RCODESIGN" ] || die "rcodesign not found at $RCODESIGN"
"$RCODESIGN" --version || true

# electron-builder's dir output: release/mac (x64) and release/mac-arm64 (arm64).
for pair in "mac:x64" "mac-arm64:arm64"; do
  dir="${pair%%:*}"
  arch="${pair##*:}"
  app="release/$dir/Desktop Cat.app"
  [ -d "$app" ] || die "missing $app"
  log "ad-hoc signing $app"
  # No key: an ad-hoc signature. rcodesign signs nested bundles and Mach-O files (helpers,
  # frameworks, crashpad handler, dylibs) recursively and in place.
  "$RCODESIGN" sign "$app"
  "$RCODESIGN" print-signature-info "$app/Contents/MacOS/Desktop Cat" > "/tmp/signature-$arch.txt" 2>&1 || true
  sed -n '1,30p' "/tmp/signature-$arch.txt"

  zip_name="GizeCat-${VERSION}-mac-${arch}-adhoc.zip"
  log "zipping $zip_name (-y keeps the framework symlinks)"
  rm -f "$OUT/$zip_name"
  (cd "release/$dir" && zip -q -r -y -X "$OUT/$zip_name" "Desktop Cat.app")
  links="$(zipinfo "$OUT/$zip_name" | grep -c '^l' || true)"
  [ "${links:-0}" -gt 0 ] || die "$zip_name has no symbolic links: Electron Framework's Versions/Current would be broken"
  log "$zip_name: $links symbolic links kept"
done

cat > "$OUT/README-adhoc.txt" <<EOF
GizeCat $VERSION for macOS: UNSIGNED AD-HOC TEST BUILDS, NOT NOTARIZED.

Built from commit $COMMIT in a Linux container (node:24-bookworm-slim) with
electron-builder --mac dir, then re-signed ad hoc with rcodesign $RCODESIGN_VERSION.
No Developer ID signature, no hardened runtime, no notarization. Never run here:
a build is not a test.

Files:
  GizeCat-$VERSION-mac-arm64-adhoc.zip  Apple Silicon
  GizeCat-$VERSION-mac-x64-adhoc.zip    Intel
  SHA256SUMS.txt                        sha256sum -c SHA256SUMS.txt

To try one on a Mac: unzip it, move "Desktop Cat.app" to /Applications, try to open it once,
then allow it in System Settings > Privacy & Security > Open Anyway (macOS 15 and later no longer
offer Control-click > Open). Alternatively, for a build you trust:
  xattr -dr com.apple.quarantine "/Applications/Desktop Cat.app"
The Keychain item "Desktop Cat Safe Storage" is tied to this exact build: every new ad-hoc build
asks for Keychain access again.
EOF

log "checksums"
(cd "$OUT" && sha256sum -- *.zip > SHA256SUMS.txt && cat SHA256SUMS.txt)
log "done"
