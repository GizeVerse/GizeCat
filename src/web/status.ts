// Plain-language status of the cat for the page's polite live region and its buttons.
import type { BehaviorState } from '../shared/cat';

const PHRASES: Readonly<Record<BehaviorState, string>> = {
  sleeping: 'is sleeping',
  wakingUp: 'is waking up',
  idle: 'is looking around',
  walking: 'is walking',
  running: 'is running',
  chasingCursor: 'is chasing the pointer',
  watchingCursor: 'is watching the pointer',
  curious: 'is curious',
  inspectingWindow: 'is inspecting something',
  watchingUser: 'is watching you',
  playing: 'is playing',
  beingPetted: 'is being petted',
  startled: 'is startled',
  annoyed: 'is annoyed',
  seekingAttention: 'wants some attention',
  resting: 'is resting',
  grooming: 'is grooming',
  hiding: 'is hiding',
  fallingAsleep: 'is falling asleep',
  held: 'is being held',
  jumping: 'is jumping',
  falling: 'is falling',
  landing: 'is landing',
  away: 'is away',
};

export interface CatStatusInput {
  name: string;
  state: BehaviorState;
  paused: boolean;
}

/** One short sentence, e.g. "Miso is walking." */
export function describeCat(s: CatStatusInput): string {
  const name = s.name.trim() || 'The cat';
  if (s.paused) return `${name} is paused.`;
  return `${name} ${PHRASES[s.state] ?? 'is here'}.`;
}

/** The cat sleeps or is about to: the Sleep / Wake button offers Wake. */
export function isAsleep(state: BehaviorState): boolean {
  return state === 'sleeping' || state === 'fallingAsleep';
}
