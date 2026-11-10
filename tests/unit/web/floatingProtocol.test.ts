// The floating cat's bridge messages (src/web/floatingProtocol.ts): strict parsing both ways.
// Written for 1.4.1 and NOT RUN by the agent that wrote it (owner rule: no tests); the
// owner's run of `node .claude/scripts/verify.mjs fast` is the first execution.
import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  parseControlOp,
  parseFloatingState,
  parseMetricsQuery,
  parseOverlayInbound,
  parseOverlayOutbound,
  parseScreenMetrics,
  serializeControlOp,
  serializeOverlayOutbound,
} from '../../../src/web/floatingProtocol';

const METRICS = { width: 1280, height: 800, density: 2, insets: { top: 24, right: 0, bottom: 48, left: 0 } };

describe('screen metrics', () => {
  it('accepts a normal tablet and rejects nonsense', () => {
    expect(parseScreenMetrics(METRICS)).toEqual(METRICS);
    expect(parseScreenMetrics({ ...METRICS, width: 0 })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, density: 0.1 })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, density: 99 })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, width: Number.NaN })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, extra: 1 })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, insets: { ...METRICS.insets, top: -1 } })).toBeNull();
  });

  it('refuses bars that would cover the whole screen', () => {
    expect(parseScreenMetrics({ ...METRICS, insets: { top: 400, right: 0, bottom: 400, left: 0 } })).toBeNull();
    expect(parseScreenMetrics({ ...METRICS, insets: { top: 0, right: 640, bottom: 0, left: 640 } })).toBeNull();
  });

  it('reads the metrics native puts in the page URL, and nothing else', () => {
    expect(parseMetricsQuery('?surface=overlay&w=1280.000&h=800.000&d=2.000&it=24.000&ir=0.000&ib=48.000&il=0.000')).toEqual(METRICS);
    expect(parseMetricsQuery('?surface=overlay')).toBeNull();
    expect(parseMetricsQuery('?w=1280&h=800&d=2&it=24&ir=0&ib=48')).toBeNull();
    expect(parseMetricsQuery('?w=-1&h=800&d=2&it=0&ir=0&ib=0&il=0')).toBeNull();
    expect(parseMetricsQuery('?w=1e3&h=800&d=2&it=0&ir=0&ib=0&il=0')).toBeNull();
    expect(parseMetricsQuery('?w=1280&h=800&d=2&it=0&ir=0&ib=0&il=0.1234')).toBeNull();
    // Density keeps six decimals, so the page and native agree on window pixels (2.625 is a real density).
    expect(parseMetricsQuery('?w=1280&h=800&d=2.625000&it=0&ir=0&ib=0&il=0')?.density).toBe(2.625);
    expect(parseMetricsQuery('?w=1280&h=800&d=2.1234567&it=0&ir=0&ib=0&il=0')).toBeNull();
  });
});

describe('native -> overlay page', () => {
  it('parses metrics, pointers and commands', () => {
    expect(parseOverlayInbound(JSON.stringify({ t: 'metrics', metrics: METRICS }))).toEqual({ t: 'metrics', metrics: METRICS });
    expect(parseOverlayInbound('{"t":"ptr","k":"down","id":0,"x":12.5,"y":-3}')).toEqual({ t: 'ptr', k: 'down', id: 0, x: 12.5, y: -3 });
    for (const c of ['pause', 'resume', 'hide', 'show', 'suspend', 'wake', 'save', 'reloadSettings']) {
      expect(parseOverlayInbound(`{"t":"cmd","c":"${c}"}`)).toEqual({ t: 'cmd', c });
    }
  });

  it('refuses unknown types, kinds, commands, extra keys, bad numbers and oversized text', () => {
    for (const bad of [
      '',
      'null',
      '[]',
      '{"t":"nope"}',
      '{"t":"cmd","c":"selfDestruct"}',
      '{"t":"cmd","c":"pause","x":1}',
      '{"t":"ptr","k":"hover","id":0,"x":1,"y":1}',
      '{"t":"ptr","k":"move","id":0.5,"x":1,"y":1}',
      '{"t":"ptr","k":"move","id":-1,"x":1,"y":1}',
      '{"t":"ptr","k":"move","id":0,"x":"1","y":1}',
      '{"t":"ptr","k":"move","id":0,"x":1e999,"y":1}',
      '{"t":"ptr","k":"move","id":0,"x":1,"y":1,"extra":true}',
    ]) {
      expect(parseOverlayInbound(bad), bad).toBeNull();
    }
    expect(parseOverlayInbound(`{"t":"cmd","c":"${'p'.repeat(MAX_MESSAGE_CHARS)}"}`)).toBeNull();
    expect(parseOverlayInbound(42)).toBeNull();
    expect(parseOverlayInbound(undefined)).toBeNull();
  });
});

describe('overlay page -> native', () => {
  it('round-trips the three messages', () => {
    for (const m of [
      { t: 'hello', v: 1 } as const,
      { t: 'win', x: -10.5, y: 300, w: 220, h: 240, vis: true, touch: true, tx: 20, ty: 310, tw: 100, th: 120 } as const,
      { t: 'win', x: 0, y: 0, w: 220, h: 240, vis: true, touch: false, tx: 0, ty: 0, tw: 1, th: 1 } as const,
      { t: 'saved', ok: false } as const,
    ]) {
      expect(parseOverlayOutbound(serializeOverlayOutbound(m))).toEqual(m);
    }
  });

  it('refuses a window of zero or absurd size, and non-boolean flags', () => {
    expect(parseOverlayOutbound('{"t":"win","x":0,"y":0,"w":0,"h":10,"vis":true,"touch":true}')).toBeNull();
    expect(parseOverlayOutbound('{"t":"win","x":0,"y":0,"w":10,"h":1e9,"vis":true,"touch":true}')).toBeNull();
    expect(parseOverlayOutbound('{"t":"win","x":0,"y":0,"w":10,"h":10,"vis":1,"touch":true}')).toBeNull();
    expect(parseOverlayOutbound('{"t":"win","x":0,"y":0,"w":10,"h":10,"vis":true}')).toBeNull();
    expect(parseOverlayOutbound('{"t":"win","x":0,"y":0,"w":10,"h":10,"vis":true,"touch":"yes"}')).toBeNull();
    expect(parseOverlayOutbound('{"t":"saved","ok":"yes"}')).toBeNull();
  });

  it('requires a valid touch rectangle alongside the window', () => {
    const base = '"t":"win","x":0,"y":0,"w":10,"h":10,"vis":true,"touch":true';
    expect(parseOverlayOutbound(`{${base},"tx":1,"ty":2,"tw":3,"th":4}`)).toEqual({ t: 'win', x: 0, y: 0, w: 10, h: 10, vis: true, touch: true, tx: 1, ty: 2, tw: 3, th: 4 });
    expect(parseOverlayOutbound(`{${base}}`)).toBeNull();
    expect(parseOverlayOutbound(`{${base},"tx":1,"ty":2,"tw":0,"th":4}`)).toBeNull();
    expect(parseOverlayOutbound(`{${base},"tx":1,"ty":2,"tw":3,"th":4,"extra":1}`)).toBeNull();
  });
});

describe('hover, leave and touch hints (native -> overlay page)', () => {
  it('accepts hover and leave pointers with a timestamp and refuses a pointer without one', () => {
    expect(parseOverlayInbound('{"t":"ptr","k":"hover","id":1,"x":5,"y":6,"ms":100}')).toMatchObject({ k: 'hover', ms: 100 });
    expect(parseOverlayInbound('{"t":"ptr","k":"leave","id":1,"x":5,"y":6,"ms":100}')).toMatchObject({ k: 'leave' });
    expect(parseOverlayInbound('{"t":"ptr","k":"down","id":1,"x":5,"y":6}')).toBeNull();
  });

  it('accepts an app-window touch hint and nothing extra on it', () => {
    expect(parseOverlayInbound('{"t":"hint","x":10,"y":20}')).toEqual({ t: 'hint', x: 10, y: 20 });
    expect(parseOverlayInbound('{"t":"hint","x":10,"y":20,"id":1}')).toBeNull();
    expect(parseOverlayInbound('{"t":"hint","x":"a","y":20}')).toBeNull();
  });
});

describe('app screen <-> native', () => {
  it('round-trips every operation and refuses others', () => {
    for (const op of ['query', 'start', 'stop', 'pause', 'resume', 'hide', 'show', 'openOverlaySettings', 'settingsChanged'] as const) {
      expect(parseControlOp(serializeControlOp(op))).toBe(op);
    }
    expect(parseControlOp('{"t":"op","op":"requestNotifications"}')).toBeNull();
    expect(parseControlOp('{"t":"op","op":"start","extra":1}')).toBeNull();
    expect(parseControlOp('{"t":"cmd","op":"start"}')).toBeNull();
  });

  it('parses the floating state exactly', () => {
    const state = { t: 'state', running: true, paused: false, hidden: false, overlayPermission: true, notifications: false, canAskNotifications: false, lastStop: 'none' };
    expect(parseFloatingState(JSON.stringify(state))).toEqual({
      running: true,
      paused: false,
      hidden: false,
      overlayPermission: true,
      notifications: false,
      canAskNotifications: false,
      lastStop: 'none',
    });
    expect(parseFloatingState(JSON.stringify({ ...state, lastStop: 'exploded' }))).toBeNull();
    expect(parseFloatingState(JSON.stringify({ ...state, running: 'true' }))).toBeNull();
    expect(parseFloatingState(JSON.stringify({ ...state, extra: 1 }))).toBeNull();
    const { lastStop: _omitted, ...missing } = state;
    expect(parseFloatingState(JSON.stringify(missing))).toBeNull();
  });
});
