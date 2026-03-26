# Redis Adapter

The `@ziggurat/redis` package provides a `RedisAdapter` that uses [ioredis](https://github.com/redis/ioredis) to store cached values in Redis. It's designed as a shared L2 (or deeper) layer in a multi-layer cache stack.

## Installation

```bash
npm install @ziggurat/redis ioredis
```

`ioredis` is a peer dependency — you bring your own client and manage the connection lifecycle.

## Basic Setup

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat/core";
import { RedisAdapter } from "@ziggurat/redis";
import Redis from "ioredis";

const redis = new Redis("redis://localhost:6379");

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }),
    new RedisAdapter({ client: redis, defaultTtlMs: 600_000 }),
  ],
});
```

## Configuration

### `RedisAdapterOptions`

| Property       | Type     | Default      | Description                                                                     |
| -------------- | -------- | ------------ | ------------------------------------------------------------------------------- |
| `client`       | `Redis`  | _(required)_ | A configured ioredis client instance.                                           |
| `prefix`       | `string` | `""`         | String prepended to all keys for infrastructure-level isolation.                |
| `defaultTtlMs` | `number` | _none_       | Default TTL in milliseconds. Takes precedence over TTL passed via `set`/`wrap`. |

### Key Prefixing

Use the `prefix` option to namespace keys and avoid collisions when sharing a Redis instance:

```ts
const userCache = new RedisAdapter({
  client: redis,
  prefix: "myapp:users:",
});

const productCache = new RedisAdapter({
  client: redis,
  prefix: "myapp:products:",
});
```

When you call `userCache.set("42", userData)`, the actual Redis key is `myapp:users:42`.

The `clear()` method only deletes keys matching the adapter's prefix, so different prefixes are fully isolated.

## How Data is Stored

Values are stored as JSON strings in Redis. Each entry is a serialized `CacheEntry`:

```json
{
  "value": { "id": 42, "name": "Alice" },
  "expiresAt": 1711382400000
}
```

### TTL Handling

- **With TTL**: The adapter uses Redis `PSETEX` (set with millisecond precision expiry). Redis handles expiration natively, and the `expiresAt` timestamp is stored in the JSON for backfill TTL calculations.
- **Without TTL**: The adapter uses `SET` with no expiry. The `expiresAt` field is `null`.

Both Redis-native TTL and the `expiresAt` check in `get` are enforced. If a key somehow survives past its `expiresAt` (e.g., clock drift), the adapter catches it on read and deletes the stale entry.

## Sharing a Redis Client

You can share a single ioredis client across multiple `RedisAdapter` instances. Use different prefixes to isolate key spaces:

```ts
const redis = new Redis();

const cache = new CacheManager({
  layers: [
    new MemoryAdapter(),
    new RedisAdapter({ client: redis, prefix: "cache:" }),
  ],
});

const sessionStore = new RedisAdapter({
  client: redis,
  prefix: "sessions:",
});
```

## Connection Management

The `RedisAdapter` does not manage the Redis connection. You are responsible for creating and closing the client:

```ts
const redis = new Redis("redis://localhost:6379");

// ... use the cache ...

// When shutting down:
await redis.quit();
```

For applications with graceful shutdown:

```ts
process.on("SIGTERM", async () => {
  await redis.quit();
  process.exit(0);
});
```

## Redis Cluster and Sentinel

Since you provide your own ioredis client, you can use any ioredis-supported topology:

```ts
// Cluster
import Redis from "ioredis";

const cluster = new Redis.Cluster([
  { host: "node1", port: 6379 },
  { host: "node2", port: 6379 },
]);

const adapter = new RedisAdapter({ client: cluster as any, prefix: "app:" });
```

```ts
// Sentinel
const redis = new Redis({
  sentinels: [
    { host: "sentinel1", port: 26379 },
    { host: "sentinel2", port: 26379 },
  ],
  name: "mymaster",
});

const adapter = new RedisAdapter({ client: redis, prefix: "app:" });
```

## Serialization

The adapter uses `JSON.stringify` / `JSON.parse` for serialization. This means:

**Supported types**: strings, numbers, booleans, `null`, plain objects, and arrays (including nested).

**Not supported**: `Date` objects (serialized as ISO strings), `Map`, `Set`, `BigInt`, functions, `undefined`, circular references, class instances with methods.

If you need to cache non-JSON-serializable values, serialize them before passing to the cache:

```ts
await cache.set("dates", {
  createdAt: date.toISOString(),
  updatedAt: date.toISOString(),
});
```

## Production Tips

### Use a Prefix

Always set a `prefix` in production. This prevents key collisions with other applications or cache instances sharing the same Redis and makes `clear()` safe to call.

### Handle Redis Failures Gracefully

Ziggurat's CacheManager automatically skips failing layers. If Redis is down, your memory layer (L1) still serves requests. When Redis comes back, new misses naturally repopulate it.

### Monitor Key Count

The `clear()` method uses `KEYS` to find matching prefixed keys. In production Redis instances with millions of keys, prefer periodic TTL-based expiration over calling `clear()`.
