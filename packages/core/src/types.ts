export interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

export interface CacheSetEntry<T> {
  key: string;
  value: T;
  ttlMs?: number;
}

export type TtlResult =
  | { kind: "missing" }
  | { kind: "permanent" }
  | { kind: "expiring"; ttlMs: number };

export interface AdapterTtlOptions {
  /**
   * Fallback TTL in milliseconds, applied when set()/mset() is called
   * without an explicit ttlMs. An explicit ttlMs always wins.
   */
  defaultTtlMs?: number;
  /**
   * Upper bound in milliseconds applied to every entry — explicit TTLs,
   * defaultTtlMs, and otherwise-permanent entries are all capped to this.
   */
  maxTtlMs?: number;
}

/**
 * An adapter's own TTL policy, exposed so CacheManager can keep backfilled
 * entries inside the target layer's policy instead of copying the source
 * layer's remaining lifetime verbatim. Adapters extending BaseCacheAdapter
 * get this for free; adapters that omit it receive the source entry's
 * remaining TTL on backfill.
 */
export type AdapterTtlPolicy = Readonly<AdapterTtlOptions>;

export interface CacheAdapter {
  readonly name: string;
  readonly ttlPolicy?: AdapterTtlPolicy;
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  getTtl(key: string): Promise<TtlResult>;
  keys(): Promise<string[]>;
  mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>>;
  mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void>;
  mdel(keys: readonly string[]): Promise<void>;
  flushAll(): Promise<void>;
}

export interface StampedeConfig {
  coalesce?: boolean;
}

// ── Cache Events ──

export interface CacheHitEvent {
  key: string;
  namespace?: string;
  layerName: string;
  layerIndex: number;
  durationMs: number;
}

export interface CacheMissEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheSetEvent {
  key: string;
  namespace?: string;
  ttlMs?: number;
  durationMs: number;
}

export interface CacheDeleteEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheErrorEvent {
  key: string;
  namespace?: string;
  operation:
    | "get"
    | "set"
    | "delete"
    | "has"
    | "getTtl"
    | "mget"
    | "mset"
    | "mdel"
    | "backfill";
  layerName: string;
  layerIndex: number;
  error: unknown;
}

export interface CacheBackfillEvent {
  key: string;
  namespace?: string;
  sourceLayerName: string;
  sourceLayerIndex: number;
  targetLayerNames: string[];
}

export interface CacheWrapHitEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheWrapMissEvent {
  key: string;
  namespace?: string;
  durationMs: number;
  factoryDurationMs: number;
}

export interface CacheWrapCoalesceEvent {
  key: string;
  namespace?: string;
}

export interface CacheMgetEvent {
  keys: string[];
  namespace?: string;
  hitCount: number;
  missCount: number;
  durationMs: number;
}

export interface CacheMsetEvent {
  keyCount: number;
  namespace?: string;
  durationMs: number;
}

export interface CacheMdelEvent {
  keyCount: number;
  namespace?: string;
  durationMs: number;
}

export type CacheEventMap = {
  hit: CacheHitEvent;
  miss: CacheMissEvent;
  set: CacheSetEvent;
  delete: CacheDeleteEvent;
  error: CacheErrorEvent;
  backfill: CacheBackfillEvent;
  "wrap:hit": CacheWrapHitEvent;
  "wrap:miss": CacheWrapMissEvent;
  "wrap:coalesce": CacheWrapCoalesceEvent;
  mget: CacheMgetEvent;
  mset: CacheMsetEvent;
  mdel: CacheMdelEvent;
};

// ── Options ──

import type { TypedEventEmitter } from "./event-emitter.js";

export interface CacheManagerOptions {
  layers: CacheAdapter[];
  namespace?: string;
  syncBackfill?: boolean;
  stampede?: StampedeConfig;
  events?: TypedEventEmitter<CacheEventMap>;
  /**
   * Controls whether wrap() waits for the computed value to be written to
   * every layer before resolving.
   *
   * "await" (default): resolve only after all layer writes settle, so a
   * read issued after wrap() resolves is guaranteed to see the value. A slow
   * layer adds its full write latency to every wrap() miss — and to every
   * caller coalesced onto it.
   *
   * "background": resolve as soon as the factory does and let the writes
   * settle in the background. Lower miss latency at the cost of a brief
   * window where the value is not yet cached. Write failures still surface
   * via "error" events.
   */
  wrapWrites?: "await" | "background";
  /**
   * When true, set/mset/delete/mdel throw an AggregateError if EVERY
   * layer fails the write. Default false (writes never throw; failures
   * are observable only via "error" events).
   *
   * In a single-layer configuration, any write failure will throw because
   * "every layer" is the one layer.
   *
   * `wrap()` is unaffected by this option — it always returns the computed
   * factory value and surfaces cache-write failures only via "error" events.
   */
  strictWrites?: boolean;
}

export interface MemoryAdapterOptions extends AdapterTtlOptions {
  /**
   * Interval in ms for proactive eviction of expired entries.
   * Default 0 (disabled): expired entries are removed only when accessed,
   * so write-heavy/read-rarely workloads can grow unboundedly.
   * Very small values create a tight eviction loop; prefer >= 1000 (1 second).
   */
  checkPeriodMs?: number;
  /**
   * Maximum number of keys; set() throws once exceeded. Default unlimited.
   * Overwriting an existing key always succeeds even at capacity — only NEW
   * keys beyond the cap cause set() to throw.
   */
  maxKeys?: number;
  /**
   * "reference" (default): store live references — fastest, but returned
   * objects can be mutated by callers (poisoning the cache) and rich types
   * (Date, Map) survive here while JSON-based layers flatten them, so
   * multi-layer reads can return different shapes per layer.
   * "json": JSON round-trip on every set/get — consistent with the Redis,
   * SQLite, and Memcache adapters and immune to caller mutation. Circular
   * references throw at `set()` time, and values JSON cannot represent at all
   * (functions, symbols) are skipped like `undefined`: nothing is stored, and
   * reads, `has()`, and `keys()` all report a miss.
   */
  serialization?: "reference" | "json";
}
