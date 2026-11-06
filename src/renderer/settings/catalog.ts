// Ordered id lists mirrored from src/shared/settings.ts. The settings module pulls
// zod in at runtime, which the renderer bundle does not need; the type-level checks
// below fail to compile if the shared lists gain an id that is missing here, and a
// unit test asserts the order matches.
import type { AiProviderId, LivelyBehavior, Settings, ToggleableBehavior } from '../../shared/settings';

type StartupState = Settings['general']['startupState'];

export const BEHAVIOR_IDS = [
  'chaseCursor',
  'pawAtCursor',
  'seekAttention',
  'inspectWindows',
  'perchOnWindows',
  'zoomies',
  'grooming',
  'taskbarPlay',
  'climbWindows',
  'tabStrips',
] as const satisfies readonly ToggleableBehavior[];

/** v1.2 opt-outs (behavior.disabledExtras), mirrored from LIVELY_BEHAVIORS. */
export const LIVELY_IDS = [
  'pounce',
  'screenEdges',
  'surfaceHops',
  'hissing',
  'tailChase',
  'tabReactions',
  'explorerTabs',
  'terminalTabs',
  'slips',
] as const satisfies readonly LivelyBehavior[];

/**
 * The v2 switch a v1.2 behaviour lives under (mirror of IMPLIED_OPT_OUTS): with that switch off the
 * v1.2 one is off too, so its toggle is shown off and disabled.
 */
export const LIVELY_PARENT: Readonly<Partial<Record<LivelyBehavior, ToggleableBehavior>>> = {
  pounce: 'chaseCursor',
  screenEdges: 'climbWindows',
  surfaceHops: 'perchOnWindows',
  explorerTabs: 'tabStrips',
  terminalTabs: 'tabStrips',
  tabReactions: 'tabStrips',
};

export const PROVIDER_IDS = ['none', 'ollama', 'openai-compatible', 'anthropic'] as const satisfies readonly AiProviderId[];

/** Choices of "When <product> starts" (general.startupState), in display order. */
export const STARTUP_STATES = ['visible', 'hidden', 'paused', 'remember'] as const satisfies readonly StartupState[];

type Missing<All, Listed> = Exclude<All, Listed>;
const behaviorsComplete: [Missing<ToggleableBehavior, (typeof BEHAVIOR_IDS)[number]>] extends [never] ? true : false = true;
const livelyComplete: [Missing<LivelyBehavior, (typeof LIVELY_IDS)[number]>] extends [never] ? true : false = true;
const providersComplete: [Missing<AiProviderId, (typeof PROVIDER_IDS)[number]>] extends [never] ? true : false = true;
const startupStatesComplete: [Missing<StartupState, (typeof STARTUP_STATES)[number]>] extends [never] ? true : false = true;
export const CATALOG_COMPLETE = behaviorsComplete && livelyComplete && providersComplete && startupStatesComplete;

export const PAGE_IDS = [
  'welcome',
  'general',
  'appearance',
  'behavior',
  'interaction',
  'privacy',
  'ai',
  'personality',
  'diagnostics',
  'about',
] as const;
export type PageId = (typeof PAGE_IDS)[number];

export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as readonly string[]).includes(value);
}

/** Upper bounds of the list fields, mirrored from the settings schema (asserted in tests). */
export const MAX_EXCLUDED_PROCESSES = 200;
export const MAX_EXCLUDED_TITLE_PATTERNS = 100;
export const MAX_LIST_ENTRY_LENGTH = 128;
export const MAX_CAT_NAME_LENGTH = 24;
export const MAX_SHORTCUT_LENGTH = 64;
export const MAX_URL_LENGTH = 200;
export const MAX_MODEL_LENGTH = { ollama: 200, openai: 200, anthropic: 100 } as const;
export const API_KEY_LENGTH = { min: 8, max: 400 } as const;
