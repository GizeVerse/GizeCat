// GizeVerse capability model (ADR 0004 §2): the declared table is the project's claim, so its
// honesty rules are tested like code.
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_IDS,
  CAPABILITY_MATRIX,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  UNREACHABLE_PLATFORMS,
  VERIFICATION_STATUSES,
  declaredRuntime,
  isImplemented,
  resolvePlatformId,
  type PlatformProbe,
} from '../../../src/shared/platform';

const probe = (over: Partial<PlatformProbe>): PlatformProbe => ({ os: 'linux', waylandDisplay: false, x11Display: false, ozonePlatform: null, ...over });

describe('capability table: honesty rules', () => {
  it('has a claim with a known status and a note for every platform and capability', () => {
    for (const p of PLATFORM_IDS) {
      expect(PLATFORM_LABELS[p]).toBeTruthy();
      for (const c of CAPABILITY_IDS) {
        const claim = CAPABILITY_MATRIX[p][c];
        expect(claim, `${p}.${c}`).toBeDefined();
        expect(VERIFICATION_STATUSES).toContain(claim.status);
        expect(claim.note.length, `${p}.${c} note`).toBeGreaterThan(5);
      }
      expect(Object.keys(CAPABILITY_MATRIX[p]).sort()).toEqual([...CAPABILITY_IDS].sort());
    }
  });

  it('never claims local verification on a platform this machine cannot run', () => {
    for (const p of UNREACHABLE_PLATFORMS) {
      for (const c of CAPABILITY_IDS) expect(CAPABILITY_MATRIX[p][c].status, `${p}.${c}`).not.toBe('IMPLEMENTED_AND_LOCALLY_VERIFIED');
    }
    // macOS, every Linux desktop and both mobile OSes are out of reach here (ADR 0004 §12, review L2).
    expect([...UNREACHABLE_PLATFORMS].sort()).toEqual(['android', 'darwin', 'ios', 'linux-wayland', 'linux-x11', 'linux-xwayland']);
  });

  it('backs every locally verified or simulated claim with a report anchor', () => {
    for (const p of PLATFORM_IDS) {
      for (const c of CAPABILITY_IDS) {
        const claim = CAPABILITY_MATRIX[p][c];
        if (claim.status === 'IMPLEMENTED_AND_LOCALLY_VERIFIED' || claim.status === 'SIMULATED_OR_MOCK_TESTED') {
          expect(claim.evidence, `${p}.${c}`).toMatch(/^docs\/.+\.md(#.+)?$/);
        }
      }
    }
  });

  it('keeps the overlay off where it could block the desktop (native Wayland, XWayland, every in-page host)', () => {
    for (const p of ['linux-wayland', 'linux-xwayland', 'web', 'ios'] as const) {
      expect(CAPABILITY_MATRIX[p].overlay.status, p).toBe('BLOCKED_BY_PLATFORM_OR_PERMISSION');
    }
  });

  it('Android 1.4.0 preview 2 draws a small overlay window behind a permission: implemented, never verified on a device', () => {
    // A native app, not an in-page host: its overlay is a small window, not a click-through screen.
    expect(CAPABILITY_MATRIX.android.overlay.status).toBe('IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED');
    expect(CAPABILITY_MATRIX.android.overlay.note).toContain('Display over other apps');
    // Exact click-through stays blocked: Android has no input region for an app window.
    expect(CAPABILITY_MATRIX.android.clickThrough.status).toBe('BLOCKED_BY_PLATFORM_OR_PERMISSION');
  });

  it('declares perception fail-closed off Windows, and login items implemented on Windows and macOS only', () => {
    for (const p of PLATFORM_IDS) {
      if (p === 'win32') continue;
      expect(isImplemented(CAPABILITY_MATRIX[p].perception.status), p).toBe(false);
      // 1.4.0 (ADR 0004 addendum): macOS has an opt-in SMAppService login item; every other
      // platform still registers nothing.
      if (p === 'darwin') continue;
      expect(isImplemented(CAPABILITY_MATRIX[p].loginItem.status), p).toBe(false);
    }
    // The macOS login item has never run on a Mac: it may claim code, never a platform run.
    expect(CAPABILITY_MATRIX.darwin.loginItem.status).toBe('IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED');
  });
});

describe('declaredRuntime', () => {
  it('presumes implemented capabilities available and gives the note as the reason otherwise', () => {
    const rt = declaredRuntime('darwin');
    expect(rt.overlay).toEqual({ available: true, reason: null });
    expect(rt.perception.available).toBe(false);
    expect(rt.perception.reason).toBe(CAPABILITY_MATRIX.darwin.perception.note);
  });
});

describe('resolvePlatformId', () => {
  it('maps Windows and macOS directly', () => {
    expect(resolvePlatformId(probe({ os: 'win32' }))).toBe('win32');
    expect(resolvePlatformId(probe({ os: 'darwin' }))).toBe('darwin');
  });

  it('an X11 session is linux-x11', () => {
    expect(resolvePlatformId(probe({ x11Display: true }))).toBe('linux-x11');
  });

  it('any Wayland session without an explicit choice is native Wayland (Electron 38+ default), even with XWayland available', () => {
    expect(resolvePlatformId(probe({ waylandDisplay: true }))).toBe('linux-wayland');
    expect(resolvePlatformId(probe({ waylandDisplay: true, x11Display: true }))).toBe('linux-wayland');
  });

  it('an explicit x11 choice inside a Wayland session is XWayland (no overlay); outside one it is X11', () => {
    expect(resolvePlatformId(probe({ waylandDisplay: true, x11Display: true, ozonePlatform: 'x11' }))).toBe('linux-xwayland');
    expect(resolvePlatformId(probe({ x11Display: true, ozonePlatform: 'X11' }))).toBe('linux-x11');
    expect(resolvePlatformId(probe({ x11Display: true, ozonePlatform: 'wayland' }))).toBe('linux-wayland');
  });

  it('an unknown OS fails closed to a platform without an overlay', () => {
    const id = resolvePlatformId(probe({ os: 'aix' }));
    expect(CAPABILITY_MATRIX[id].overlay.status).toBe('BLOCKED_BY_PLATFORM_OR_PERMISSION');
  });
});
