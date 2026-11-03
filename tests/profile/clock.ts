// A synchronous timer heap on a virtual clock: the real host loop, the activity sampling, the
// desktop and the synthetic user all run on it, so a 3 sim-h run takes about a second.

interface TimerEntry {
  at: number;
  seq: number;
  fn: () => void;
}

export class VirtualClock {
  now = 0;
  private seq = 0;
  private heap: TimerEntry[] = [];
  private live = new Set<number>();

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.live.add(id);
    this.push({ at: this.now + Math.max(0, Number.isFinite(ms) ? ms : 0), seq: id, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    if (typeof h === 'number') this.live.delete(h);
  }
  runUntil(end: number): void {
    for (;;) {
      const top = this.heap[0];
      if (!top || top.at > end) break;
      this.pop();
      if (!this.live.delete(top.seq)) continue;
      this.now = Math.max(this.now, top.at);
      top.fn();
    }
    this.now = Math.max(this.now, end);
  }
  private less(a: TimerEntry, b: TimerEntry): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
  private push(e: TimerEntry): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): void {
    const h = this.heap;
    const last = h.pop();
    if (h.length === 0 || !last) return;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}
