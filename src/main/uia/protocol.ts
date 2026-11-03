// Wire protocol of the DesktopCatUia helper (native/uia-helper): one JSON object per line over
// stdio. Every line from the helper is size-capped and zod-validated before use; the helper only
// ever sends geometry, flags, counts and fixed protocol strings (never names or titles).
import { z } from 'zod';
import type { Rect } from '../../shared/geometry';

/**
 * v1.2 (ADR 0003 §7): protocol 2 adds the WinUI TabView reader. Additive: a strip carries `kind`
 * (absent = 'chromium', so protocol-1 lines parse unchanged) and ping may list the kinds the
 * helper reads. UIA_PROTOCOL_VERSION moved to this value in the same change as the native helper
 * (native/uia-helper/Program.cs ProtocolVersion; both ends compare exactly).
 */
export const UIA_PROTOCOL_VERSION_V2 = 2;
export const UIA_PROTOCOL_VERSION = UIA_PROTOCOL_VERSION_V2;
export const TAB_STRIP_KINDS = ['chromium', 'tabview'] as const;
export type TabStripKind = (typeof TAB_STRIP_KINDS)[number];
/** Lines from the helper longer than this (bytes) are dropped unparsed. */
export const MAX_HELPER_LINE_BYTES = 64 * 1024;
/** The helper reports at most this many tab rectangles (it still counts all tabs). */
export const MAX_REPORTED_TABS = 256;
/** HWND as an unsigned decimal string (same format as WindowInfo.id). */
export const HWND_PATTERN = /^[1-9][0-9]{0,19}$/;
export const MAX_REQUEST_ID = 0x7fffffff;

const Coord = z.number().int().min(-1_000_000).max(1_000_000);
const Extent = z.number().int().min(0).max(1_000_000);
const WireRectSchema = z.object({ x: Coord, y: Coord, w: Extent, h: Extent });
const WireTabSchema = WireRectSchema.extend({ selected: z.boolean() });
const HwndSchema = z.string().regex(HWND_PATTERN);

export const WireStripSchema = z.object({
  frame: WireRectSchema,
  work: WireRectSchema.nullable(),
  dpi: z.number().int().min(48).max(960),
  container: WireRectSchema.nullable(),
  tabs: z.array(WireTabSchema).max(MAX_REPORTED_TABS),
  count: z.number().int().min(0).max(100_000),
  leftButton: WireRectSchema.nullable(),
  newTab: WireRectSchema.nullable(),
  grab: WireRectSchema.nullable(),
  captions: WireRectSchema.nullable(),
  maximized: z.boolean(),
  vertical: z.boolean(),
  path: z.enum(['class', 'bfs']),
  ms: z.number().min(0).max(600_000),
  /** Protocol 2: which reader produced the strip; absent (protocol-1 helpers) means 'chromium' (stripKind). */
  kind: z.enum(TAB_STRIP_KINDS).optional(),
});
export type WireStrip = z.infer<typeof WireStripSchema>;
/** The reader kind of a strip (protocol-1 strips are Chromium's). */
export const stripKind = (s: Pick<WireStrip, 'kind'>): TabStripKind => s.kind ?? 'chromium';

const RequestIdSchema = z.number().int().min(1).max(MAX_REQUEST_ID);

const OkResponseSchema = z.object({
  id: RequestIdSchema,
  ok: z.literal(true),
  strip: WireStripSchema.optional(),
  pong: z.literal(true).optional(),
  version: z.number().int().min(0).max(1000).optional(),
  dpi: z.string().regex(/^[a-z0-9]{1,20}$/).optional(),
  watching: z.number().int().min(0).max(64).optional(),
  failed: z.array(HwndSchema).max(64).optional(),
  prunedRender: z.number().int().min(0).optional(),
  prunedOther: z.number().int().min(0).optional(),
  /** Protocol 2 ping: the strip kinds this helper can read. */
  kinds: z.array(z.enum(TAB_STRIP_KINDS)).max(TAB_STRIP_KINDS.length).optional(),
});
export type HelperOkResponse = z.infer<typeof OkResponseSchema>;

/** Error codes are short lower-case slugs; unknown future codes stay valid (forward compatible). */
const ErrorResponseSchema = z.object({
  id: RequestIdSchema.nullable(),
  ok: z.literal(false),
  error: z.string().regex(/^[a-z][a-z-]{0,31}$/),
  detail: z
    .string()
    .regex(/^[A-Za-z0-9_.]{0,64}$/)
    .nullable()
    .optional(),
});
export type HelperErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type HelperResponse = HelperOkResponse | HelperErrorResponse;

const EventSchema = z.object({ event: z.enum(['selected', 'structure']), hwnd: HwndSchema });
export type HelperEvent = z.infer<typeof EventSchema>;

export type HelperMessage = { kind: 'response'; response: HelperResponse } | { kind: 'event'; event: HelperEvent };

export type HelperRequest = { op: 'ping' } | { op: 'strip'; hwnd: string } | { op: 'watch'; hwnds: string[] };

/** Serialises a request line (with trailing newline). */
export function encodeRequest(id: number, req: HelperRequest): string {
  return `${JSON.stringify({ id, ...req })}\n`;
}

export const QUIT_LINE = '{"op":"quit"}\n';

/**
 * Parses one helper line (without the newline). Returns null for anything that is not valid
 * JSON or does not match the protocol exactly; callers count and drop those.
 */
export function parseHelperLine(line: string): HelperMessage | null {
  let text = line;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  if (text.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if ('event' in raw) {
    const ev = EventSchema.safeParse(raw);
    return ev.success ? { kind: 'event', event: ev.data } : null;
  }
  const ok = (raw as { ok?: unknown }).ok;
  if (ok === true) {
    const r = OkResponseSchema.safeParse(raw);
    return r.success ? { kind: 'response', response: r.data } : null;
  }
  if (ok === false) {
    const r = ErrorResponseSchema.safeParse(raw);
    return r.success ? { kind: 'response', response: r.data } : null;
  }
  return null;
}

export const fromWireRect = (r: { x: number; y: number; w: number; h: number }): Rect => ({ x: r.x, y: r.y, width: r.w, height: r.h });
