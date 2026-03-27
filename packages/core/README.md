# @ziggurat-cache/core

Multi-layer cache orchestrator for TypeScript with built-in stampede protection and automatic backfill.

Part of the [Ziggurat](https://github.com/camcima/ziggurat) cache ecosystem.

## Installation

```bash
npm install @ziggurat-cache/core
```

## Features

- **Multi-layer caching** - Stack multiple cache layers (memory, Redis, SQLite, etc.). Reads cascade through layers; misses automatically backfill higher layers.
- **Stampede protection** - Concurrent `wrap()` calls for the same key coalesce into a single factory invocation.
- **Batch operations** - `mget`, `mset`, `mdel` for efficient multi-key operations across all layers.
- **Event system** - Built-in typed events for hit, miss, set, delete, error, backfill, and wrap operations.
- **Fully typed** - Generic `CacheEntry<T>` ensures type safety from cache to consumer.
- **Resilient** - Individual layer failures are silently skipped; a broken layer won't crash your app.

## Quick Start

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";

const cache = new CacheManager({
  namespace: "users",
  layers: [new MemoryAdapter({ defaultTtlMs: 300_000 })],
});

// wrap: fetch from cache or compute and cache
const user = await cache.wrap(`profile:${userId}`, async () =>
  db.users.findById(userId),
);
```

## Multi-Layer Example

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { RedisAdapter } from "@ziggurat-cache/redis";
import Redis from "ioredis";

const cache = new CacheManager({
  namespace: "products",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }),      // L1: 30s
    new RedisAdapter({ client: new Redis(), defaultTtlMs: 600_000 }), // L2: 10min
  ],
});

// L1 miss -> L2 hit -> value returned + L1 backfilled
const product = await cache.wrap(id, async () => api.getProduct(id));
```

## Events

```ts
cache.on("hit", (e) => console.log(`HIT ${e.key} from ${e.layerName}`));
cache.on("miss", (e) => console.log(`MISS ${e.key}`));
cache.on("backfill", (e) => console.log(`BACKFILL ${e.key} from ${e.fromLayerName}`));
cache.on("wrap:coalesce", (e) => console.log(`COALESCE ${e.key}`));
```

## API

### CacheManager

| Method | Description |
|--------|-------------|
| `get<T>(key)` | Read from cache, cascading through layers |
| `set<T>(key, value, ttlMs?)` | Write to all layers |
| `delete(key)` | Delete from all layers |
| `wrap<T>(key, factory, ttlMs?)` | Get-or-compute with stampede protection |
| `mget<T>(keys)` | Batch get across layers |
| `mset<T>(entries, ttlMs?)` | Batch set across layers |
| `mdel(keys)` | Batch delete across layers |
| `on(event, listener)` | Subscribe to cache events |
| `off(event, listener)` | Unsubscribe from cache events |

### MemoryAdapter

In-process cache using `node-cache`. Included in this package.

### BaseCacheAdapter

Abstract base class for building custom adapters. Implement `get`, `set`, `delete`, and `clear`.

## Documentation

See the [full documentation](https://github.com/camcima/ziggurat/tree/main/docs) for detailed guides on core concepts, custom adapters, and advanced usage.

## License

MIT
