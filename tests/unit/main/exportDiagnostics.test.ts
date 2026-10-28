import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDiagnosticsToFile } from '../../../src/main/diagnostics/exportDiagnostics';
import { memoryLogger, removeDir, tempDir } from './helpers';

const dialog = vi.hoisted(() => ({ showSaveDialog: vi.fn() }));
// Hoisted by vitest above the imports: exportDiagnostics.ts only needs `dialog`.
vi.mock('electron', () => ({ dialog }));

describe('export diagnostics', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  const run = (build: () => Record<string, unknown> = () => ({ kind: 'desktop-cat-diagnostics' })) =>
    exportDiagnosticsToFile({ parent: null, defaultDir: dir, build, logger: memoryLogger(), now: () => new Date('2026-10-28T12:00:00Z') });

  it('cancelling the save dialog is not reported as a failure, and nothing is built or written', async () => {
    dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    const build = vi.fn(() => ({}));
    const r = await run(build);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/cancelled/i);
    expect(build).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes the report where the user chose, and reports a real write failure as one', async () => {
    const target = path.join(dir, 'report.json');
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
    expect(await run()).toEqual({ ok: true, message: `Diagnostics saved to ${target}` });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ kind: 'desktop-cat-diagnostics' });

    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path.join(dir, 'missing-folder', 'x.json') });
    expect(await run()).toEqual({ ok: false, message: 'Could not write the diagnostics file.' });
  });
});
