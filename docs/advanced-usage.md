# Advanced Usage

## Multi-Layer Patterns

### Two-Layer (Memory + Redis)

The most common production pattern. Memory serves hot data with sub-millisecond latency; Redis provides shared persistence across instances. Each layer manages its own TTL:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat/core";
import { RedisAdapter } from "@ziggurat/redis";
import Redis from "ioredis";

const userCache = new CacheManager({
  namespace: "users",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: 30s
    new RedisAdapter({
      client: new Redis(process.env.REDIS_URL),
      prefix: "myapp:",
      defaultTtlMs: 300_000, // L2: 5min
    }),
  ],
});
```

**How it works**:

- `wrap("42", factory)` → checks memory for `users:42` → checks Redis → calls factory
- On a Redis hit, memory is auto-backfilled with memory's own 30s TTL
- On a factory call, memory gets 30s TTL, Redis gets 5min TTL

### Three-Layer (Memory + Redis + Fallback)

For high-availability setups, you can add a third layer as a final fallback:

```ts
const cache = new CacheManager({
  namespace: "products",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 15_000 }), // L1: 15s
    new RedisAdapter({
      client: primaryRedis,
      prefix: "app:",
      defaultTtlMs: 300_000,
    }), // L2: 5min
    new RedisAdapter({
      client: fallbackRedis,
      prefix: "app:",
      defaultTtlMs: 3600_000,
    }), // L3: 1hr
  ],
});
```

## Understanding syncBackfill

When a cache miss in L1 hits in a lower layer, Ziggurat automatically copies ("backfills") the value to higher layers. The `syncBackfill` option controls whether the calling code waits for that backfill to complete.

### Async Backfill (Default)

With `syncBackfill: false` (the default), the value is returned immediately while higher layers are populated in the background via a fire-and-forget promise.

```ts
const cache = new CacheManager({
  layers: [memory, redis],
  // syncBackfill: false — this is the default
});
```

**Trade-off**: A second request arriving before backfill completes will hit L2 again. In practice, this is rare because in-process memory backfill completes in microseconds.

**Best for**: Most production workloads where latency matters more than absolute consistency between layers. Examples:

- Web API endpoints serving user data: the response shouldn't wait for memory backfill when the value was already found in Redis
- High-throughput pipelines where every millisecond counts: the duplicate L2 hit on a rare race is cheaper than always waiting

### Sync Backfill

With `syncBackfill: true`, the `get()` and `mget()` calls await backfill completion before returning. This guarantees that after the call, all higher layers contain the value.

```ts
const cache = new CacheManager({
  layers: [memory, redis],
  syncBackfill: true,
});

// After this line, `memory` is guaranteed to have the value
const entry = await cache.get("key");
```

**Best for** scenarios where layer consistency is critical:

1. **Test suites** — Deterministic behavior makes assertions reliable. Without sync backfill, tests that check L1 state after a get() may see stale results depending on timing.

2. **Read-then-act workflows** — When subsequent logic depends on the value being in L1. For example, a batch job that loads a configuration from Redis and then issues thousands of lookups against it:

```ts
const configCache = new CacheManager({
  layers: [memory, redis],
  syncBackfill: true, // ensure config is in memory before the hot loop
});

const config = await configCache.get("batch-config");
// Memory is guaranteed warm — the next 10,000 get() calls hit L1
for (const item of items) {
  const cfg = await configCache.get("batch-config"); // always L1
  process(item, cfg);
}
```

### Choosing the Right Mode

| Scenario                 | Recommended       | Why                                        |
| ------------------------ | ----------------- | ------------------------------------------ |
| Web API endpoints        | `async` (default) | Lower latency; rare race is acceptable     |
| Background workers       | `async` (default) | Throughput > consistency                   |
| Test suites              | `sync`            | Deterministic assertions                   |
| Read-then-act hot loops  | `sync`            | Avoid repeated L2 hits                     |
| Cache warming on startup | `sync`            | Ensure layers are populated before serving |

## Stampede Protection Patterns

### Default: Coalescing Enabled

With coalescing enabled (the default), concurrent callers share a single factory invocation:

```ts
// 100 concurrent requests, 1 database query
const results = await Promise.all(
  userIds.map((id) =>
    cache.wrap(`user:${id}`, () => db.users.findById(id), 300_000),
  ),
);
```

Note: Coalescing is **per-key**. Different keys run their factories independently in parallel. Only concurrent misses for the **same key** are coalesced.

### Disabling Coalescing

Disable coalescing when you need each caller to get a fresh factory invocation, such as when debugging or testing concurrent behavior:

```ts
const cache = new CacheManager({
  layers: [new MemoryAdapter()],
  stampede: { coalesce: false },
});
```

### Error Handling Under Coalescing

When a factory throws with coalescing enabled, the error propagates to all coalesced callers:

```ts
const results = await Promise.allSettled(
  Array.from({ length: 10 }, () =>
    cache.wrap("key", async () => {
      throw new Error("DB is down");
    }),
  ),
);

// All 10 promises are rejected with the same error
// The in-flight entry is cleaned up — next call retries the factory
```

## Cache Key Design

### Hierarchical Keys

Use colons to create a hierarchy. This makes keys readable and allows pattern-based operations at the Redis level:

```ts
`user:${userId}:profile``user:${userId}:preferences``product:${productId}:details``product:${productId}:reviews:page:${page}`;
```

### Versioned Keys

When your data schema changes, version your cache keys to avoid deserializing stale data:

```ts
const CACHE_VERSION = "v2";

await cache.wrap(
  `${CACHE_VERSION}:user:${id}`,
  () => db.users.findById(id),
  300_000,
);
```

### Dynamic TTL

Vary TTL based on the data characteristics:

```ts
async function getProduct(id: string) {
  const ttl = isHighDemandProduct(id) ? 60_000 : 600_000;
  return cache.wrap(`product:${id}`, () => fetchProduct(id), ttl);
}
```

## Error Resilience

### Layer Failure Recovery

Ziggurat handles layer failures gracefully. If Redis goes down, memory still serves cached data and new misses go straight to the factory:

```
Normal:   get(L1) → miss → get(L2) → miss → factory → set(L1, L2)
Redis down: get(L1) → miss → get(L2) → ERROR → skip → factory → set(L1, L2*)

* L2 set silently fails via Promise.allSettled
```

When Redis recovers, new factory results are written to both layers again. There's no manual intervention needed.

### Graceful Degradation Pattern

For critical paths, you can wrap the entire cache call in a try-catch and fall back to a direct fetch:

```ts
async function getUserProfile(id: string) {
  try {
    return await cache.wrap(`user:${id}`, () => db.users.findById(id), 300_000);
  } catch (error) {
    // Factory itself failed (not a cache issue)
    logger.error("Failed to fetch user profile", { id, error });
    throw error;
  }
}
```

## Memory Management

### TTL-Based Expiration

The `MemoryAdapter` uses TTL-based expiration via `node-cache`. Set `defaultTtlMs` on the adapter to automatically expire entries:

```ts
new MemoryAdapter({ defaultTtlMs: 30_000 }); // entries expire after 30 seconds
```

Without `defaultTtlMs`, entries never expire unless a TTL is passed via `set`/`wrap`. For production workloads with unbounded key spaces, always set a `defaultTtlMs` to prevent memory growth:

```ts
// OK: finite set of config keys
const configCache = new MemoryAdapter();

// Better: unbounded user IDs with TTL-based cleanup
const userCache = new MemoryAdapter({ defaultTtlMs: 60_000 });
```

## Performance Tips

### Layer Order Matters

Place the fastest layer first. Each layer is queried sequentially — if L1 has the value, L2 is never consulted:

```ts
// Correct: fast → slow
layers: [new MemoryAdapter(), new RedisAdapter({ client: redis })];

// Wrong: slow → fast (Redis is always checked first)
layers: [new RedisAdapter({ client: redis }), new MemoryAdapter()];
```

### Avoid Over-Caching

Not everything benefits from caching. Consider:

- **Cache**: Expensive queries, external API calls, computed aggregations
- **Don't cache**: Fast lookups, writes, data that changes on every request

### TTL Strategy

| Data Type        | Suggested TTL | Rationale                        |
| ---------------- | ------------- | -------------------------------- |
| User profiles    | 5-15 minutes  | Changes infrequently             |
| Product listings | 1-10 minutes  | Moderate change rate             |
| Search results   | 30-60 seconds | Changes often, short-lived value |
| Configuration    | 5-30 minutes  | Rarely changes                   |
| Real-time data   | Don't cache   | Stale data is harmful            |

## Functional Testing

Ziggurat includes functional tests that run against real cache backends. These are separated from the default hermetic test suite and require explicit invocation.

### Running Default (Hermetic) Tests

```bash
# No external services needed
pnpm test
```

All unit, contract, and integration tests pass without Redis or any other backend running.

### Running Functional Tests Against Local Backends

```bash
# Redis
export REDIS_URL=redis://localhost:6379
pnpm test:functional:redis

# Memcached
export MEMCACHE_URL=localhost:11211
pnpm test:functional:memcache

# SQLite (no external service needed)
pnpm test:functional:sqlite
```

### Using Docker Compose

If you don't have backends installed locally, start them via Docker Compose:

```bash
# Start Redis
docker compose --profile redis up -d

# Start Memcached
docker compose --profile memcached up -d

# Configure environment — copy .env.example then run tests
# (vitest functional configs auto-load .env from repo root)
cp .env.example .env

# Run functional tests
pnpm test:functional:redis
pnpm test:functional:memcache
pnpm test:functional:sqlite

# Stop backends when done
docker compose --profile redis --profile memcached down
```

### Running All Functional Suites

```bash
pnpm test:functional
```

This runs functional tests for all configured backends (Redis, Memcached, SQLite).

### CI Workflow

Functional tests run automatically in GitHub Actions via `.github/workflows/functional-tests.yml`. Each backend is provisioned as a service container and tested in a separate matrix job, reporting results independently from the hermetic test suite.

### Adding a New Backend

To add functional tests for a new adapter (e.g., Postgres):

1. Create test files under `packages/<adapter>/tests/functional/`
2. Add `vitest.functional.config.ts` in the adapter package
3. Add `test:functional` script to the adapter's `package.json`
4. Add a profile to `docker-compose.yml`
5. Add the env var (e.g., `POSTGRES_URL`) to `.env.example`
6. Add a matrix entry in `.github/workflows/functional-tests.yml`
7. Add `test:functional:<adapter>` to the root `package.json`
