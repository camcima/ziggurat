import NodeCache from "node-cache";
import type { CacheEntry, MemoryAdapterOptions, TtlResult } from "./types.js";
import { BaseCacheAdapter } from "./base-cache-adapter.js";

export class MemoryAdapter extends BaseCacheAdapter {
  readonly name = "memory";
  private readonly cache: NodeCache;
  private readonly defaultTtlMs?: number;

  constructor(options: MemoryAdapterOptions = {}) {
    super();
    this.defaultTtlMs = options.defaultTtlMs;
    this.cache = new NodeCache({
      stdTTL: 0,
      checkperiod: 0,
      useClones: false,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const value = this.cache.get<T>(key);
    if (value === undefined) return null;

    const ttl = this.cache.getTtl(key);
    return {
      value,
      expiresAt: ttl === 0 || ttl === undefined ? null : ttl,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveTtl = this.defaultTtlMs ?? ttlMs;
    if (effectiveTtl !== undefined) {
      // ttlMs <= 0 means already expired — don't store
      if (effectiveTtl <= 0) return;
      this.cache.set(key, value, effectiveTtl / 1000);
    } else {
      this.cache.set(key, value, 0);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    this.cache.del(key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clear(): Promise<void> {
    this.cache.flushAll();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTtl(key: string): Promise<TtlResult> {
    if (!this.cache.has(key)) return { kind: "missing" };
    const ttl = this.cache.getTtl(key);
    if (ttl === undefined) return { kind: "missing" };
    if (ttl === 0) return { kind: "permanent" };
    return { kind: "expiring", ttlMs: Math.max(0, ttl - Date.now()) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async keys(): Promise<string[]> {
    return this.cache.keys();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async flushAll(): Promise<void> {
    this.cache.flushAll();
  }
}
