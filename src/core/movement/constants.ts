// Movement tuning. Values are in DIP (device-independent pixels) or DIP/s and are
// converted to physical px with the scale factor of the display containing the cat.

export const MOVEMENT = {
  /** Locomotion speeds at settings.behavior.movementSpeed = 1. */
  walkDip: 70,
  runDip: 260,
  chaseDip: 210,
  slowDip: 42,
  /** v1.2 paces (ADR 0003 §6.7): the hunting creep and a flat-out dash (sprint clip). */
  stalkDip: 24,
  sprintDip: 360,
  /** Horizontal acceleration / braking while grounded. */
  accelDip: 900,
  brakeDip: 1500,
  gravityDip: 2600,
  /** Highest surface the cat can jump onto, relative to its feet. */
  maxJumpUpDip: 420,
  /** Longest horizontal jump. */
  maxJumpAcrossDip: 600,
  /** Minimum apex height above the higher of take-off and landing. */
  jumpClearanceDip: 34,
  /** Extra apex height per px of horizontal distance. */
  jumpClearancePerDx: 0.12,
  /** Anticipation crouch before every jump. */
  crouchMs: 280,
  /** Throws are clamped to this speed. */
  maxThrowDip: 2600,
  /** Throws faster than this count as "thrown hard". */
  hardThrowDip: 1100,
  /** Releases slower than this are plain drops. */
  dropSpeedDip: 60,
  /** Velocity kept (and reversed) when hitting a wall in the air. */
  wallRestitution: 0.35,
  /** Two displays' floors join into one walkable floor when their heights differ by at most this. */
  floorJoinToleranceDip: 6,
  /** Facing only flips while |vx| exceeds this, and not more often than facingMinFlipMs. */
  facingSpeedDip: 10,
  facingMinFlipMs: 220,
  /** A stationary cat turns toward something behind it at most this often. */
  turnToLookMs: 1200,
  /** How long a perch may be missing from the platform list before the cat falls. */
  perchGraceMs: 450,
  /** Same, while the window is being moved (the host's platform list lags). */
  perchMovingGraceMs: 2500,
  /** Small playful hop height. */
  hopClearanceDip: 46,
  /** Longest playful pounce toward the pointer, in body lengths. */
  pounceMaxBodyLengths: 2.2,

  // ---- v1.1 surfaces --------------------------------------------------------------
  /**
   * Climbing speeds on a window side at movementSpeed = 1. Up: a little under the walking pace
   * (70), so a 500 px side at 125 % takes under 7 s instead of 9 (v1.1.1; was 45).
   */
  climbUpDip: 60,
  climbDownDip: 60,
  /** Getting onto a wall from the ground, and stepping off it at the bottom. */
  mountMs: 320,
  dismountMs: 260,
  /** Pulling up over a top corner onto the ledge, and the reverse swing down onto the wall. */
  pullUpMs: 520,
  swingMs: 460,
  /** Lowest a wall may end above the support the cat steps onto it from, in body heights. */
  wallReachBodyHeights: 0.6,
  /**
   * Leap and cling (v1.1.1): from a support the cat jumps onto a window side that ends higher
   * than it can step onto. The grip (anchor at hind-paw height) is at most this far above the
   * take-off feet: the same jump power as onto a ledge (maxJumpUpDip).
   */
  wallLeapUpDip: 420,
  /** Where on the side it likes to catch it, above its feet (higher only when the side ends higher). */
  wallLeapGripDip: 300,
  /** Apex of the leap above the grip: it catches the side near the top of its arc, falling slowly. */
  wallLeapClearanceDip: 12,
  /** A ledge rising through the cat's feet lifts it when it comes from at most this far below, in body heights. */
  liftMaxBodyHeights: 0.9,
  /** Easing speed toward a support the cat was lifted onto or lowered onto (and at least 1.5x the support's speed). */
  liftDip: 900,
  settleDip: 420,
  /**
   * A retracting taskbar (or a surface switched off) sets the cat down without a fall when the
   * surface below is at most this far, in body heights: a typical taskbar (48 DIP) is a step down.
   */
  settleMaxBodyHeights: 1,
  /** Two ledges at the same height (within this) whose ends touch (within joinGapBodyLengths) are walk-connected. */
  walkJoinToleranceDip: 2,
  walkJoinGapBodyLengths: 0.3,

  // ---- v1.2 (ADR 0003 §6) -----------------------------------------------------------
  /** Landing impact classes by vertical impact speed: soft below, hard from (medium between). */
  impactSoftBelowDip: 1000,
  impactHardFromDip: 1600,
  /**
   * No planned, non-emergency jump or drop ends further below the feet than this, whatever the
   * settings say. Only LeaveOption.emergency legs (hang from the edge, then drop) may exceed it.
   */
  jumpDownAbsoluteMaxDip: 900,
  /** An emergency leg hangs from the edge first: the drop starts this much lower (body heights). */
  emergencyHangBodyHeights: 1,
  /**
   * Safe jump-down height never lands hard: H_safe <= this x (impactHardFromDip^2 / 2g) x
   * (0.8 + 0.4 heights) (review C2; ~477 DIP at the defaults, the medium class).
   */
  jumpDownSafeHardFraction: 0.95,
  /** Hard cap on a screen-edge top-corner hold, whatever holdOnWall was given (stuck-state guard). */
  maxWallHoldMs: 20_000,
  /** After this many planCancelled within planCancelBackoffWindowMs the mover reports goal 'unreachable' for a while. */
  planCancelBackoffCount: 2,
  planCancelBackoffWindowMs: 10_000,
  /** Ballistic hunting pounce: reach, anticipation crouch (visible wiggle) and apex range. */
  pounceReachBodyLengths: 3.2,
  pounceCrouchMinMs: 600,
  pounceCrouchMaxMs: 1600,
  pounceApexMinDip: 30,
  pounceApexMaxDip: 70,
  /** Ledges down to this width (body lengths) are accepted as narrow (balance) when enabled. */
  narrowLedgeMinBodyLengths: 0.25,
  /** A ledge narrower than this (body lengths) is narrow: the cat walks slower and balances. */
  narrowLedgeBelowBodyLengths: 0.9,
  /**
   * A screen-edge wall's highest anchor is at least this far below the work-area top, so the
   * climbing pose (about 100 DIP above the anchor) and the ears stay on screen.
   */
  screenEdgeTopClearanceDip: 120,
  /** Screen-edge walls only on displays whose climbable stretch is at least this tall (body heights). */
  screenEdgeMinBodyHeights: 2,
  /** How long the reported plan-cancel backoff lasts: 3 s, then 4 s, then 5 s for back-to-back backoffs (deterministic). */
  planCancelBackoffMinMs: 3000,
  planCancelBackoffMaxMs: 5000,
  /** A take-off target moved more than this (body lengths) during the crouch: the plan is stale (cancelled). */
  planStaleBodyLengths: 0.5,
  /** A take-off target served with less confidence than this is treated as covered (stale plan). */
  planCoveredConfidence: 0.25,
  /** Every pace is clamped to this multiple of its clip's clean-gait limit (GAIT_LIMIT_DIP), whatever movementSpeed says. */
  gaitLimitFactor: 1.1,
  /** On a narrow ledge the cat walks at this fraction of its walking pace and never runs. */
  narrowWalkFactor: 0.6,
  /** Balance shown while holding on a wall (screen-edge top corner). */
  wallHoldBalance: 0.6,
  /** A deliberate 'scramble' slip: front paws on the edge, hind legs paddling, then the pull-up. */
  slipScrambleMs: 900,
  /** Slip risk terms (ADR 0003 §6.6): narrow landing span, long gap, high jump, moving target. */
  slipRiskSpanBodyLengths: 1.2,
  slipRiskGapFraction: 0.7,
  slipRiskUpFraction: 0.7,
  slipRiskMovingDip: 50,
  /** Covered or vanished support: the bail-out crouch before take-off, and the latest take-off after the cover. */
  bailOutCrouchMs: 120,
  bailOutMaxDelayMs: 600,
  /** Emergency way off: hanging from the edge (lowering by emergencyHangBodyHeights) before letting go. */
  emergencyHangMs: 360,
  /** Anticipation before a jump off a wall the cat clings to (a push-off, shorter than a ground crouch). */
  wallJumpCrouchMs: 200,
  /** Highest a wall jump may land above the grip, as a share of maxJumpUpDip (it pushes off, mostly across or down). */
  wallJumpUpFraction: 0.5,
  /** Shortest wall jump, body lengths away from the wall line. */
  wallJumpMinBodyLengths: 0.8,
  /** Wall-jump edges kept per wall node in the surface graph (nearest first): bounds the graph cost. */
  wallJumpMaxEdgesPerWall: 8,
  /** A pounce never lands closer than this to a ledge end it would otherwise run past (body lengths). */
  pounceEndMarginBodyLengths: 0.2,
} as const;

/** Route effort weights (seconds of walking one leg is worth), before personality multipliers. */
export const ROUTE_EFFORT = {
  /** Per jump: a cat walks a few seconds along a joined ledge rather than hop down and back up. */
  jumpBase: 1.4,
  jumpUpPerMax: 0.8,
  jumpDownPerMax: 0.3,
  jumpAcrossPerMax: 0.2,
  dropBase: 0.5,
  dropPerMax: 0.3,
  walkJoin: 0.05,
  /** Climbing is slower and harder than jumping: cats only climb when they choose to or must. */
  climbMultiplier: 1.6,
  climbTransition: 0.6,
  /**
   * v1.2 jump-down limits: a leg between the safe and the maximum height costs this many extra
   * seconds at full risk (risk = (drop - safe) / (max - safe)), so a safer way is preferred.
   */
  riskPenalty: 20,
  /**
   * A leg whose drop would land hard (above HARD_DROP_DIP) costs this much more: with the default
   * limits the cat lands hard only where no other way exists (ADR 0003 D8, §6.4).
   */
  hardLandingPenalty: 40,
  /** A wall jump is a jump: weighed like one, plus the push-off. */
  wallJumpBase: 1.2,
} as const;

/** Arrival tolerance when walking to a point, in DIP. */
export const ARRIVE_RADIUS_DIP = 3;
