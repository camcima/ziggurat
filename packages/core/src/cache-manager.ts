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

/**
 * One wrap() in progress for a key. A mutation of the key marks it
 * invalidated: its callers still receive the computed value, but the value is
 * not written back over the newer mutation, and later callers do not join it.
 */
interface WrapOperation {
  promise: Promise<unknown>;
  invalidated: boolean;
}

export class CacheManager {
  private readonly layers: CacheAdapter[];
  private readonly namespace?: string;
  private readonly stampedeConfig: Required<StampedeConfig>;
  private readonly syncBackfill: boolean;
  private readonly strictWrites: boolean;
  private readonly wrapWrites: "await" | "background";
  // Every wrap() in progress, per key — tracked with coalescing disabled too,
  // so mutations can fence all of them. With coalescing enabled a key has at
  // most one live (non-invalidated) operation, the one later callers join.
  private readonly inFlightWraps = new Map<string, Set<WrapOperation>>();
  private readonly events: TypedEventEmitter<CacheEventMap>;

  constructor(options: CacheManagerOptions) {
    if (options.layers.length === 0) {
      throw new Error("CacheManager requires at least one layer");
    }
    this.layers = [...options.layers];
    this.namespace = options.namespace;
    this.syncBackfill = options.syncBackfill ?? false;
    this.strictWrites = options.strictWrites ?? false;
    this.wrapWrites = options.wrapWrites ?? "await";
    this.stampedeConfig = {
      coalesce: options.stampede?.coalesce ?? true,
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

  /**
   * TTL for a copy backfilled into `layer`: that layer's own defaultTtlMs
   * when it declares one, capped by the source entry's remaining lifetime so
   * a backfilled copy never outlives the entry it came from. A permanent
   * source entry passes no explicit TTL, leaving the target free to apply its
   * own policy. Layers that expose no ttlPolicy (custom adapters not built on
   * BaseCacheAdapter) receive the remaining lifetime unchanged.
   */
  private backfillTtlMs(
    layer: CacheAdapter,
    expiresAt: number | null,
  ): number | undefined {
    if (expiresAt === null) return undefined;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    const layerDefaultMs = layer.ttlPolicy?.defaultTtlMs;
    return layerDefaultMs === undefined
      ? remainingMs
      : Math.min(remainingMs, layerDefaultMs);
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
          // backfillLayers === this.layers.slice(0, i), so results[] indices align with emitWriteErrors' this.layers[] indexing
          const backfillPromise = Promise.allSettled(
            backfillLayers.map((layer) =>
              layer.set(
                nsKey,
                entry.value,
                this.backfillTtlMs(layer, entry.expiresAt),
              ),
            ),
          ).then((results) => {
            this.emitWriteErrors(results, key, "backfill");
          });
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
  private async setLayers<T>(
    key: string,
    value: T,
    ttlMs?: number,
  ): Promise<PromiseSettledResult<void>[]> {
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
    return results;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.invalidateInFlight([key]);
    const results = await this.setLayers(key, value, ttlMs);
    this.assertWritesSucceeded(results, "set");
  }

  async delete(key: string): Promise<void> {
    this.invalidateInFlight([key]);
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
    this.assertWritesSucceeded(results, "delete");
  }

  /**
   * Returns the cached value for `key`, or calls `factory` to compute it.
   * The computed value is always returned even if caching it fails — write
   * errors surface via "error" events regardless of `strictWrites`.
   *
   * With coalescing enabled, the whole lookup/compute/write operation is
   * shared per key: a caller arriving while one is in progress joins it
   * rather than starting its own lookup. A set/delete/mset/mdel of the key
   * detaches in-progress operations, which then skip their cache write.
   */
  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const ops = this.inFlightWraps.get(key);
    if (this.stampedeConfig.coalesce && ops !== undefined) {
      // At most one live operation per key while coalescing; invalidated ones
      // were removed from the map by invalidateInFlight().
      const [joined] = ops;
      if (this.events.hasListeners("wrap:coalesce")) {
        this.events.emit("wrap:coalesce", {
          key,
          namespace: this.namespace,
        });
      }
      return joined.promise as Promise<T>;
    }

    const op: WrapOperation = {
      promise: Promise.resolve(),
      invalidated: false,
    };
    const promise = this.runWrap(key, factory, ttlMs, op);
    op.promise = promise;
    // Registered before runWrap() resumes from its first await, so no caller
    // can slip past, and removed only after it settles — even when the
    // factory throws synchronously.
    let registered = ops;
    if (registered === undefined) {
      registered = new Set();
      this.inFlightWraps.set(key, registered);
    }
    registered.add(op);
    const settle = (): void => {
      const current = this.inFlightWraps.get(key);
      if (current?.delete(op) && current.size === 0) {
        this.inFlightWraps.delete(key);
      }
    };
    // settle never throws, so the derived promise never rejects.
    void promise.then(settle, settle);
    return promise;
  }

  private async runWrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs: number | undefined,
    op: WrapOperation,
  ): Promise<T> {
    const shouldEmit =
      this.events.hasListeners("wrap:hit") ||
      this.events.hasListeners("wrap:miss");
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

    const factoryStart = shouldEmit ? performance.now() : 0;
    const value = await factory();
    const factoryDurationMs = shouldEmit ? performance.now() - factoryStart : 0;
    if (!op.invalidated) {
      const writes = this.setLayers(key, value, ttlMs);
      // setLayers() collects results with allSettled and never rejects, so
      // the backgrounded promise cannot surface as an unhandled rejection.
      if (this.wrapWrites === "await") {
        await writes;
      } else {
        void writes;
      }
    }
    // Emitted once the caller's wait is over, so durationMs is the latency
    // the caller saw — including awaited writes, excluding background ones.
    if (shouldEmit) {
      this.events.emit("wrap:miss", {
        key,
        namespace: this.namespace,
        durationMs: performance.now() - start,
        factoryDurationMs,
      });
    }
    return value;
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

    // Deduplicate first: the result Map collapses repeated keys anyway, so
    // counting them individually would inflate missCount in the mget event.
    const uniqueKeys = [...new Set(keys)];
    const nsKeys = uniqueKeys.map((k) => this.namespacedKey(k));
    const keyMap = new Map(uniqueKeys.map((k, i) => [nsKeys[i], k]));
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
            key: uniqueKeys.join(","),
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
        const backfillKeys = foundInThisLayer
          .map(({ nsKey }) => keyMap.get(nsKey))
          .filter((k): k is string => k !== undefined);
        // backfillLayers === this.layers.slice(0, i), so results[] indices align with emitWriteErrors' this.layers[] indexing
        const backfillPromise = Promise.allSettled(
          backfillLayers.map((layer) =>
            layer.mset(
              foundInThisLayer.map(({ nsKey, entry }) => ({
                key: nsKey,
                value: entry.value,
                ttlMs: this.backfillTtlMs(layer, entry.expiresAt),
              })),
            ),
          ),
        ).then((results) => {
          this.emitWriteErrors(results, backfillKeys.join(","), "backfill");
        });
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
        keys: uniqueKeys,
        namespace: this.namespace,
        hitCount: result.size,
        missCount: uniqueKeys.length - result.size,
        durationMs: performance.now() - start,
      });
    }

    return result;
  }

  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    if (entries.length === 0) return;
    this.invalidateInFlight(entries.map((e) => e.key));
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
    this.assertWritesSucceeded(results, "mset");
  }

  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    this.invalidateInFlight(keys);
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
    this.assertWritesSucceeded(results, "mdel");
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

  /**
   * Detach every in-flight wrap() for these keys so none of them writes a
   * value computed before this mutation, or is joined by a later caller.
   * Called synchronously at the start of a mutation, before any await.
   */
  private invalidateInFlight(keys: Iterable<string>): void {
    for (const key of keys) {
      const ops = this.inFlightWraps.get(key);
      if (ops === undefined) continue;
      for (const op of ops) op.invalidated = true;
      this.inFlightWraps.delete(key);
    }
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

  // Intentionally unconditional — throws regardless of whether an "error" listener
  // is registered. That is the point of strictWrites; contrast with emitWriteErrors,
  // which is a no-op when there are no listeners.
  private assertWritesSucceeded(
    results: PromiseSettledResult<void>[],
    operation: CacheErrorEvent["operation"],
  ): void {
    if (!this.strictWrites || results.length === 0) return;
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length === results.length) {
      throw new AggregateError(
        failures.map((f) => f.reason as unknown),
        `All ${String(results.length)} cache layer(s) failed during ${operation}`,
      );
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
