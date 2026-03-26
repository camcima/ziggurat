import type {
  CacheAdapter,
  CacheEntry,
  CacheManagerOptions,
  CacheSetEntry,
  StampedeConfig,
  TtlResult,
} from "./types.js";

export class CacheManager {
  private readonly layers: CacheAdapter[];
  private readonly namespace?: string;
  private readonly stampedeConfig: Required<StampedeConfig>;
  private readonly syncBackfill: boolean;
  private readonly inFlightFetches = new Map<string, Promise<unknown>>();

  constructor(options: CacheManagerOptions) {
    this.layers = options.layers;
    this.namespace = options.namespace;
    this.syncBackfill = options.syncBackfill ?? false;
    this.stampedeConfig = {
      coalesce: true,
      ...options.stampede,
    };
  }

  getLayers(): readonly CacheAdapter[] {
    return [...this.layers];
  }

  private namespacedKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const nsKey = this.namespacedKey(key);
    for (let i = 0; i < this.layers.length; i++) {
      let entry: CacheEntry<T> | null;
      try {
        entry = await this.layers[i].get<T>(nsKey);
      } catch {
        continue;
      }

      if (entry !== null) {
        if (i > 0) {
          const backfillLayers = this.layers.slice(0, i);
          const remainingTtlMs =
            entry.expiresAt !== null
              ? Math.max(0, entry.expiresAt - Date.now())
              : undefined;
          const backfillPromise = Promise.allSettled(
            backfillLayers.map((layer) =>
              layer.set(nsKey, entry.value, remainingTtlMs),
            ),
          );
          if (this.syncBackfill) {
            await backfillPromise;
          }
        }
        return entry;
      }
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const nsKey = this.namespacedKey(key);
    await Promise.allSettled(
      this.layers.map((layer) => layer.set(nsKey, value, ttlMs)),
    );
  }

  async delete(key: string): Promise<void> {
    const nsKey = this.namespacedKey(key);
    await Promise.allSettled(this.layers.map((layer) => layer.delete(nsKey)));
  }

  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cachedEntry = await this.get<T>(key);
    if (cachedEntry !== null) {
      return cachedEntry.value;
    }

    if (this.stampedeConfig.coalesce && this.inFlightFetches.has(key)) {
      return this.inFlightFetches.get(key) as Promise<T>;
    }

    const fetchPromise = (async () => {
      try {
        const value = await factory();
        await this.set(key, value, ttlMs);
        return value;
      } finally {
        if (this.stampedeConfig.coalesce) {
          this.inFlightFetches.delete(key);
        }
      }
    })();

    if (this.stampedeConfig.coalesce) {
      this.inFlightFetches.set(key, fetchPromise);
    }

    return fetchPromise;
  }

  async del(key: string): Promise<void> {
    return this.delete(key);
  }

  async mget<T>(keys: string[]): Promise<Map<string, CacheEntry<T>>> {
    if (keys.length === 0) return new Map();

    const nsKeys = keys.map((k) => this.namespacedKey(k));
    const keyMap = new Map(keys.map((k, i) => [nsKeys[i], k]));
    const result = new Map<string, CacheEntry<T>>();
    const remaining = new Set(nsKeys);

    for (let i = 0; i < this.layers.length; i++) {
      if (remaining.size === 0) break;

      let layerResult: Map<string, CacheEntry<T>>;
      try {
        layerResult = await this.layers[i].mget<T>([...remaining]);
      } catch {
        continue;
      }

      const foundInThisLayer: Array<{
        nsKey: string;
        entry: CacheEntry<T>;
      }> = [];

      for (const [nsKey, entry] of layerResult) {
        const originalKey = keyMap.get(nsKey);
        if (originalKey === undefined) continue;
        result.set(originalKey, entry);
        remaining.delete(nsKey);
        if (i > 0) {
          foundInThisLayer.push({ nsKey, entry });
        }
      }

      if (foundInThisLayer.length > 0) {
        const backfillLayers = this.layers.slice(0, i);
        const backfillEntries = foundInThisLayer.map(({ nsKey, entry }) => ({
          key: nsKey,
          value: entry.value,
          ttlMs:
            entry.expiresAt !== null
              ? Math.max(0, entry.expiresAt - Date.now())
              : undefined,
        }));
        const backfillPromise = Promise.allSettled(
          backfillLayers.map((layer) => layer.mset(backfillEntries)),
        );
        if (this.syncBackfill) {
          await backfillPromise;
        }
      }
    }

    return result;
  }

  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    if (entries.length === 0) return;
    const nsEntries = entries.map((e) => ({
      key: this.namespacedKey(e.key),
      value: e.value,
      ttlMs: e.ttlMs,
    }));
    await Promise.allSettled(this.layers.map((layer) => layer.mset(nsEntries)));
  }

  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const nsKeys = keys.map((k) => this.namespacedKey(k));
    await Promise.allSettled(this.layers.map((layer) => layer.mdel(nsKeys)));
  }

  async getTtl(key: string): Promise<TtlResult> {
    const nsKey = this.namespacedKey(key);
    for (const layer of this.layers) {
      let ttlResult: TtlResult;
      try {
        ttlResult = await layer.getTtl(nsKey);
      } catch {
        continue;
      }
      if (ttlResult.kind !== "missing") {
        return ttlResult;
      }
    }
    return { kind: "missing" };
  }

  async has(key: string): Promise<boolean> {
    const nsKey = this.namespacedKey(key);
    for (const layer of this.layers) {
      try {
        if (await layer.has(nsKey)) return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}
