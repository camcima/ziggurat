import type { CacheEntry } from "@ziggurat-cache/core";
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { Client } from "memjs";

export interface MemcacheAdapterOptions {
  client: Client;
  prefix?: string;
  defaultTtlMs?: number;
}

export class MemcacheAdapter extends BaseCacheAdapter {
  readonly name = "memcache";
  private readonly client: Client;
  private readonly prefix: string;
  private readonly defaultTtlMs?: number;

  constructor(options: MemcacheAdapterOptions) {
    super();
    this.client = options.client;
    this.prefix = options.prefix ?? "";
    this.defaultTtlMs = options.defaultTtlMs;
  }

  private prefixedKey(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const result = await this.client.get(this.prefixedKey(key));
    if (result.value === null) return null;

    const entry = JSON.parse(result.value.toString()) as CacheEntry<T>;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      await this.client.delete(this.prefixedKey(key));
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

    // Memcached TTL is in seconds; 0 means no expiration
    const expiresSec =
      effectiveTtl !== undefined ? Math.ceil(effectiveTtl / 1000) : 0;
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
