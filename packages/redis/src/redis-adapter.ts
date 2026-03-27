import type { CacheEntry, CacheSetEntry } from "@ziggurat-cache/core";
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { Redis } from "ioredis";

export interface RedisAdapterOptions {
  client: Redis;
  prefix?: string;
  defaultTtlMs?: number;
}

export class RedisAdapter extends BaseCacheAdapter {
  readonly name = "redis";
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly defaultTtlMs?: number;

  constructor(options: RedisAdapterOptions) {
    super();
    this.client = options.client;
    this.prefix = options.prefix ?? "";
    this.defaultTtlMs = options.defaultTtlMs;
  }

  private prefixedKey(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = await this.client.get(this.prefixedKey(key));
    if (raw === null) return null;

    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      await this.client.del(this.prefixedKey(key));
      return null;
    }

    return entry;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveTtl = this.defaultTtlMs ?? ttlMs;
    // ttlMs <= 0 means already expired — don't store
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return;
    const expiresAt =
      effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
    const serialized = JSON.stringify({ value, expiresAt });
    const prefixed = this.prefixedKey(key);

    if (effectiveTtl !== undefined) {
      await this.client.psetex(prefixed, effectiveTtl, serialized);
    } else {
      await this.client.set(prefixed, serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefixedKey(key));
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
    const pattern = this.prefix + "*";
    const keys = await this.scanKeys(pattern);
    if (keys.length > 0) {
      const pipeline = this.client.pipeline();
      for (const key of keys) {
        pipeline.del(key);
      }
      const results = await pipeline.exec();
      this.checkPipelineErrors(
        results as Array<[Error | null, unknown]> | null,
      );
    }
  }

  async keys(): Promise<string[]> {
    const pattern = this.prefix + "*";
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

      const entry = JSON.parse(raw) as CacheEntry<T>;
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
      const effectiveTtl = this.defaultTtlMs ?? entry.ttlMs;
      // ttlMs <= 0 means already expired — don't store
      if (effectiveTtl !== undefined && effectiveTtl <= 0) continue;
      const expiresAt =
        effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
      const serialized = JSON.stringify({ value: entry.value, expiresAt });
      const prefixed = this.prefixedKey(entry.key);

      if (effectiveTtl !== undefined) {
        pipeline.psetex(prefixed, effectiveTtl, serialized);
      } else {
        pipeline.set(prefixed, serialized);
      }
      queued++;
    }
    if (queued === 0) return;
    const results = await pipeline.exec();
    this.checkPipelineErrors(results as Array<[Error | null, unknown]> | null);
  }

  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const prefixedKeys = keys.map((k) => this.prefixedKey(k));
    await this.client.del(...prefixedKeys);
  }

  async flushAll(): Promise<void> {
    await this.client.flushdb();
  }
}
