// Periodic CPU / memory sampling across all app processes (app.getAppMetrics),
// kept in a fixed-size ring for the settings window and diagnostics export.
import type { ResourceSample } from '../../shared/ipc';

export interface ProcessMetricLike {
  cpu: { percentCPUUsage: number };
  /** Working set in KB (Electron's MemoryInfo.workingSetSize). */
  memory: { workingSetSize: number };
}

export interface ResourceMonitor {
  start(): void;
  stop(): void;
  sampleNow(): ResourceSample | null;
  samples(): ResourceSample[];
}

export function summarizeMetrics(metrics: readonly ProcessMetricLike[], at: number): ResourceSample {
  let cpu = 0;
  let kb = 0;
  for (const m of metrics) {
    if (Number.isFinite(m.cpu.percentCPUUsage)) cpu += m.cpu.percentCPUUsage;
    if (Number.isFinite(m.memory.workingSetSize)) kb += m.memory.workingSetSize;
  }
  return { at, cpuPercent: Math.round(cpu * 100) / 100, workingSetMB: Math.round((kb / 1024) * 10) / 10 };
}

export function createResourceMonitor(opts: {
  getMetrics: () => readonly ProcessMetricLike[];
  intervalMs?: number;
  capacity?: number;
  now?: () => number;
}): ResourceMonitor {
  const intervalMs = opts.intervalMs ?? 60_000;
  const capacity = Math.max(1, opts.capacity ?? 120);
  const now = opts.now ?? Date.now;
  const ring: ResourceSample[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;

  function sampleNow(): ResourceSample | null {
    let metrics: readonly ProcessMetricLike[];
    try {
      metrics = opts.getMetrics();
    } catch {
      return null;
    }
    const s = summarizeMetrics(metrics, now());
    ring.push(s);
    if (ring.length > capacity) ring.splice(0, ring.length - capacity);
    return s;
  }

  return {
    start() {
      if (timer) return;
      // The first reading only primes Chromium's CPU counters (it is always 0), so it is not kept.
      try {
        opts.getMetrics();
      } catch {
        /* sampled again on the next interval */
      }
      timer = setInterval(sampleNow, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    sampleNow,
    samples: () => [...ring],
  };
}
