import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/win32/native', () => ({
  loadWin32Native: () => {
    throw new Error('Cannot find module @koromix/koffi-win32-x64');
  },
}));

import { createWin32Api, createWindowTracker } from '../../../src/main/win32';
import { createTestLogger } from './fakes';

describe('createWin32Api when koffi cannot load', () => {
  it('returns the inert fallback, logs once and never throws', () => {
    const logger = createTestLogger();
    const api = createWin32Api(logger);
    expect(api.available).toBe(false);
    expect(api.listAppWindows()).toEqual([]);
    expect(api.subscribeWinEvents(() => undefined)).toBeNull();
    const warns = logger.entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.error).toContain('koffi');
    const tracker = createWindowTracker(api, logger);
    tracker.start();
    expect(tracker.mode).toBe('unavailable');
  });
});
