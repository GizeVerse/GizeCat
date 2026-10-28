import { z } from 'zod';

/**
 * Tier B: coarse local image statistics. These are numbers computed from a small,
 * downscaled, in-memory frame. They carry no semantic understanding.
 */
export interface VisualFeatures {
  /** 0..1 mean luminance. */
  brightness: number;
  /** 0..1 luminance standard deviation (normalised). */
  contrast: number;
  /** 0..1 colourfulness (Hasler-Suesstrunk, normalised). */
  colorfulness: number;
  /** 0..1 fraction of pixels on strong edges ("busy" vs "quiet"). */
  edgeDensity: number;
  /** 0..1 fraction of pixels that changed vs the previous frame (null on first frame). */
  changeFraction: number | null;
  /** Bounding box of the changed area, normalised 0..1 frame coords (null when none). */
  changeBox: { x: number; y: number; width: number; height: number } | null;
  /** 0..1 motion estimate from recent frame differences (video/game-like activity). */
  motion: number;
}

export const VISUAL_EVENT_KINDS = ['dark', 'bright', 'busy', 'quiet', 'bigChange', 'motion', 'still'] as const;
export type VisualEventKind = (typeof VISUAL_EVENT_KINDS)[number];

export interface VisualSummary {
  features: VisualFeatures;
  /** Derived coarse labels, e.g. ['dark', 'motion']. */
  events: VisualEventKind[];
  /** Where the analysed region was, physical px (for "approach the change"). */
  regionPx: { x: number; y: number; width: number; height: number };
  /** Centre of the changed area in physical px, if any. */
  changeCenterPx: { x: number; y: number } | null;
  at: number;
}

/** Tier C: the ONLY shape an AI vision model may return. Validated strictly. */
export const SCENE_TYPES = ['document', 'code', 'video', 'game', 'browsing', 'chat', 'image', 'desktop', 'other'] as const;
export const SCENE_ENERGY = ['calm', 'moderate', 'intense'] as const;
/** Allow-listed reactions. The model chooses among these; it can never trigger OS actions. */
export const AI_REACTIONS = ['ignore', 'watch', 'approach', 'play', 'startle', 'sit_nearby', 'sleep', 'groom'] as const;

export const SceneReportSchema = z
  .object({
    scene: z.enum(SCENE_TYPES),
    energy: z.enum(SCENE_ENERGY),
    interest: z.number().min(0).max(1),
    reaction: z.enum(AI_REACTIONS),
    caption: z.string().max(80),
  })
  .strict();
export type SceneReport = z.infer<typeof SceneReportSchema>;
export type AiReaction = (typeof AI_REACTIONS)[number];

/** JSON Schema equivalent of SceneReportSchema, for providers that accept one. */
export const SCENE_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scene', 'energy', 'interest', 'reaction', 'caption'],
  properties: {
    scene: { type: 'string', enum: [...SCENE_TYPES] },
    energy: { type: 'string', enum: [...SCENE_ENERGY] },
    interest: { type: 'number', minimum: 0, maximum: 1 },
    reaction: { type: 'string', enum: [...AI_REACTIONS] },
    caption: { type: 'string', maxLength: 80 },
  },
} as const;

/** What the user can see about perception at any time (tray + settings). */
export type PerceptionMode = 'off' | 'local-stats' | 'ai-local' | 'ai-cloud';

export interface PerceptionStatus {
  mode: PerceptionMode;
  paused: boolean;
  /** Human-readable reason when perception is configured but currently not running. */
  blockedReason: string | null;
  lastCaptureAt: number | null;
  capturesThisHour: number;
  aiProviderLabel: string | null;
  lastError: string | null;
}
