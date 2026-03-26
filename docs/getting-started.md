# Getting Started

This guide walks you through installing Ziggurat and creating your first cache.

## Installation

Ziggurat is distributed as separate packages so you only install what you need.

### Core (required)

```bash
npm install @ziggurat/core
```

The core package includes the `CacheManager` orchestrator and the built-in `MemoryAdapter`.

### Redis Adapter (optional)

```bash
npm install @ziggurat/redis ioredis
```

`ioredis` is a peer dependency — you provide and manage your own Redis client.

### NestJS Integration (optional)

```bash
npm install @ziggurat/nestjs
```

Requires `@nestjs/common` and `@nestjs/core` >= 10.x as peer dependencies.

## Your First Cache

### 1. Create a CacheManager

Every Ziggurat setup starts with a `CacheManager` and at least one adapter (layer). Each adapter can define its own `defaultTtlMs`, and the manager can set a `namespace` to prefix all keys:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat/core";

const cache = new CacheManager({
  namespace: "users",
  layers: [new MemoryAdapter({ defaultTtlMs: 300_000 })],
});
```

### 2. Cache an Expensive Operation with `wrap`

The `wrap` method is the primary API. It checks the cache first. On a miss, it calls your factory function, stores the result, and returns it. TTL is handled by the adapter's `defaultTtlMs`:

```ts
async function getUserProfile(userId: string) {
  return cache.wrap(
    `profile:${userId}`, // stored as "users:profile:42"
    async () => {
      // This only runs on cache miss
      return await db.users.findById(userId);
    },
  );
}
```

On the first call, the factory executes and the result is cached. On subsequent calls within the TTL window, the cached value is returned instantly — no database query.

### 3. Use Direct Operations

You can also interact with the cache directly:

```ts
// Store a value
await cache.set("config:feature-flags", flags, 60_000);

// Retrieve a value
const entry = await cache.get<FeatureFlags>("config:feature-flags");
if (entry) {
  console.log(entry.value); // typed as FeatureFlags
  console.log(entry.expiresAt); // Unix timestamp or null
}

// Delete a specific key
await cache.delete("config:feature-flags");

// Clear all cached data
await cache.clear();
```

### 4. Add a Second Layer

To add distributed caching, stack a Redis adapter behind the memory layer. Each adapter defines its own TTL — memory expires fast, Redis holds data longer:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat/core";
import { RedisAdapter } from "@ziggurat/redis";
import Redis from "ioredis";

const cache = new CacheManager({
  namespace: "products",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: 30s
    new RedisAdapter({ client: new Redis(), defaultTtlMs: 600_000 }), // L2: 10min
  ],
});
```

Reads check L1 first. On an L1 miss, L2 is checked. If L2 has the value, it's returned and L1 is automatically backfilled using L1's own `defaultTtlMs` so the next read is served from memory.

## What's Next

- [Core Concepts](core-concepts.md) — Understand layers, backfill, and stampede protection
- [API Reference](api-reference.md) — Full API documentation for all packages
- [Redis Adapter](redis-adapter.md) — Redis-specific configuration and tips
- [NestJS Integration](nestjs-integration.md) — Module setup and `@Cached()` decorator
