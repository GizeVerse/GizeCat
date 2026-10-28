// Movement tuning. Values are in DIP (device-independent pixels) or DIP/s and are
// converted to physical px with the scale factor of the display containing the cat.

export const MOVEMENT = {
  /** Locomotion speeds at settings.behavior.movementSpeed = 1. */
  walkDip: 70,
  runDip: 260,
  chaseDip: 210,
  slowDip: 42,
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
} as const;

/** Arrival tolerance when walking to a point, in DIP. */
export const ARRIVE_RADIUS_DIP = 3;
