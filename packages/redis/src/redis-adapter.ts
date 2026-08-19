import type {
  AdapterTtlOptions,
  CacheEntry,
  CacheSetEntry,
} from "@ziggurat-cache/core";
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { Redis } from "ioredis";

export interface RedisAdapterOptions extends AdapterTtlOptions {
  client: Redis;
  prefix?: string;
  /**
   * Permit clear()/flushAll() when no `prefix` is configured. Without a
   * prefix those methods match every key in the database — including keys
   * written by other applications — so they refuse to run unless you opt in
   * here. Reads, writes, and deletes of individual keys are unaffected.
   */
  allowUnprefixedClear?: boolean;
}

export class RedisAdapter extends BaseCacheAdapter {
  readonly name = "redis";
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly allowUnprefixedClear: boolean;

  constructor(options: RedisAdapterOptions) {
    super(options);
    this.client = options.client;
    this.prefix = options.prefix ?? "";
    this.allowUnprefixedClear = options.allowUnprefixedClear ?? false;
  }

  private prefixedKey(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = await this.client.get(this.prefixedKey(key));
    if (raw === null) return null;

    let entry: CacheEntry<T>;
    try {
      entry = JSON.parse(raw) as CacheEntry<T>;
    } catch {
      // Corrupt/legacy payload — treat as a miss. Reads never delete: a
      // read-then-delete would race a concurrent writer refreshing the key,
      // and with an empty prefix it would reach keys this adapter does not
      // own. The next set() overwrites the bad payload anyway.
      return null;
    }

    // Redis enforces the real expiry via PSETEX; this envelope check is a
    // clock-skew backstop only, so it reports a miss without deleting — a
    // reader with a fast clock must not evict entries other nodes still see.
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      return null;
    }

    return entry;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    // undefined is never stored — JSON cannot round-trip it, and storing the
    // envelope without a value would read back as a hit carrying undefined.
    if (value === undefined) return;
    const effectiveTtl = this.resolveTtl(ttlMs);
    // ttlMs <= 0 means already expired — don't store
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return;
    const ttlInt =
      effectiveTtl !== undefined ? Math.ceil(effectiveTtl) : undefined;
    const expiresAt = ttlInt !== undefined ? Date.now() + ttlInt : null;
    const serialized = JSON.stringify({ value, expiresAt });
    const prefixed = this.prefixedKey(key);

    if (ttlInt !== undefined) {
      await this.client.psetex(prefixed, ttlInt, serialized);
    } else {
      await this.client.set(prefixed, serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefixedKey(key));
  }

  private static escapeGlob(literal: string): string {
    return literal.replace(/[\\*?[\]]/g, "\\$&");
  }

  /**
   * clear()/flushAll() delete every key matching `prefix + "*"`. With an
   * empty prefix that is the entire database, so refuse unless the caller
   * explicitly opted in via `allowUnprefixedClear`.
   */
  private assertClearIsScoped(): void {
    if (this.prefix === "" && !this.allowUnprefixedClear) {
      throw new Error(
        "RedisAdapter.clear()/flushAll() would delete every key in the database because no prefix is configured. " +
          "Set a `prefix`, or pass `allowUnprefixedClear: true` if wiping the whole database is intended.",
      );
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }

  private checkPipelineErrors(
    results: Array<[Error | null, unknown]> | null,
  ): void {
    if (!results) return;
    const errors = results
      .filter(([err]) => err !== null)
      .map(([err]) => err as Error);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${String(errors.length)} Redis pipeline command(s) failed`,
      );
    }
  }

  async clear(): Promise<void> {
    this.assertClearIsScoped();
    const pattern = RedisAdapter.escapeGlob(this.prefix) + "*";
    const keys = await this.scanKeys(pattern);
    if (keys.length > 0) {
      const pipeline = this.client.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      const results = await pipeline.exec();
      this.checkPipelineErrors(results);
    }
  }

  async keys(): Promise<string[]> {
    const pattern = RedisAdapter.escapeGlob(this.prefix) + "*";
    const rawKeys = await this.scanKeys(pattern);
    return rawKeys.map((k) => (this.prefix ? k.slice(this.prefix.length) : k));
  }

  async mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    if (keys.length === 0) return new Map();

    const prefixedKeys = keys.map((k) => this.prefixedKey(k));
    const pipeline = this.client.pipeline();
    for (const pk of prefixedKeys) {
      pipeline.get(pk);
    }
    const results = await pipeline.exec();
    const map = new Map<string, CacheEntry<T>>();

    if (!results) return map;

    for (let i = 0; i < keys.length; i++) {
      const [err, raw] = results[i] as [Error | null, string | null];
      if (err || raw === null) continue;

      let entry: CacheEntry<T>;
      try {
        entry = JSON.parse(raw) as CacheEntry<T>;
      } catch {
        // Corrupt/legacy payload — a miss, deleted by nobody. See get().
        continue;
      }
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        continue;
      }
      map.set(keys[i], entry);
    }

    return map;
  }

  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.client.pipeline();
    let queued = 0;
    for (const entry of entries) {
      // undefined is never stored — see set().
      if (entry.value === undefined) continue;
      const effectiveTtl = this.resolveTtl(entry.ttlMs);
      // ttlMs <= 0 means already expired — don't store
      if (effectiveTtl !== undefined && effectiveTtl <= 0) continue;
      const ttlInt =
        effectiveTtl !== undefined ? Math.ceil(effectiveTtl) : undefined;
      const expiresAt = ttlInt !== undefined ? Date.now() + ttlInt : null;
      const serialized = JSON.stringify({ value: entry.value, expiresAt });
      const prefixed = this.prefixedKey(entry.key);

      if (ttlInt !== undefined) {
        pipeline.psetex(prefixed, ttlInt, serialized);
      } else {
        pipeline.set(prefixed, serialized);
      }
      queued++;
    }
    if (queued === 0) return;
    const results = await pipeline.exec();
    this.checkPipelineErrors(results);
  }

  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const prefixedKeys = keys.map((k) => this.prefixedKey(k));
    await this.client.del(...prefixedKeys);
  }
}
