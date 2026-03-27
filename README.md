<div align="center">

<picture>
  <img alt="ziggurat" src="assets/logo.svg" width="520">
</picture>

<br>

[![Test](https://github.com/camcima/ziggurat/actions/workflows/test.yml/badge.svg)](https://github.com/camcima/ziggurat/actions/workflows/test.yml)
[![Functional Tests](https://github.com/camcima/ziggurat/actions/workflows/functional-tests.yml/badge.svg)](https://github.com/camcima/ziggurat/actions/workflows/functional-tests.yml)
[![codecov](https://codecov.io/gh/camcima/ziggurat/graph/badge.svg)](https://codecov.io/gh/camcima/ziggurat)
[![npm version](https://img.shields.io/npm/v/@ziggurat-cache/core)](https://www.npmjs.com/package/@ziggurat-cache/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%20%7C%2020%20%7C%2022-green.svg)](https://nodejs.org/)

</div>

A modern, multi-layered caching library for TypeScript with built-in stampede protection and a modular adapter ecosystem.

## Features

- **Multi-layer caching** — Stack fast local caches (memory) with shared distributed caches (Redis). Reads cascade through layers; cache misses automatically backfill higher layers.
- **Stampede protection** — Concurrent cache misses for the same key coalesce into a single factory call. 100 simultaneous requests = 1 database query.
- **Modular adapters** — Bring your own storage backend. Ships with in-memory, Redis, Memcached, and SQLite adapters. Implement the `CacheAdapter` interface to add more.
- **Batch operations** — `mget`, `mset`, `mdel` for efficient multi-key operations with multi-layer orchestration and automatic backfill.
- **NestJS integration** — First-class `@Cached()` decorator and `ZigguratModule` for dependency injection. Zero boilerplate caching on any service method.
- **Fully typed** — Generic `CacheEntry<T>` ensures type safety from cache to consumer. No `any` casts needed.
- **Observable** — Built-in event system for hit/miss rates, per-layer latency, backfill, and stampede coalescing. Optional `@ziggurat-cache/otel` package for OpenTelemetry integration.
- **Resilient** — Individual layer failures are silently skipped. A Redis outage won't take down your application.

## Packages

| Package                                   | Description                                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| [`@ziggurat-cache/core`](packages/core)         | CacheManager, MemoryAdapter, BaseCacheAdapter, and all core types  |
| [`@ziggurat-cache/redis`](packages/redis)       | Redis adapter using `ioredis`                                      |
| [`@ziggurat-cache/memcache`](packages/memcache) | Memcached adapter using `memjs`                                    |
| [`@ziggurat-cache/sqlite`](packages/sqlite)     | SQLite adapter using `better-sqlite3` for persistent local caching |
| [`@ziggurat-cache/nestjs`](packages/nestjs)     | NestJS module and `@Cached()` decorator                            |
| [`@ziggurat-cache/otel`](packages/otel)         | OpenTelemetry instrumentation (counters, histograms)               |

## Quick Start

### Installation

```bash
# Core package (includes MemoryAdapter)
npm install @ziggurat-cache/core

# Optional: Redis adapter
npm install @ziggurat-cache/redis ioredis

# Optional: Memcached adapter
npm install @ziggurat-cache/memcache memjs

# Optional: SQLite adapter (persistent local cache)
npm install @ziggurat-cache/sqlite better-sqlite3

# Optional: NestJS integration
npm install @ziggurat-cache/nestjs

# Optional: OpenTelemetry instrumentation
npm install @ziggurat-cache/otel @opentelemetry/api
```

### Basic Usage

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";

const cache = new CacheManager({
  namespace: "users",
  layers: [new MemoryAdapter({ defaultTtlMs: 300_000 })],
});

// wrap: fetch from cache or compute and cache
// Key is stored as "users:profile:42"
const user = await cache.wrap(`profile:${userId}`, async () =>
  db.users.findById(userId),
);
```

### Multi-Layer Caching

Each adapter manages its own TTL — memory expires fast, Redis holds data longer:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { RedisAdapter } from "@ziggurat-cache/redis";
import Redis from "ioredis";

const cache = new CacheManager({
  namespace: "products",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: 30s TTL
    new RedisAdapter({ client: new Redis(), defaultTtlMs: 600_000 }), // L2: 10min TTL
  ],
});

// L1 miss → L2 hit → value returned + L1 backfilled with L1's own TTL
const product = await cache.wrap(id, async () => api.getProduct(id));
```

### NestJS

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { ZigguratModule } from "@ziggurat-cache/nestjs";
import { MemoryAdapter } from "@ziggurat-cache/core";

@Module({
  imports: [
    ZigguratModule.forRoot({
      layers: [new MemoryAdapter()],
    }),
  ],
})
export class AppModule {}

// user.service.ts
import { Injectable } from "@nestjs/common";
import { Cached } from "@ziggurat-cache/nestjs";

@Injectable()
export class UserService {
  @Cached({
    key: (id: string) => `user:profile:${id}`,
    ttlMs: 300_000,
  })
  async getUserProfile(id: string) {
    return this.db.users.findById(id);
  }
}
```

## Documentation

See the [docs](docs/) directory for detailed guides:

- [Getting Started](docs/getting-started.md) — Installation, first cache, and core concepts
- [Core Concepts](docs/core-concepts.md) — Layers, backfill, stampede protection explained
- [API Reference](docs/api-reference.md) — Complete API for all packages
- [Custom Adapters](docs/custom-adapters.md) — How to build your own `CacheAdapter`
- [Redis Adapter](docs/redis-adapter.md) — Configuration, serialization, and production tips
- [Memcache Adapter](docs/memcache-adapter.md) — Memcached configuration and limitations
- [SQLite Adapter](docs/sqlite-adapter.md) — Persistent local caching with SQLite
- [NestJS Integration](docs/nestjs-integration.md) — Module setup, decorators, and async configuration
- [Advanced Usage](docs/advanced-usage.md) — Error handling, performance tuning, observability, and patterns

## Requirements

- Node.js >= 18
- TypeScript >= 5.x (recommended)

## Development

```bash
# Clone and install
git clone https://github.com/camcima/ziggurat.git
cd ziggurat
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm format:check
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests for your changes
4. Ensure `pnpm test && pnpm lint` passes
5. Submit a pull request

## GitHub Topics

If you maintain a fork or related repository, consider adding these topics for discoverability:

`cache`, `caching`, `multi-layer-cache`, `stampede-protection`, `dogpile-prevention`, `typescript`, `nodejs`, `redis`, `memcached`, `sqlite`

## License

MIT
