export interface PlotStore {
  put(key: string, png: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

/**
 * Bounded in-memory PNG cache. New entries evict the oldest key when the
 * map is full. This is enough for the current weekly-calibration use case;
 * a future migration to S3/R2 can implement the same interface.
 */
export class InMemoryPlotStore implements PlotStore {
  private readonly store = new Map<string, Buffer>();

  constructor(private readonly maxEntries: number = 256) {
    if (maxEntries <= 0) {
      throw new Error("InMemoryPlotStore: maxEntries must be > 0");
    }
  }

  async put(key: string, png: Buffer): Promise<void> {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, Buffer.from(png));
  }

  async get(key: string): Promise<Buffer | null> {
    const v = this.store.get(key);
    return v ? Buffer.from(v) : null;
  }

  size(): number {
    return this.store.size;
  }
}
