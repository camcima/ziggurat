import type {
  CacheAdapter,
  CacheEntry,
  CacheSetEntry,
  TtlResult,
} from "./types.js";

export abstract class BaseCacheAdapter implements CacheAdapter {
  abstract readonly name: string;
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

  async mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    const result = new Map<string, CacheEntry<T>>();
    await Promise.all(
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
