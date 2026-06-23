import type { AdapterTtlOptions, CacheEntry } from "@ziggurat-cache/core";
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { Client } from "memjs";

export interface MemcacheAdapterOptions extends AdapterTtlOptions {
  client: Client;
  prefix?: string;
}

// Memcached interprets relative `expires` values above 30 days as an
// absolute unix timestamp, so larger TTLs must be sent as one.
const MEMCACHE_MAX_RELATIVE_EXPIRES_SEC = 60 * 60 * 24 * 30;

export class MemcacheAdapter extends BaseCacheAdapter {
  readonly name = "memcache";
  private readonly client: Client;
  private readonly prefix: string;

  constructor(options: MemcacheAdapterOptions) {
    super(options);
    this.client = options.client;
    this.prefix = options.prefix ?? "";
  }

  private prefixedKey(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const result = await this.client.get(this.prefixedKey(key));
    if (result.value === null) return null;

    let entry: CacheEntry<T>;
    try {
      entry = JSON.parse(result.value.toString()) as CacheEntry<T>;
    } catch {
      // Corrupt/legacy payload — delete and treat as a miss
      await this.client.delete(this.prefixedKey(key));
      return null;
    }

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      await this.client.delete(this.prefixedKey(key));
      return null;
    }

    return entry;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveTtl = this.resolveTtl(ttlMs);
    // ttlMs <= 0 means already expired — don't store
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return;
    const expiresAt =
      effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
    const serialized = JSON.stringify({ value, expiresAt });
    const prefixed = this.prefixedKey(key);

    // Memcached TTL is in seconds; 0 means no expiration.
    let expiresSec = 0;
    if (effectiveTtl !== undefined) {
      expiresSec = Math.ceil(effectiveTtl / 1000);
      if (expiresSec > MEMCACHE_MAX_RELATIVE_EXPIRES_SEC) {
        // Send as an absolute unix timestamp (seconds) for >30-day TTLs.
        expiresSec = Math.ceil((Date.now() + effectiveTtl) / 1000);
      }
    }
    await this.client.set(prefixed, serialized, { expires: expiresSec });
  }

  async delete(key: string): Promise<void> {
    await this.client.delete(this.prefixedKey(key));
  }

  async clear(): Promise<void> {
    // Memcached has no namespace-scoped clear; flush is global
    await this.client.flush();
  }

  async flushAll(): Promise<void> {
    await this.client.flush();
  }
}
