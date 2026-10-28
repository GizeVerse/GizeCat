// Defensive shape check for render snapshots arriving over IPC. Main is trusted, but a
// malformed snapshot must never crash the frame loop.
import { ANIM_CLIPS, BEHAVIOR_STATES, EMOTES, RENDER_STYLES, SKINS, type CatRenderState } from '../../shared/cat';
import type { OverlayConfig } from '../../shared/ipc';

const CLIPS: ReadonlySet<string> = new Set(ANIM_CLIPS);
const STATES: ReadonlySet<string> = new Set(BEHAVIOR_STATES);
const EMOTE_SET: ReadonlySet<string> = new Set(EMOTES);
const SKIN_SET: ReadonlySet<string> = new Set(SKINS);
const STYLE_SET: ReadonlySet<string> = new Set(RENDER_STYLES);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isRenderState(v: unknown): v is CatRenderState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!isNum(s.seq) || !isNum(s.t) || !isNum(s.x) || !isNum(s.y) || !isNum(s.scale) || s.scale <= 0) return false;
  if (!isNum(s.clipStartedAt) || !isNum(s.speed) || !isNum(s.vy) || !isNum(s.arousal) || !isNum(s.contentment)) return false;
  if (!isNum(s.emoteStartedAt) || !isNum(s.opacity) || !isNum(s.animSpeed)) return false;
  if (typeof s.snap !== 'boolean' || typeof s.visible !== 'boolean' || typeof s.shadow !== 'boolean') return false;
  if (s.facing !== 1 && s.facing !== -1) return false;
  if (typeof s.clip !== 'string' || !CLIPS.has(s.clip)) return false;
  if (typeof s.state !== 'string' || !STATES.has(s.state)) return false;
  if (typeof s.skin !== 'string' || !SKIN_SET.has(s.skin)) return false;
  if (typeof s.style !== 'string' || !STYLE_SET.has(s.style)) return false;
  if (s.emote !== null && (typeof s.emote !== 'string' || !EMOTE_SET.has(s.emote))) return false;
  if (s.look !== null) {
    if (typeof s.look !== 'object' || s.look === undefined) return false;
    const l = s.look as Record<string, unknown>;
    if (!isNum(l.x) || !isNum(l.y)) return false;
  }
  return true;
}

export function isOverlayConfig(v: unknown): v is OverlayConfig {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.displayId === 'string' && isNum(c.scaleFactor) && c.scaleFactor > 0 && typeof c.debug === 'boolean';
}
