// A recording stand-in for CanvasRenderingContext2D so drawing code can run in node.
// Every numeric argument passed to a drawing call is checked for finiteness.
import type { Ctx2D } from '../../../src/renderer/overlay/cat/draw';

export interface MockCtx {
  ctx: Ctx2D;
  calls: { name: string; args: unknown[] }[];
  nonFinite: { name: string; args: unknown[] }[];
  /** save() depth; must return to 0 after a balanced draw. */
  depth(): number;
}

export function createMockCtx(width = 256, height = 256): MockCtx {
  const calls: { name: string; args: unknown[] }[] = [];
  const nonFinite: { name: string; args: unknown[] }[] = [];
  let depth = 0;
  const props: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    lineDashOffset: 0,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    canvas: { width, height },
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, key) {
      if (key in props) return props[key];
      if (typeof key !== 'string') return undefined;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (args.some((a) => typeof a === 'number' && !Number.isFinite(a))) nonFinite.push({ name: key, args });
        if (Array.isArray(args[0]) && (args[0] as unknown[]).some((a) => typeof a === 'number' && !Number.isFinite(a))) {
          nonFinite.push({ name: key, args });
        }
        if (key === 'save') depth++;
        if (key === 'restore') depth--;
        if (key === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        if (key === 'getImageData') {
          const w = Number(args[2]) || 1;
          const h = Number(args[3]) || 1;
          return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        }
        return undefined;
      };
    },
    set(_t, key, value) {
      if (typeof value === 'number' && !Number.isFinite(value)) nonFinite.push({ name: `set ${String(key)}`, args: [value] });
      props[key] = value;
      return true;
    },
  };
  const ctx = new Proxy<Record<string, unknown>>({}, handler) as unknown as Ctx2D;
  return { ctx, calls, nonFinite, depth: () => depth };
}
