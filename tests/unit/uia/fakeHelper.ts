// Fake DesktopCatUia helper for unit tests (MOCKED: no UI Automation). Run by Node directly
// (type stripping): node fakeHelper.ts. It speaks the helper's JSON-lines protocol on stdio.
//
// Behaviour comes from a JSON state file (env FAKE_UIA_STATE), re-read on every request, so a
// test can change tabs between reads. Events listed in the state (with increasing `seq`) are
// emitted once each by the running process (polled every 10 ms). Every received line is appended
// to FAKE_UIA_LOG as {"pid":N,"line":"..."} so tests can assert which windows were queried.
import fs from 'node:fs';

export interface FakeHelperState {
  /** Protocol version answered to ping (default 1). */
  version?: number;
  dpi?: string;
  /** hwnd -> strip object (sent as `strip`) or { error: code }. Unknown hwnds answer "not-found". */
  strips?: Record<string, unknown>;
  /** Ops that are never answered (simulates a hung browser provider). */
  hang?: string[];
  /** Exit with this code as soon as the process starts. */
  exitOnStart?: number | null;
  /** Exit with code 3 after this many requests (per process). */
  exitAfterRequests?: number | null;
  /** Write a malformed line before every response. */
  garbageBefore?: boolean;
  /** Write a line of this many bytes before every response. */
  oversizeBefore?: number;
  /** Ignore {"op":"quit"} and stdin EOF (simulates a helper that will not exit). */
  ignoreQuit?: boolean;
  events?: Array<{ seq: number; event: string; hwnd: string }>;
}

const statePath = process.env.FAKE_UIA_STATE ?? '';
const logPath = process.env.FAKE_UIA_LOG ?? '';

let lastGood: FakeHelperState = {};

/** Current state; the last good one while the test is replacing the file. */
function readState(): FakeHelperState {
  try {
    lastGood = JSON.parse(fs.readFileSync(statePath, 'utf8')) as FakeHelperState;
  } catch {
    /* being replaced */
  }
  return lastGood;
}

function log(line: string): void {
  if (logPath === '') return;
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, line })}\n`);
}

function send(obj: unknown): void {
  process.stdout.write(`${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
}

const initial = readState();
log('<start>');
if (typeof initial.exitOnStart === 'number') process.exit(initial.exitOnStart);

let emittedSeq = Math.max(0, ...(initial.events ?? []).map((e) => e.seq));
const poll = setInterval(() => {
  const s = readState();
  for (const e of s.events ?? []) {
    if (e.seq <= emittedSeq) continue;
    emittedSeq = e.seq;
    send({ event: e.event, hwnd: e.hwnd });
  }
}, 10);

let requests = 0;
let buffer = '';

function handle(line: string): void {
  log(line);
  const s = readState();
  let req: { id?: number; op?: string; hwnd?: string; hwnds?: string[] };
  try {
    req = JSON.parse(line) as typeof req;
  } catch {
    send({ id: null, ok: false, error: 'bad-json', detail: null });
    return;
  }
  if (req.op === 'quit') {
    if (!s.ignoreQuit) process.exit(0);
    return;
  }
  requests++;
  if (typeof s.exitAfterRequests === 'number' && requests > s.exitAfterRequests) process.exit(3);
  if (req.op !== undefined && (s.hang ?? []).includes(req.op)) return;
  if (s.garbageBefore) send('{"id":');
  if (typeof s.oversizeBefore === 'number') send(`{"id":${req.id ?? 0},"ok":true,"pad":"${'x'.repeat(s.oversizeBefore)}"}`);
  switch (req.op) {
    case 'ping':
      send({ id: req.id, ok: true, pong: true, version: s.version ?? 1, dpi: s.dpi ?? 'permonitorv2', watching: 0, prunedRender: 0, prunedOther: 0 });
      return;
    case 'strip': {
      const v = s.strips?.[req.hwnd ?? ''];
      if (v === undefined) send({ id: req.id, ok: false, error: 'not-found', detail: null });
      else if (typeof v === 'object' && v !== null && 'error' in v) send({ id: req.id, ok: false, error: (v as { error: string }).error, detail: null });
      else send({ id: req.id, ok: true, strip: v });
      return;
    }
    case 'watch':
      send({ id: req.id, ok: true, watching: (req.hwnds ?? []).length, failed: [] });
      return;
    default:
      send({ id: req.id ?? null, ok: false, error: 'bad-op', detail: null });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.length > 0) handle(line);
    nl = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (readState().ignoreQuit) return;
  clearInterval(poll);
  process.exit(0);
});
