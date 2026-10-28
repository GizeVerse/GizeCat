// DOM-free view logic of individual settings pages.
import { describe, expect, it } from 'vitest';
import { BLOCK_REASONS } from '../../../../src/core/perception/privacy';
import type { SettingsViewState } from '../../../../src/shared/ipc';
import type { PerceptionStatus } from '../../../../src/shared/perception';
import { statusEntries } from '../../../../src/renderer/settings/pages/diagnostics';
import { callButtonState } from '../../../../src/renderer/settings/pages/general';
import { S } from '../../../../src/renderer/settings/strings';
import { previewView } from './preview/fixture';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const D = S.diagnostics;

function view(perception: Partial<PerceptionStatus>, opts: { userPaused?: boolean; visible?: boolean } = {}): SettingsViewState {
  const v = previewView(NOW, { electron: '44.9.3', chrome: '152.0.0.0', node: '24.0.0' });
  v.settings.perception.paused = opts.userPaused ?? false;
  v.status.visible = opts.visible ?? true;
  v.status.perception = { ...v.status.perception, ...perception };
  return v;
}

const perceptionEntry = (v: SettingsViewState): string | undefined => statusEntries(v, NOW).find(([label]) => label === D.perception)?.[1];

describe('General page: call button', () => {
  it('is off with a reason while the cat is paused, because the simulation ignores the call', () => {
    expect(callButtonState({ visible: true, paused: true })).toEqual({ disabled: true, note: S.general.callPaused });
    expect(callButtonState({ visible: false, paused: true }).disabled).toBe(true);
  });

  it('is on while the cat is active', () => {
    expect(callButtonState({ visible: true, paused: false })).toEqual({ disabled: false, note: null });
  });
});

describe('Diagnostics page: status', () => {
  it('says capture is suspended for a hidden cat instead of reporting a privacy pause', () => {
    const v = view({ mode: 'local-stats', paused: true, blockedReason: BLOCK_REASONS.paused }, { visible: false });
    expect(perceptionEntry(v)).toBe(S.format.parenthetical(D.modes['local-stats'], D.perceptionSuspended.hidden));
  });

  it('reports the user’s privacy pause as paused', () => {
    const v = view({ mode: 'local-stats', paused: true, blockedReason: BLOCK_REASONS.paused }, { userPaused: true });
    expect(perceptionEntry(v)).toBe(S.format.list(S.format.parenthetical(D.modes['local-stats'], D.perceptionPaused), BLOCK_REASONS.paused));
  });

  it('shows uptime from the latest view and the time of the call', () => {
    const v = view({});
    v.status.startedAt = NOW - 3 * 60_000;
    expect(statusEntries(v, NOW).find(([label]) => label === D.uptime)?.[1]).toBe('3 min');
    expect(statusEntries(v, NOW + 2 * 60_000).find(([label]) => label === D.uptime)?.[1]).toBe('5 min');
  });
});
