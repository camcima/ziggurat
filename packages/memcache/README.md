# @ziggurat-cache/memcache

Memcached adapter for the [Ziggurat](https://github.com/camcima/ziggurat) multi-layer cache.

## Installation

```bash
npm install @ziggurat-cache/core @ziggurat-cache/memcache memjs
```

## Usage

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { MemcacheAdapter } from "@ziggurat-cache/memcache";
import memjs from "memjs";

const memcached = memjs.Client.create("localhost:11211");

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }),       // L1: fast, in-process
    new MemcacheAdapter({                                // L2: shared
      client: memcached,
      defaultTtlMs: 600_000,
    }),
  ],
});

const user = await cache.wrap(`user:${id}`, async () =>
  db.users.findById(id),
);
```

## Options

```ts
interface MemcacheAdapterOptions {
  client: memjs.Client;     // memjs client instance
  defaultTtlMs?: number;    // Default TTL in milliseconds
  prefix?: string;           // Key prefix (default: none)
}
```

## Requirements

- `memjs` >= 1.3.0 (peer dependency)

## Documentation

See the [Memcache Adapter guide](https://github.com/camcima/ziggurat/blob/main/docs/memcache-adapter.md) for configuration and limitations.

## License

MIT
