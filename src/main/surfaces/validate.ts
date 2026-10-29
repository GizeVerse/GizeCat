// Validation of surfaces injected through the E2E test hook (test mode only). Injected
// geometry is SIMULATED: it lets the suite drive a fake taskbar through the real app.
import { z } from 'zod';
import { SURFACE_PHASES, TASKBAR_EDGES, type Surface } from '../../shared/surfaces';

/** Bound on the injected list (an E2E scenario needs a handful). */
export const MAX_INJECTED_SURFACES = 64;

const coord = z.number().min(-1e7).max(1e7);
const speed = z.number().min(-1e6).max(1e6);

const base = {
  id: z.string().min(1).max(128),
  ownerId: z.string().min(1).max(64),
  displayId: z.string().max(64).nullable(),
  phase: z.enum(SURFACE_PHASES),
  vx: speed,
  vy: speed,
  confidence: z.number().min(0).max(1),
  validatedAt: z.number(),
  excluded: z.boolean(),
};

const LedgeSchema = z
  .strictObject({
    ...base,
    kind: z.enum(['taskbar', 'windowTop', 'tabStrip']),
    orientation: z.literal('ledge'),
    y: coord,
    x0: coord,
    x1: coord,
    rest: z.strictObject({ x0: coord, x1: coord }).nullable(),
    focusX: coord.nullable(),
    edge: z.enum(TASKBAR_EDGES).optional(),
  })
  .refine((s) => s.x1 > s.x0, { message: 'x1 must be greater than x0' });

const WallSchema = z
  .strictObject({
    ...base,
    kind: z.literal('windowSide'),
    orientation: z.literal('wall'),
    x: coord,
    y0: coord,
    y1: coord,
    side: z.enum(['left', 'right']),
    topLedgeId: z.string().min(1).max(128).nullable(),
  })
  .refine((s) => s.y1 > s.y0, { message: 'y1 must be greater than y0' });

const InjectedSchema = z
  .array(z.union([LedgeSchema, WallSchema]))
  .max(MAX_INJECTED_SURFACES)
  .refine((list) => new Set(list.map((s) => s.id)).size === list.length, { message: 'surface ids must be unique' });

/** Parses an injected surface list (or null = stop injecting); throws a readable error when invalid. */
export function parseInjectedSurfaces(value: unknown): Surface[] | null {
  if (value === null) return null;
  const r = InjectedSchema.safeParse(value);
  if (!r.success) throw new Error(`injectSurfaces: invalid surface list (${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  return r.data;
}
