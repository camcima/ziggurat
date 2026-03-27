# Core Concepts

## Layers

Ziggurat models your cache as an ordered stack of **layers**. Each layer is a `CacheAdapter` — a storage backend implementing the full adapter interface.

```
┌─────────────────────┐
│   L1: MemoryAdapter  │  ← Fastest (in-process, ~0ms)
├─────────────────────┤
│   L2: RedisAdapter   │  ← Shared (network, ~1-5ms)
├─────────────────────┤
│   L3: Your Adapter   │  ← Any CacheAdapter implementation
└─────────────────────┘
```

Layers are passed as an ordered array to the `CacheManager`. The first layer is the fastest and most local; deeper layers are progressively slower but may be shared across processes or machines.

```ts
const cache = new CacheManager({
  layers: [l1, l2, l3], // checked in this order
});
```

## Reads: Sequential Lookup

When you call `cache.get(key)` or `cache.wrap(key, factory)`, the CacheManager queries layers **sequentially**, starting from L1:

1. Check L1. If found → return the value.
2. Check L2. If found → return the value and **backfill** L1.
3. Check L3. If found → return the value and **backfill** L1 and L2.
4. If no layer has the value → return `null` (or call the factory for `wrap`).

This means the first layer to contain the value wins. Deeper layers are only queried on a miss.

## Namespace

The `namespace` option on `CacheManager` prefixes all keys with `namespace:`. This provides logical grouping without polluting your key strings:

```ts
const userCache = new CacheManager({
  namespace: "users",
  layers: [memory, redis],
});

// cache.set("42", data) → stored as "users:42"
// cache.get("42")       → looks up "users:42"
```

Different CacheManagers with different namespaces sharing the same adapters won't collide — `users:42` and `products:42` are distinct keys.

## Backfill

When a value is found in a lower layer (e.g., L2), the CacheManager automatically **backfills** all higher layers (e.g., L1) so subsequent reads are served from the fastest layer.

If the target adapter has a `defaultTtlMs`, backfill uses that TTL. Otherwise, it falls back to the remaining TTL from the source entry. This means L1 always uses its own TTL policy, regardless of L2's expiration.

### Backfill Modes

By default, backfill is **asynchronous** — the value is returned immediately while backfill happens in the background. This minimizes response latency.

```ts
// Default: async backfill (fire-and-forget)
const cache = new CacheManager({
  layers: [l1, l2],
});
```

Set `syncBackfill: true` to wait for backfill to complete before returning. This guarantees that higher layers are populated before your code continues, which can be useful for testing or consistency-sensitive scenarios.

```ts
// Sync backfill: waits for L1 to be populated before returning
const cache = new CacheManager({
  layers: [l1, l2],
  syncBackfill: true,
});
```

## Writes: All Layers

`set` and `delete` operate on **all layers** simultaneously using `Promise.allSettled`. Cross-layer operations are **best-effort, not atomic** — there is no distributed transaction across independent backends. If one layer fails, the operation still completes on the others, which may leave layers temporarily inconsistent until the next write reconciles them.

```ts
// Writes to L1 AND L2
await cache.set("key", value, 60_000);

// Deletes from L1 AND L2
await cache.delete("key");
```

## Layer Access

The `CacheManager` orchestrates keyed operations (`get`, `set`, `delete`, `wrap`, `mget`, `mset`, `mdel`, `has`, `getTtl`) across layers. Bulk backend operations like `clear()`, `flushAll()`, and `keys()` are **adapter concerns** — they operate on a single backend with well-defined scope.

Use `getLayers()` to access adapters directly when you need these operations:

```ts
const [l1, l2] = cache.getLayers();

// Clear a specific layer
await l1.clear();

// Clear all layers explicitly (you control the scope)
for (const layer of cache.getLayers()) {
  await layer.clear();
}

// Get keys from a specific layer
const keys = await l2.keys();
```

Adapters returned by `getLayers()` do **not** apply the manager's namespace — they expose their raw API. The array is a new copy on each call; mutations to it do not affect the manager.

## Stampede Protection

### The Problem

When a popular cache key expires, many concurrent requests may all experience a cache miss at the same time. Without protection, all of them hit the underlying data source simultaneously — a **cache stampede** (also called "thundering herd" or "dogpile").

```
Request 1 → cache miss → DB query ─┐
Request 2 → cache miss → DB query ─┤
Request 3 → cache miss → DB query ─┤  All hit the DB at once!
...                                 │
Request N → cache miss → DB query ─┘
```

### The Solution: Request Coalescing

Ziggurat uses **request coalescing** (in-flight deduplication). When the first request triggers a cache miss and calls the factory function, all subsequent requests for the **same key** attach to the existing in-flight Promise instead of creating new ones.

```
Request 1 → cache miss → factory() ──→ result ──→ cache + return
Request 2 → cache miss → [coalesced] ─────────→ same result
Request 3 → cache miss → [coalesced] ─────────→ same result
...
Request N → cache miss → [coalesced] ─────────→ same result
```

The factory executes **exactly once**. All N callers get the same value.

### Configuration

Coalescing is **enabled by default**. You can disable it for debugging or specific use cases:

```ts
const cache = new CacheManager({
  layers: [new MemoryAdapter()],
  stampede: { coalesce: false },
});
```

### Error Propagation

If the factory function throws an error during coalescing, the error propagates to **all** coalesced callers. The in-flight entry is cleaned up so subsequent calls trigger a fresh factory invocation.

## TTL (Time to Live)

TTL is specified in **milliseconds**. There are two ways to configure it:

### Per-Adapter TTL (Recommended)

Set `defaultTtlMs` on each adapter. This is the recommended approach for multi-layer setups because each layer can have its own expiration policy:

```ts
const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: 30s
    new RedisAdapter({ client: redis, defaultTtlMs: 600_000 }), // L2: 10min
  ],
});

// No TTL needed in wrap — adapters handle it
await cache.wrap("key", factory);
```

### Per-Call TTL (Fallback)

You can also pass TTL directly to `set` or `wrap`. This acts as a fallback — if the adapter has `defaultTtlMs`, the adapter's TTL takes precedence.

```ts
// Only used if the adapter has no defaultTtlMs
await cache.set("key", value, 300_000);
await cache.wrap("key", factory, 300_000);
```

### TTL Resolution Order

1. Adapter's `defaultTtlMs` (if set) — always wins
2. TTL passed via `set`/`wrap` — fallback
3. No TTL — entry never expires

Internally, TTL is stored as an absolute Unix timestamp (`expiresAt`) on the `CacheEntry`. Expired entries are lazily cleaned up on the next `get` call.

## Observability

The `CacheManager` emits typed events for every operation — hits, misses, errors, backfills, stampede coalescing, and more. Events have **zero cost** when no listeners are attached.

### Subscribing to Events

```ts
const cache = new CacheManager({
  layers: [memory, redis],
});

// Log cache misses
cache.on("miss", (e) => {
  console.log(`Miss: ${e.key} (${e.durationMs.toFixed(1)}ms)`);
});

// Track errors per layer
cache.on("error", (e) => {
  console.error(`Layer ${e.layerName} failed on ${e.operation}:`, e.error);
});

// Monitor backfill activity
cache.on("backfill", (e) => {
  console.log(`Backfill: ${e.key} from ${e.sourceLayerName} → ${e.targetLayerNames.join(", ")}`);
});
```

The `on()` method returns an unsubscribe function:

```ts
const unsub = cache.on("hit", listener);
// ...later
unsub(); // stop listening
```

### OpenTelemetry Integration

The `@ziggurat-cache/otel` package translates cache events into OTel counters and histograms. It only depends on `@opentelemetry/api` (the lightweight API, not the SDK) — your application provides the SDK and exporter.

```ts
import { instrumentCacheManager } from "@ziggurat-cache/otel";

const cleanup = instrumentCacheManager(cache);
// Metrics are now flowing to your OTel backend
```

See the [API Reference](api-reference.md#zigguratolel) for the full list of recorded metrics.

## Error Handling

Ziggurat is designed to be resilient. Cross-layer operations are best-effort, not atomic — there is no distributed transaction across independent backends. Individual layer failures never crash the overall operation:

- **`get`**: If a layer throws during a read, it is skipped and the next layer is queried.
- **`set` / `delete`**: Operations use `Promise.allSettled`, so failures on one layer don't prevent success on others. This can leave layers temporarily inconsistent until the next write reconciles them.
- **Backfill failures**: If backfilling a higher layer fails after a lower-layer hit, the value is still returned to the caller.

This means a transient Redis connection error won't prevent your application from serving data from memory — or vice versa.
