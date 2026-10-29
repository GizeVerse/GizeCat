// v1.2 sub-behaviour gates (ADR 0003 §9.4, review C2). The behaviour package generates the new
// acts below; each is allowed only while none of the switches it lists is off. This is how a v2
// opt-out is never re-enabled under a new name: 'Paw at the cursor' off removes every strike at
// the cursor (hunt bats, mischief and defensive swats, the petting swat), 'Taskbar play' off
// removes every planned move onto a taskbar, 'Zoomies' and 'Grooming' off remove the zoomie and
// grooming parts of the new acts, and so on. Plain data, no zod (the settings renderer may import it).
import type { BehaviorId } from './settings';

export const SUB_BEHAVIORS = [
  // ---- hunting and the cursor (ADR 0003 §4, §1.7) ----
  /** Watching, approaching and stalking the cursor. */
  'huntStalk',
  /** The ballistic pounce at the end of a stalk. */
  'huntPounce',
  /** A vertical jump-swat at a cursor 1.2-2.5 body heights above. */
  'huntJumpSwat',
  /** Batting at the cursor after a pounce. */
  'huntBat',
  /** Lying low at a side's foot, a strip end or a corner, then hunting a passing cursor. */
  'ambush',
  /** An opportunistic swat at a cursor passing close by while it sits. */
  'mischiefSwat',
  /** The soft swat at the hand after a long petting bout, then a hop away. */
  'overstimSwat',
  // ---- rough-handling reactions (ADR 0003 §5) ----
  /** The defensive hiss. */
  'defensiveHiss',
  /** A defensive swat at a cursor that comes close after the hiss. */
  'defensiveSwat',
  /** The playful reaction's mini pounce at the cursor. */
  'reactionPounce',
  /** The playful reaction's short zoomie. */
  'reactionZoomie',
  // ---- play and calm ----
  'zoomies',
  'tailChase',
  /** Every groom: idle, displacement (after losing interest, a surprise), on a stay. */
  'groom',
  // ---- moves between surfaces (ADR 0003 §2.3, §6) ----
  /** Jumping from one window's top or strip to another's. */
  'surfaceHop',
  /** Any planned move that ends on a taskbar (hop, wall jump, leave); never an emergency bail-out. */
  'taskbarTarget',
  /** A jump off a window side the cat clings to (wall jump, climb part-way then leap). */
  'windowWallJump',
  /** Climbing an outer screen edge (peek or full climb, top-corner hold). */
  'screenEdgeClimb',
  /** A jump off a screen edge onto a window top, a taskbar or the floor. */
  'screenEdgeWallJump',
  /** The deliberate, recoverable slip on a take-off. */
  'slip',
  // ---- windows and tabs (ADR 0003 §1.8, §2.2, §7.4) ----
  /** The trip up onto a window top (v1.1.1 'inspectingWindow:explore'). */
  'tripUp',
  /** Sitting at a window top's edge looking down into the window (v1.1.1 'inspectingWindow:edge'). */
  'edgeSit',
  /** Looking at / approaching windows from below, and the curious look at a restored window's top. */
  'inspectWindow',
  /** Watching the active tab from a strip (moves toward focusX). */
  'watchTab',
  /** Ear flick / head turn / approach when tabs are switched, added or closed on its strip. */
  'tabReaction',
] as const;
export type SubBehavior = (typeof SUB_BEHAVIORS)[number];

/**
 * The switches each act needs on. A v2 id here means "that v2 control switches this off too"; the
 * implied opt-outs (IMPLIED_OPT_OUTS) are already folded into disabledBehaviorSet.
 */
export const SUB_BEHAVIOR_GATES: Readonly<Record<SubBehavior, readonly BehaviorId[]>> = {
  huntStalk: ['chaseCursor'],
  huntPounce: ['chaseCursor', 'pounce'],
  huntJumpSwat: ['chaseCursor', 'pounce', 'pawAtCursor'],
  huntBat: ['chaseCursor', 'pawAtCursor'],
  ambush: ['chaseCursor'],
  mischiefSwat: ['pawAtCursor'],
  overstimSwat: ['pawAtCursor'],
  defensiveHiss: ['hissing'],
  defensiveSwat: ['hissing', 'pawAtCursor'],
  reactionPounce: ['chaseCursor', 'pounce'],
  reactionZoomie: ['zoomies'],
  zoomies: ['zoomies'],
  tailChase: ['tailChase'],
  groom: ['grooming'],
  surfaceHop: ['perchOnWindows', 'surfaceHops'],
  taskbarTarget: ['taskbarPlay'],
  windowWallJump: ['climbWindows', 'surfaceHops'],
  screenEdgeClimb: ['climbWindows', 'screenEdges'],
  screenEdgeWallJump: ['climbWindows', 'screenEdges', 'surfaceHops'],
  slip: ['slips'],
  tripUp: ['perchOnWindows'],
  edgeSit: ['perchOnWindows', 'inspectWindows'],
  inspectWindow: ['inspectWindows'],
  watchTab: ['tabStrips'],
  tabReaction: ['tabStrips', 'tabReactions'],
};

/** True when `act` may run with the effective opt-out set `disabled` (disabledBehaviorSet). */
export function subBehaviorAllowed(act: SubBehavior, disabled: ReadonlySet<BehaviorId>): boolean {
  const gates = SUB_BEHAVIOR_GATES[act];
  if (!gates) return false;
  for (const id of gates) if (disabled.has(id)) return false;
  return true;
}
