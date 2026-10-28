// Pieces of the settings view state that are pure data transformations.
import type { PerceptionPreview } from '../../shared/ipc';
import type { VisualSummary } from '../../shared/perception';

/** Maps the perception service's preview to the IPC shape; only data:image/ URLs pass. */
export function toPerceptionPreview(r: { ok: boolean; imageDataUrl?: string; summary?: VisualSummary; blockedReason?: string }): PerceptionPreview {
  const out: PerceptionPreview = { ok: r.ok };
  if (r.imageDataUrl && r.imageDataUrl.startsWith('data:image/')) out.imageDataUrl = r.imageDataUrl;
  if (r.summary) {
    out.features = r.summary.features;
    out.events = [...r.summary.events];
  }
  if (r.blockedReason) out.blockedReason = r.blockedReason;
  return out;
}
