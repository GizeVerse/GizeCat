// Ordered id lists mirrored from src/shared/settings.ts. The settings module pulls
// zod in at runtime, which the renderer bundle does not need; the type-level checks
// below fail to compile if the shared lists gain an id that is missing here, and a
// unit test asserts the order matches.
import type { AiProviderId, ToggleableBehavior } from '../../shared/settings';

export const BEHAVIOR_IDS = [
  'chaseCursor',
  'pawAtCursor',
  'seekAttention',
  'inspectWindows',
  'perchOnWindows',
  'zoomies',
  'grooming',
] as const satisfies readonly ToggleableBehavior[];

export const PROVIDER_IDS = ['none', 'ollama', 'openai-compatible', 'anthropic'] as const satisfies readonly AiProviderId[];

type Missing<All, Listed> = Exclude<All, Listed>;
const behaviorsComplete: [Missing<ToggleableBehavior, (typeof BEHAVIOR_IDS)[number]>] extends [never] ? true : false = true;
const providersComplete: [Missing<AiProviderId, (typeof PROVIDER_IDS)[number]>] extends [never] ? true : false = true;
export const CATALOG_COMPLETE = behaviorsComplete && providersComplete;

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
