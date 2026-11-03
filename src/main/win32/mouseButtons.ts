// Mouse-button state and a content-free press counter (ADR 0003 §4.3, §13 Q2, lead decision: mouse
// buttons only, never keys). GetAsyncKeyState is asked for VK_LBUTTON, VK_RBUTTON and VK_MBUTTON
// only; no keyboard state, key code, character or text is ever read, and nothing is hooked.
//
// One sampler per process: the low bit of GetAsyncKeyState ("pressed since the previous call") is
// consumed by whoever asks, so every reader (the host's cursor poll, the activity monitor) goes
// through this one counter. A press is a down edge between two samples, or a press-and-release
// entirely between them (the low bit), so short clicks between polls are counted too. The low bit is
// documented as unreliable (another process can take it): it only ever adds presses, never invents
// a held button.
import { VK_LBUTTON, VK_MBUTTON, VK_RBUTTON } from './constants';

/** The only virtual keys this module reads: the three mouse buttons. */
export const MOUSE_BUTTON_VKS: readonly number[] = Object.freeze([VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]);

export interface MouseButtonState {
  /** A mouse button (left, right or middle, physical) is held. */
  down: boolean;
  /** Monotonic count of presses (any of the three buttons) since the sampler started. */
  presses: number;
}

export interface MouseButtonSampler {
  /** Reads the three buttons once and returns the updated state. */
  sample(): MouseButtonState;
  /** The last sampled state (no OS call). */
  readonly last: MouseButtonState;
}

/** `readKey` is GetAsyncKeyState; it is only ever called with MOUSE_BUTTON_VKS. */
export function createMouseButtonSampler(readKey: (vk: number) => number): MouseButtonSampler {
  const wasDown = new Map<number, boolean>();
  let state: MouseButtonState = { down: false, presses: 0 };
  return {
    sample() {
      let down = false;
      let presses = state.presses;
      for (const vk of MOUSE_BUTTON_VKS) {
        let v: number;
        try {
          v = readKey(vk);
        } catch {
          v = 0;
        }
        const isDown = (v & 0x8000) !== 0;
        const pressedSince = (v & 0x0001) !== 0;
        const before = wasDown.get(vk) === true;
        // A new down edge, or a press (and maybe release) that happened entirely since the last sample.
        if ((isDown && (!before || pressedSince)) || (!isDown && !before && pressedSince)) presses++;
        wasDown.set(vk, isDown);
        if (isDown) down = true;
      }
      state = { down, presses };
      return state;
    },
    get last() {
      return state;
    },
  };
}
