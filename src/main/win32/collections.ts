/** Bounded least-recently-used map. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (!(capacity >= 1)) throw new RangeError('LruCache capacity must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Fixed-capacity FIFO that drops the oldest entry when full and counts drops. */
export class BoundedQueue<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;
  private dropCount = 0;

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new RangeError('BoundedQueue capacity must be >= 1');
    this.items = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Total entries dropped because the queue was full. */
  get dropped(): number {
    return this.dropCount;
  }

  push(item: T): void {
    if (this.count === this.capacity) {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropCount++;
      return;
    }
    this.items[(this.head + this.count) % this.capacity] = item;
    this.count++;
  }

  drain(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.capacity;
      out.push(this.items[idx] as T);
      this.items[idx] = undefined;
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  clear(): void {
    this.drain();
  }
}
