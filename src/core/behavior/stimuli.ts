// Stimulus relevance, habituation and reaction cooldowns. Frequent events should
// produce a glance, not constant movement.
import type { Point, Rect } from '../../shared/geometry';
import { rectArea, rectCenter } from '../../shared/geometry';
import type { AppCategory } from '../../shared/world';

/** Habituation per stimulus kind: rises with each occurrence, decays with a half-life. */
export class Habituation {
  private readonly levels = new Map<string, { v: number; at: number }>();
  constructor(
    private readonly halfLifeMs = 90_000,
    private readonly step = 0.22,
  ) {}

  level(key: string, now: number): number {
    const e = this.levels.get(key);
    if (!e) return 0;
    return e.v * Math.pow(0.5, Math.max(0, now - e.at) / this.halfLifeMs);
  }

  /** Records an occurrence; returns the level *before* it (what the cat felt). */
  register(key: string, now: number): number {
    const before = this.level(key, now);
    this.levels.set(key, { v: Math.min(1, before + this.step * (1 - before)), at: now });
    if (this.levels.size > 64) {
      const oldest = [...this.levels.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.levels.delete(oldest[0]);
    }
    return before;
  }

  clear(): void {
    this.levels.clear();
  }
}

/** Named reaction cooldowns. */
export class Cooldowns {
  private readonly until = new Map<string, number>();
  ready(key: string, now: number): boolean {
    return now >= (this.until.get(key) ?? -Infinity);
  }
  set(key: string, now: number, ms: number): void {
    this.until.set(key, now + ms);
  }
  /** Ready check that also starts the cooldown when it passes. */
  take(key: string, now: number, ms: number): boolean {
    if (!this.ready(key, now)) return false;
    this.set(key, now, ms);
    return true;
  }
}

/** Bounded set remembering recently seen ids (window novelty). In memory only. */
export class RecentIds {
  private readonly ids: string[] = [];
  constructor(private readonly max = 128) {}
  has(id: string): boolean {
    return this.ids.includes(id);
  }
  add(id: string): void {
    const i = this.ids.indexOf(id);
    if (i >= 0) this.ids.splice(i, 1);
    this.ids.push(id);
    if (this.ids.length > this.max) this.ids.shift();
  }
  delete(id: string): void {
    const i = this.ids.indexOf(id);
    if (i >= 0) this.ids.splice(i, 1);
  }
  get size(): number {
    return this.ids.length;
  }
}

export const CATEGORY_INTEREST: Readonly<Record<AppCategory, number>> = {
  code: 0.8,
  terminal: 0.7,
  browser: 0.9,
  video: 0.75,
  game: 0.6,
  document: 0.8,
  chat: 0.9,
  design: 0.9,
  media: 0.7,
  sensitive: 0.2,
  system: 0.3,
  other: 0.7,
  unknown: 0.6,
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export interface WindowStimulus {
  cat: Point;
  rect: Rect;
  /** Work area of the display the cat is on (for size/distance normalisation). */
  displayRect: Rect;
  category: AppCategory;
  excluded: boolean;
  novel: boolean;
  curiosity: number;
  sensitivity: number;
  habituation: number;
  typing: boolean;
}

/** 0..1 how interesting a window event is to this cat right now. */
export function windowRelevance(w: WindowStimulus): number {
  const area = rectArea(w.displayRect);
  if (area <= 0 || rectArea(w.rect) <= 0) return 0;
  const size = 0.35 + 0.65 * Math.sqrt(clamp01(rectArea(w.rect) / area));
  const c = rectCenter(w.rect);
  const diag = Math.hypot(w.displayRect.width, w.displayRect.height);
  const dist = 1 - 0.75 * clamp01(Math.hypot(c.x - w.cat.x, c.y - w.cat.y) / diag);
  const novelty = w.novel ? 1 : 0.4;
  return clamp01(
    clamp01(w.sensitivity) *
      (0.35 + 0.65 * clamp01(w.curiosity)) *
      size *
      dist *
      novelty *
      CATEGORY_INTEREST[w.category] *
      (w.excluded ? 0.4 : 1) *
      (1 - clamp01(w.habituation)) *
      (w.typing ? 0.5 : 1) *
      1.6,
  );
}

export interface FlickStimulus {
  /** Cursor speed, DIP/s. */
  speedDip: number;
  distBodyLengths: number;
  cursorPlay: number;
  playfulness: number;
  energy: number;
  acceptance: number;
  habituation: number;
}

/** 0..1 how tempting a fast cursor flick is. */
export function flickRelevance(f: FlickStimulus): number {
  const speed = clamp01((f.speedDip - 300) / 1500);
  const near = 1 - clamp01(f.distBodyLengths / 14);
  return clamp01(
    (0.4 + 0.6 * speed) *
      near *
      clamp01(f.cursorPlay) *
      (0.35 + 0.65 * clamp01(f.playfulness)) *
      clamp01((f.energy - 0.1) / 0.4) *
      (0.5 + clamp01(f.acceptance)) *
      (1 - clamp01(f.habituation)) *
      1.8,
  );
}
