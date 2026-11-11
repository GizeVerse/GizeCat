// World events (Living Companion): the engine, the catalogue and the pure helpers around them.
export {
  LAZY_IGNORE_PROBABILITY,
  SHY_STANDOFF_FACTOR,
  SHY_WATCH_FRACTION,
  SHY_WATCH_MAX_MS,
  SHY_WATCH_MIN_MS,
  createWorldEventEngine,
  outcomeWeights,
  sanitizeHistory,
} from './engine';
export { EVENT_CATALOG, NORMAL_POOL, RARE_POOL, eventDef, isJournalWorthy } from './catalog';
export type { Beat, EventDef, InterruptStyle, MechanicId, OutcomeDef, PacingKey, TempBias, TempKey } from './catalog';
export {
  GRACE_MAX_MS,
  GRACE_MIN_MS,
  MAX_COUNTDOWN_STEP_MS,
  NORMAL_REPEAT_EXCLUDE,
  NOTICE_FACTOR_MAX,
  NOTICE_FACTOR_MIN,
  NOVELTY_HALF_COUNT,
  NOVELTY_MAX,
  NOVELTY_MIN,
  RARE_REPEAT_EXCLUDE,
  RECENCY_FULL_MS,
  RECENCY_MIN_FACTOR,
  canOffer,
  chooseEvent,
  clampPace,
  drawGraceMs,
  drawRawDelayMs,
  effectiveDelayMs,
  hourInWindow,
  noticeNoveltyFactor,
  noveltyFactor,
  noveltyWeight,
  recencyFactor,
  timeFactor,
} from './schedule';
export type { OfferContext } from './schedule';
export { REDUCED_SPAN, RUN_ID_SPAN, WAVE_HEIGHT_RATIO, WAVE_MAX_WIDTH_BODY } from './mechanics';
export type {
  CreateEventEngineOptions,
  EventCatView,
  EventEngineMemory,
  EventIntent,
  EventTemperament,
  EventTickInput,
  EventTickOutput,
  IntentKind,
  InterruptReason,
  OutcomeWeights,
  WorldEventEngine,
} from './types';
