import type {
  AdapterTtlOptions,
  AdapterTtlPolicy,
  CacheAdapter,
  CacheEntry,
  CacheSetEntry,
  TtlResult,
} from "./types.js";

export abstract class BaseCacheAdapter implements CacheAdapter {
  abstract readonly name: string;
  /** This layer's own TTL policy; read by CacheManager when backfilling. */
  readonly ttlPolicy: AdapterTtlPolicy;

  constructor(ttlOptions: AdapterTtlOptions = {}) {
    BaseCacheAdapter.assertValidTtlOption(
      "defaultTtlMs",
      ttlOptions.defaultTtlMs,
    );
    BaseCacheAdapter.assertValidTtlOption("maxTtlMs", ttlOptions.maxTtlMs);
    this.ttlPolicy = Object.freeze({
      defaultTtlMs: ttlOptions.defaultTtlMs,
      maxTtlMs: ttlOptions.maxTtlMs,
    });
  }

  private static assertValidTtlOption(
    name: string,
    value: number | undefined,
  ): void {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(
        `${name} must be a finite, non-negative number of milliseconds (received ${String(value)}).`,
      );
    }
  }

  /**
   * Resolve the effective TTL: explicit ttlMs wins over defaultTtlMs;
   * maxTtlMs caps the result (and bounds permanent entries).
   * Returns undefined (no expiry) only when none of ttlMs, defaultTtlMs,
   * or maxTtlMs is set.
   * Throws when ttlMs is non-finite (NaN or ±Infinity).
   */
  protected resolveTtl(ttlMs?: number): number | undefined {
    if (ttlMs !== undefined && !Number.isFinite(ttlMs)) {
      throw new Error(
        `ttlMs must be a finite number of milliseconds (received ${String(ttlMs)}).`,
      );
    }
    const { defaultTtlMs, maxTtlMs } = this.ttlPolicy;
    const requested = ttlMs ?? defaultTtlMs;
    if (maxTtlMs === undefined) return requested;
    if (requested === undefined) return maxTtlMs;
    return Math.min(requested, maxTtlMs);
  }

  abstract get<T>(key: string): Promise<CacheEntry<T> | null>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  abstract set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  abstract delete(key: string): Promise<void>;
  abstract clear(): Promise<void>;

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async getTtl(key: string): Promise<TtlResult> {
    const entry = await this.get(key);
    if (entry === null) return { kind: "missing" };
    if (entry.expiresAt === null) return { kind: "permanent" };
    return {
      kind: "expiring",
      ttlMs: Math.max(0, entry.expiresAt - Date.now()),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async keys(): Promise<string[]> {
    throw new Error(
      `${this.name} does not support key enumeration. Override keys() to enable.`,
    );
  }

  /**
   * Reads each key individually. Per-key failures are skipped rather than
   * rejecting the whole batch, so callers get a partial result Map — the
   * behavior every adapter is held to by the contract suite. Writes keep the
   * opposite policy: a failed mset/mdel rejects so the layer is reported as
   * having failed the write.
   */
  async mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    const result = new Map<string, CacheEntry<T>>();
    await Promise.allSettled(
      keys.map(async (key) => {
        const entry = await this.get<T>(key);
        if (entry !== null) result.set(key, entry);
      }),
    );
    return result;
  }

  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    await Promise.all(entries.map((e) => this.set(e.key, e.value, e.ttlMs)));
  }

  async mdel(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((k) => this.delete(k)));
  }

  async flushAll(): Promise<void> {
    await this.clear();
  }
}
