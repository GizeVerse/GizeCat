// macOS packaging configuration (1.4.0, decisions D1, D9, D10, D11, D12), read statically: the
// mac section of electron-builder.yml, the entitlements, the manual signing workflow and the
// Linux-container ad-hoc route. Nothing here builds, signs or runs anything; a passing check says
// the files say what the design says, not that a Mac build works.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(root, ...p), 'utf8');

/** The indented block under a top-level key of electron-builder.yml. */
function ymlSection(yml: string, key: string): string {
  const lines = yml.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) throw new Error(`electron-builder.yml has no ${key}: section`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

const value = (section: string, key: string): string | undefined => new RegExp(`^[ \\t]+${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(section)?.[1];

describe('electron-builder.yml mac section', () => {
  const mac = ymlSection(read('electron-builder.yml'), 'mac');

  it('builds dmg and zip for x64, arm64 and universal, named GizeCat-*', () => {
    expect(mac).toMatch(/- target: dmg\s+arch: \[x64, arm64, universal\]/);
    expect(mac).toMatch(/- target: zip\s+arch: \[x64, arm64, universal\]/);
    expect(value(mac, 'artifactName')).toBe('GizeCat-${version}-mac-${arch}.${ext}');
  });

  it('signs with the hardened runtime and the repo’s own entitlements, and leaves notarize unset (env-driven)', () => {
    expect(value(mac, 'hardenedRuntime')).toBe('true');
    expect(value(mac, 'entitlements')).toBe('build/entitlements.mac.plist');
    expect(value(mac, 'entitlementsInherit')).toBe('build/entitlements.mac.inherit.plist');
    expect(mac).not.toMatch(/^\s+notarize:/m);
    expect(mac).not.toMatch(/^\s+identity:/m);
  });

  it('ships no native module on macOS: koffi and every @koromix package are excluded (floor-only, D1)', () => {
    expect(mac).toContain('"!node_modules/koffi/**"');
    expect(mac).toContain('"!node_modules/@koromix/**"');
    expect(mac).not.toMatch(/asarUnpack/);
  });

  it('replaces Electron’s camera, microphone, audio-capture and Bluetooth usage strings with honest text, and adds no screen-capture key (D9)', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription']) {
      expect(value(mac, key), key).toMatch(/^"GizeCat never /);
    }
    expect(mac).not.toMatch(/NSScreenCaptureUsageDescription|LSUIElement/);
  });
});

describe('entitlements (D10)', () => {
  for (const file of ['entitlements.mac.plist', 'entitlements.mac.inherit.plist']) {
    it(`${file}: com.apple.security.cs.allow-jit only`, () => {
      const plist = read('build', file);
      expect(plist).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
      const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
      expect(keys).toEqual(['com.apple.security.cs.allow-jit']);
      expect(plist).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
      expect(plist).not.toMatch(/disable-library-validation|allow-unsigned-executable-memory|device\./);
    });
  }
});

describe('.github/workflows/macos-packages.yml (D12)', () => {
  const wf = read('.github', 'workflows', 'macos-packages.yml');
  const on = /^on:\n([\s\S]*?)^\S/m.exec(wf)?.[1] ?? '';

  it('is manual only and marked as never started', () => {
    expect(wf).toMatch(/^# NEVER STARTED/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|release):/m);
    expect(wf).toMatch(/^permissions:\n {2}contents: read/m);
  });

  it('runs the Developer ID path in the protected macos-signing environment, never publishes, and removes the API key', () => {
    expect(wf).toMatch(/^ {4}environment: macos-signing$/m);
    expect(wf).not.toMatch(/--publish (always|onTag|onTagOrDraft)/);
    expect((wf.match(/--publish never/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(wf).toMatch(/if: always\(\)\n\s+run: rm -f "\$RUNNER_TEMP\/AuthKey\.p8"/);
    // The only release access: an optional job that uploads to an existing DRAFT (checked first),
    // never creating, editing, deleting or replacing anything.
    expect(wf).not.toMatch(/softprops\/action-gh-release|gh release (create|edit|delete)|--clobber/);
    expect(wf).toMatch(/gh release view "\$TAG" --json isDraft/);
    expect(wf.indexOf('gh release view "$TAG" --json isDraft')).toBeLessThan(wf.indexOf('gh release upload "$TAG"'));
  });
});

describe('Linux-container ad-hoc route (D11)', () => {
  const sh = read('scripts', 'docker', 'mac-adhoc-build.sh');
  const host = read('scripts', 'package-mac-docker.mjs');

  it('the container script fails fast, pins rcodesign by sha256 and keeps symlinks in the zips', () => {
    expect(sh).toMatch(/^set -euo pipefail$/m);
    expect(sh).toContain('RCODESIGN_VERSION=0.29.0');
    expect(sh).toContain('RCODESIGN_SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002');
    expect(sh).toMatch(/sha256sum -c -/);
    expect(sh).toContain('zip -q -r -y -X');
    expect(sh).toContain('--mac dir --x64 --arm64 --publish never');
    expect(sh).toContain('-adhoc.zip');
    expect(sh).not.toMatch(/\r/);
  });

  it('the host script builds from a committed HEAD in one uniquely named, removed container and never touches other containers', () => {
    expect(host).toContain("'--untracked-files=no'");
    expect(host).toContain("'archive', '--format=tar'");
    expect(host).toContain('gizecat-mac-adhoc-${Date.now()}');
    expect(host).toContain("'--rm'");
    expect(host).toContain("'node:24-bookworm-slim'");
    expect(host).toMatch(/release', version, 'mac'/);
    expect(host).not.toMatch(/'prune'|'ps'|system prune|image rm|rmi/);
    // No shell: arguments go straight to git and docker.
    expect(host).not.toMatch(/shell:\s*true/);
  });
});
