import { TypedEventEmitter } from "./event-emitter.js";
import type {
  CacheAdapter,
  CacheEntry,
  CacheErrorEvent,
  CacheEventMap,
  CacheManagerOptions,
  CacheSetEntry,
  StampedeConfig,
  TtlResult,
} from "./types.js";
import type { Listener } from "./event-emitter.js";

export class CacheManager {
  private readonly layers: CacheAdapter[];
  private readonly namespace?: string;
  private readonly stampedeConfig: Required<StampedeConfig>;
  private readonly syncBackfill: boolean;
  private readonly inFlightFetches = new Map<string, Promise<unknown>>();
  private readonly events: TypedEventEmitter<CacheEventMap>;

  constructor(options: CacheManagerOptions) {
    this.layers = options.layers;
    this.namespace = options.namespace;
    this.syncBackfill = options.syncBackfill ?? false;
    this.stampedeConfig = {
      coalesce: true,
      ...options.stampede,
    };
    this.events = options.events ?? new TypedEventEmitter<CacheEventMap>();
  }

  on<K extends keyof CacheEventMap>(
    event: K,
    listener: Listener<CacheEventMap[K]>,
  ): () => void {
    return this.events.on(event, listener);
  }

  getLayers(): readonly CacheAdapter[] {
    return [...this.layers];
  }

  private namespacedKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const nsKey = this.namespacedKey(key);
    const shouldEmit =
      this.events.hasListeners("hit") ||
      this.events.hasListeners("miss") ||
      this.events.hasListeners("error") ||
      this.events.hasListeners("backfill");
    const start = shouldEmit ? performance.now() : 0;

    for (let i = 0; i < this.layers.length; i++) {
      let entry: CacheEntry<T> | null;
      try {
        entry = await this.layers[i].get<T>(nsKey);
      } catch (error) {
        if (shouldEmit) {
          this.events.emit("error", {
            key,
            namespace: this.namespace,
            operation: "get",
            layerName: this.layers[i].name,
            layerIndex: i,
            error,
          });
        }
        continue;
      }

      if (entry !== null) {
        if (shouldEmit) {
          this.events.emit("hit", {
            key,
            namespace: this.namespace,
            layerName: this.layers[i].name,
            layerIndex: i,
            durationMs: performance.now() - start,
          });
        }
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
          if (shouldEmit) {
            this.events.emit("backfill", {
              key,
              namespace: this.namespace,
              sourceLayerName: this.layers[i].name,
              sourceLayerIndex: i,
              targetLayerNames: backfillLayers.map((l) => l.name),
            });
          }
          if (this.syncBackfill) {
            await backfillPromise;
          }
        }
        return entry;
      }
    }

    if (shouldEmit) {
      this.events.emit("miss", {
        key,
        namespace: this.namespace,
        durationMs: performance.now() - start,
      });
    }
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const nsKey = this.namespacedKey(key);
    const shouldEmit =
      this.events.hasListeners("set") || this.events.hasListeners("error");
    const start = shouldEmit ? performance.now() : 0;

    const results = await Promise.allSettled(
      this.layers.map((layer) => layer.set(nsKey, value, ttlMs)),
    );

    if (shouldEmit) {
      this.emitWriteErrors(results, key, "set");
      this.events.emit("set", {
        key,
        namespace: this.namespace,
        ttlMs,
        durationMs: performance.now() - start,
      });
    }
  }

  async delete(key: string): Promise<void> {
    const nsKey = this.namespacedKey(key);
    const shouldEmit =
      this.events.hasListeners("delete") || this.events.hasListeners("error");
    const start = shouldEmit ? performance.now() : 0;

    const results = await Promise.allSettled(
      this.layers.map((layer) => layer.delete(nsKey)),
    );

    if (shouldEmit) {
      this.emitWriteErrors(results, key, "delete");
      this.events.emit("delete", {
        key,
        namespace: this.namespace,
        durationMs: performance.now() - start,
      });
    }
  }

  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const shouldEmit =
      this.events.hasListeners("wrap:hit") ||
      this.events.hasListeners("wrap:miss") ||
      this.events.hasListeners("wrap:coalesce");
    const start = shouldEmit ? performance.now() : 0;

    const cachedEntry = await this.get<T>(key);
    if (cachedEntry !== null) {
      if (shouldEmit) {
        this.events.emit("wrap:hit", {
          key,
          namespace: this.namespace,
          durationMs: performance.now() - start,
        });
      }
      return cachedEntry.value;
    }

    if (this.stampedeConfig.coalesce && this.inFlightFetches.has(key)) {
      if (shouldEmit) {
        this.events.emit("wrap:coalesce", {
          key,
          namespace: this.namespace,
        });
      }
      return this.inFlightFetches.get(key) as Promise<T>;
    }

    const fetchPromise = (async () => {
      const factoryStart = shouldEmit ? performance.now() : 0;
      try {
        const value = await factory();
        if (shouldEmit) {
          const factoryDurationMs = performance.now() - factoryStart;
          this.events.emit("wrap:miss", {
            key,
            namespace: this.namespace,
            durationMs: performance.now() - start,
            factoryDurationMs,
          });
        }
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

    const shouldEmit =
      this.events.hasListeners("mget") ||
      this.events.hasListeners("error") ||
      this.events.hasListeners("backfill");
    const start = shouldEmit ? performance.now() : 0;

    const nsKeys = keys.map((k) => this.namespacedKey(k));
    const keyMap = new Map(keys.map((k, i) => [nsKeys[i], k]));
    const result = new Map<string, CacheEntry<T>>();
    const remaining = new Set(nsKeys);

    for (let i = 0; i < this.layers.length; i++) {
      if (remaining.size === 0) break;

      let layerResult: Map<string, CacheEntry<T>>;
      try {
        layerResult = await this.layers[i].mget<T>([...remaining]);
      } catch (error) {
        if (shouldEmit) {
          this.events.emit("error", {
            key: keys.join(","),
            namespace: this.namespace,
            operation: "mget",
            layerName: this.layers[i].name,
            layerIndex: i,
            error,
          });
        }
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
        if (shouldEmit) {
          for (const { nsKey } of foundInThisLayer) {
            const originalKey = keyMap.get(nsKey);
            if (originalKey !== undefined) {
              this.events.emit("backfill", {
                key: originalKey,
                namespace: this.namespace,
                sourceLayerName: this.layers[i].name,
                sourceLayerIndex: i,
                targetLayerNames: backfillLayers.map((l) => l.name),
              });
            }
          }
        }
        if (this.syncBackfill) {
          await backfillPromise;
        }
      }
    }

    if (shouldEmit && this.events.hasListeners("mget")) {
      this.events.emit("mget", {
        keys,
        namespace: this.namespace,
        hitCount: result.size,
        missCount: keys.length - result.size,
        durationMs: performance.now() - start,
      });
    }

    return result;
  }

  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    if (entries.length === 0) return;
    const shouldEmit =
      this.events.hasListeners("mset") || this.events.hasListeners("error");
    const start = shouldEmit ? performance.now() : 0;

    const nsEntries = entries.map((e) => ({
      key: this.namespacedKey(e.key),
      value: e.value,
      ttlMs: e.ttlMs,
    }));
    const results = await Promise.allSettled(
      this.layers.map((layer) => layer.mset(nsEntries)),
    );

    if (shouldEmit) {
      this.emitWriteErrors(
        results,
        entries.map((e) => e.key).join(","),
        "mset",
      );
      this.events.emit("mset", {
        keyCount: entries.length,
        namespace: this.namespace,
        durationMs: performance.now() - start,
      });
    }
  }

  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const shouldEmit =
      this.events.hasListeners("mdel") || this.events.hasListeners("error");
    const start = shouldEmit ? performance.now() : 0;

    const nsKeys = keys.map((k) => this.namespacedKey(k));
    const results = await Promise.allSettled(
      this.layers.map((layer) => layer.mdel(nsKeys)),
    );

    if (shouldEmit) {
      this.emitWriteErrors(results, keys.join(","), "mdel");
      this.events.emit("mdel", {
        keyCount: keys.length,
        namespace: this.namespace,
        durationMs: performance.now() - start,
      });
    }
  }

  async getTtl(key: string): Promise<TtlResult> {
    const nsKey = this.namespacedKey(key);
    for (let i = 0; i < this.layers.length; i++) {
      let ttlResult: TtlResult;
      try {
        ttlResult = await this.layers[i].getTtl(nsKey);
      } catch (error) {
        if (this.events.hasListeners("error")) {
          this.events.emit("error", {
            key,
            namespace: this.namespace,
            operation: "getTtl",
            layerName: this.layers[i].name,
            layerIndex: i,
            error,
          });
        }
        continue;
      }
      if (ttlResult.kind !== "missing") {
        return ttlResult;
      }
    }
    return { kind: "missing" };
  }

  private emitWriteErrors(
    results: PromiseSettledResult<void>[],
    key: string,
    operation: CacheErrorEvent["operation"],
  ): void {
    if (!this.events.hasListeners("error")) return;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        this.events.emit("error", {
          key,
          namespace: this.namespace,
          operation,
          layerName: this.layers[i].name,
          layerIndex: i,
          error: r.reason,
        });
      }
    }
  }

  async has(key: string): Promise<boolean> {
    const nsKey = this.namespacedKey(key);
    for (let i = 0; i < this.layers.length; i++) {
      try {
        if (await this.layers[i].has(nsKey)) return true;
      } catch (error) {
        if (this.events.hasListeners("error")) {
          this.events.emit("error", {
            key,
            namespace: this.namespace,
            operation: "has",
            layerName: this.layers[i].name,
            layerIndex: i,
            error,
          });
        }
        continue;
      }
    }
    return false;
  }
}
