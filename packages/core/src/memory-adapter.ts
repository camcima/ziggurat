import NodeCache from "node-cache";
import type { CacheEntry, MemoryAdapterOptions, TtlResult } from "./types.js";
import { BaseCacheAdapter } from "./base-cache-adapter.js";

/**
 * JSON.stringify is declared as returning string, but returns undefined for
 * undefined, functions, and symbols. Stating that honestly keeps the callers'
 * skip-the-write checks from looking like dead code.
 */
function stringifyOrUndefined(value: unknown): string | undefined {
  return JSON.stringify(value);
}

export class MemoryAdapter extends BaseCacheAdapter {
  readonly name = "memory";
  private readonly cache: NodeCache;
  private readonly serialization: "reference" | "json";
  private readonly maxKeys?: number;

  constructor(options: MemoryAdapterOptions = {}) {
    super(options);
    this.serialization = options.serialization ?? "reference";
    this.maxKeys = options.maxKeys;
    this.cache = new NodeCache({
      stdTTL: 0,
      checkperiod:
        options.checkPeriodMs !== undefined ? options.checkPeriodMs / 1000 : 0,
      useClones: false,
      maxKeys: options.maxKeys ?? -1,
    });
  }

  /** Stop the periodic expiry-check timer (no-op when checkPeriodMs is unset). */
  close(): void {
    this.cache.close();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = this.cache.get<unknown>(key);
    if (raw === undefined) return null;

    const value =
      this.serialization === "json"
        ? (JSON.parse(raw as string) as T)
        : (raw as T);
    const ttl = this.cache.getTtl(key);
    return {
      value,
      expiresAt: ttl === 0 || ttl === undefined ? null : ttl,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    // undefined is never stored — no backend can round-trip it, so every
    // adapter treats the write as a no-op (get/has/keys all report a miss).
    if (value === undefined) return;
    const effectiveTtl = this.resolveTtl(ttlMs);
    // ttlMs <= 0 means already expired — don't store
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return;
    let stored: unknown = value;
    if (this.serialization === "json") {
      // Functions and symbols serialize to undefined — skip those writes so
      // has()/keys() stay consistent with get() reporting a miss.
      const serialized = stringifyOrUndefined(value);
      if (serialized === undefined) return;
      stored = serialized;
    }
    // node-cache rejects ANY set at capacity, even overwrites of existing
    // keys; delete first so existing keys can always be refreshed.
    if (this.maxKeys !== undefined && this.cache.has(key)) {
      this.cache.del(key);
    }
    if (effectiveTtl !== undefined) {
      this.cache.set(key, stored, effectiveTtl / 1000);
    } else {
      this.cache.set(key, stored, 0);
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
