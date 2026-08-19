# @ziggurat-cache/redis

Redis adapter for the [Ziggurat](https://github.com/camcima/ziggurat) multi-layer cache.

## Installation

```bash
npm install @ziggurat-cache/core @ziggurat-cache/redis ioredis
```

## Usage

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { RedisAdapter } from "@ziggurat-cache/redis";
import Redis from "ioredis";

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: fast, in-process
    new RedisAdapter({
      // L2: shared, persistent
      client: new Redis(),
      defaultTtlMs: 600_000,
    }),
  ],
});

const user = await cache.wrap(`user:${id}`, async () => db.users.findById(id));
```

## Options

```ts
interface RedisAdapterOptions {
  client: Redis; // ioredis client instance
  defaultTtlMs?: number; // Fallback TTL when a call passes none
  maxTtlMs?: number; // Upper bound applied to every entry
  prefix?: string; // Key prefix (default: none)
  allowUnprefixedClear?: boolean; // Permit clear()/flushAll() with no prefix
}
```

## Requirements

- `ioredis` >= 5.0.0 (peer dependency)

## Documentation

See the [Redis Adapter guide](https://github.com/camcima/ziggurat/blob/main/docs/redis-adapter.md) for configuration details, serialization, and production tips.

## License

MIT
